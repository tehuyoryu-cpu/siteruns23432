'use strict';

/**
 * crawler/detailFetcher.js
 *
 * 改良点:
 *   A. consecutive_errors 追跡: 連続失敗でintervalを延長、成功でリセット
 *   B. バッチフォールバック: 50件失敗→10件→1件 で壊れたRJを分離
 *   C. discovery価格を取り込み: 外部から初期価格を受け取って保存
 *   D. フィールド解釈はparser.jsに集約
 */

const config = require('../config');
const db     = require('./db');
const parser = require('./parser');
const log    = require('./logger');
const { fetchWithRetry, sleep } = require('./queue');

const BASE       = config.dlsite.baseUrl;
const BATCH_SIZE = config.fetch.batchSize ?? 50;

// ─── public ──────────────────────────────────────────────────────────────────

async function runDetailFetch(limit = 300) {
  const due = db.getDueWorks(limit);
  if (!due.length) {
    log.info('[detailFetcher] no due works');
    return { processed: 0, priceChanges: 0, errors: 0 };
  }

  log.info('[detailFetcher] due:', due.length,
    '/ batches:', Math.ceil(due.length / BATCH_SIZE));

  const bySite = _groupBy(due, w => w.site_id ?? 'maniax');
  const result = { processed: 0, priceChanges: 0, errors: 0 };

  for (const [siteId, works] of Object.entries(bySite)) {
    for (let i = 0; i < works.length; i += BATCH_SIZE) {
      const batch = works.slice(i, i + BATCH_SIZE);
      const r     = await _fetchBatchWithFallback(batch, siteId);
      result.processed    += r.processed;
      result.priceChanges += r.priceChanges;
      result.errors       += r.errors;
      if (i + BATCH_SIZE < works.length) await sleep(config.fetch.rateLimit);
    }
  }

  log.info('[detailFetcher] done', result);
  return result;
}

// C: discovery が取得した価格を直接保存するエントリポイント
function saveDiscoveredPrice(rjCode, priceData) {
  return db.savePriceIfChanged(rjCode, priceData);
}

// ─── B: バッチフォールバック ─────────────────────────────────────────────────
// 50件失敗 → 10件ずつ再試行 → 10件失敗 → 1件ずつ再試行

async function _fetchBatchWithFallback(works, siteId) {
  const result = { processed: 0, priceChanges: 0, errors: 0 };
  const body   = await _apiBatch(works, siteId);

  if (body !== null) {
    // 成功: バッチ全体をトランザクションで処理
    db.transaction(() => {
      for (const work of works) {
        try {
          if (_processOne(work.rj_code, body)) result.priceChanges++;
          result.processed++;
        } catch (err) {
          log.error('[detailFetcher] process error', work.rj_code, err.message);
          db.recordFetchError(work.rj_code);  // A
          result.errors++;
        }
      }
    });
    return result;
  }

  // バッチ失敗 → 10件ずつ再試行
  log.warn('[detailFetcher] batch failed, splitting to size-10', `(${works.length} works)`);
  const SUB = 10;
  for (let i = 0; i < works.length; i += SUB) {
    const sub  = works.slice(i, i + SUB);
    const body2 = await _apiBatch(sub, siteId);

    if (body2 !== null) {
      db.transaction(() => {
        for (const w of sub) {
          try {
            if (_processOne(w.rj_code, body2)) result.priceChanges++;
            result.processed++;
          } catch (err) {
            db.recordFetchError(w.rj_code);  // A
            result.errors++;
          }
        }
      });
      continue;
    }

    // 10件も失敗 → 1件ずつ
    log.warn('[detailFetcher] sub-batch failed, going individual', `(${sub.length} works)`);
    for (const w of sub) {
      await sleep(config.fetch.rateLimit);
      const body3 = await _apiBatch([w], siteId);
      if (body3 !== null) {
        db.transaction(() => {
          try {
            if (_processOne(w.rj_code, body3)) result.priceChanges++;
            result.processed++;
          } catch (err) {
            db.recordFetchError(w.rj_code);  // A
            result.errors++;
          }
        });
      } else {
        // 個別でも失敗: A エラーカウント
        db.recordFetchError(w.rj_code);
        result.errors++;
        log.warn('[detailFetcher] individual fail', w.rj_code);
      }
    }
    if (i + SUB < works.length) await sleep(config.fetch.rateLimit);
  }

  return result;
}

// ─── API fetch ───────────────────────────────────────────────────────────────

/** 1〜50件をAPIから取得。失敗時は null を返す（例外を投げない）。 */
async function _apiBatch(works, siteId) {
  const params = works.map(w => `product_id=${w.rj_code}`).join('&');
  const url    = `${BASE}/${siteId}/product/info/ajax?${params}&cdn_cache_min=1`;

  try {
    const res = await fetchWithRetry(url, {
      headers: { Accept: 'application/json, text/javascript, */*' },
    });
    if (!res.ok) {
      log.warn('[detailFetcher] API non-200', res.status, siteId, `(${works.length} works)`);
      return null;
    }
    return await res.json();
  } catch (err) {
    log.error('[detailFetcher] API fetch error', err.message, `(${works.length} works)`);
    return null;
  }
}

// ─── 1件処理 ─────────────────────────────────────────────────────────────────

function _processOne(rjCode, body) {
  const parsed = parser.parseProductInfo(rjCode, body);
  if (!parsed) {
    log.warn('[detailFetcher] parse failed', rjCode);
    db.recordFetchError(rjCode);  // A: パース失敗もエラー扱い
    return false;
  }

  const { work, price } = parsed;
  db.upsertWork(work);

  if (work.maker_id && work.circle) {
    db.upsertCircle(work.maker_id, work.circle);
    _propagateCircleSale(rjCode, work.maker_id, price);
  }

  const priceChanged = db.savePriceIfChanged(rjCode, price);

  const existing      = db.getWorkByRj(rjCode);
  const noChangeCount = priceChanged ? 0 : (existing?.consecutive_no_change ?? 0) + 1;
  const { interval, priority } = _calcSchedule(work, price, noChangeCount);

  db.markChecked(rjCode, {
    check_interval:        interval,
    priority:              priority,
    is_on_sale:            price.is_on_sale,
    consecutive_no_change: noChangeCount,
    consecutive_errors:    0,  // A: 成功でリセット
  });

  if (priceChanged) {
    log.info('[detailFetcher] price changed', {
      rj: rjCode, price: price.price, sale: price.sale_price, disc: price.discount_rate,
    });
  }

  return priceChanged;
}

// ─── サークルセール伝播 ──────────────────────────────────────────────────────

function _propagateCircleSale(rjCode, makerId, price) {
  const circle      = db.getCircle(makerId);
  if (!circle) return;
  const isNowOnSale = price.is_on_sale === 1;
  const wasOnSale   = circle.on_sale === 1;

  if (isNowOnSale && !wasOnSale) {
    log.info('[detailFetcher] circle sale start', makerId);
    db.markCircleOnSale(makerId, true);
    db.boostCircleWorks(makerId, config.priority.circleOnSale, config.checkInterval.onSale);
  } else if (!isNowOnSale && wasOnSale) {
    log.info('[detailFetcher] circle sale end', makerId);
    db.markCircleOnSale(makerId, false);
    db.resetCircleWorksPriority(makerId, config.priority.normal, config.checkInterval.normal);
  }
}

// ─── 単体fetch (--rjオプション用) ────────────────────────────────────────────

async function fetchAndStore(rjCode, siteId = 'maniax') {
  const body = await _apiBatch([{ rj_code: rjCode }], siteId);
  if (!body) {
    db.recordFetchError(rjCode);  // A
    return false;
  }
  let changed = false;
  db.transaction(() => { changed = _processOne(rjCode, body); });
  return changed;
}

// ─── スケジュール計算 ─────────────────────────────────────────────────────────

function _calcSchedule(work, price, noChangeCount) {
  const ci = config.checkInterval, prio = config.priority;
  if (price.is_on_sale)    return { interval: ci.onSale,     priority: prio.onSale };
  if (noChangeCount >= 5)  return { interval: ci.cold,       priority: prio.cold };
  if (work.release_date) {
    const days = _ageDays(work.release_date);
    if (days < 7)  return { interval: ci.newWork,    priority: prio.newWork };
    if (days < 30) return { interval: ci.recentWork, priority: prio.recentWork };
  }
  if ((work.dl_count ?? 0) >= 1000) return { interval: ci.popular, priority: prio.popular };
  return { interval: ci.normal, priority: prio.normal };
}

function _ageDays(d) {
  try { return Math.floor((Date.now() - new Date(d).getTime()) / 86400000); }
  catch { return 9999; }
}

function _groupBy(arr, fn) {
  return arr.reduce((acc, x) => { const k = fn(x); (acc[k] ??= []).push(x); return acc; }, {});
}

module.exports = { runDetailFetch, fetchAndStore, saveDiscoveredPrice };
