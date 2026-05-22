'use strict';

/**
 * crawler/detailFetcher.js
 * 価格詳細取得。
 *
 * 効率化ポイント:
 *   - product/info/ajax に最大50件のRJを1リクエストで投げる (バッチ取得)
 *   - サイト別にバッチを分割 (maniax / home)
 *   - 同一価格は保存しない (差分のみ)
 *   - サークルセール検知: 1作品がセール→同サークル全作品を優先チェック
 */

const config = require('../config');
const db     = require('./db');
const parser = require('./parser');
const log    = require('./logger');
const { fetchWithRetry, sleep } = require('./queue');

const BASE       = config.dlsite.baseUrl;
const BATCH_SIZE = config.fetch.batchSize ?? 50;

// ─── public: バッチ処理エントリ ──────────────────────────────────────────────

/**
 * DBのdue worksをバッチで処理する。
 * 1リクエストで最大BATCH_SIZE件取得 → 従来比 ~50倍効率。
 */
async function runDetailFetch(limit = 300) {
  const due = db.getDueWorks(limit);
  if (!due.length) { log.info('[detailFetcher] no due works'); return { processed:0, priceChanges:0, errors:0 }; }

  log.info('[detailFetcher] due works', due.length, '→ batches', Math.ceil(due.length / BATCH_SIZE));

  // サイト別に分けてからバッチ処理
  const bySite = _groupBy(due, w => w.site_id ?? 'maniax');
  const result = { processed: 0, priceChanges: 0, errors: 0 };

  for (const [siteId, works] of Object.entries(bySite)) {
    for (let i = 0; i < works.length; i += BATCH_SIZE) {
      const batch = works.slice(i, i + BATCH_SIZE);
      const r     = await _fetchBatch(batch, siteId);
      result.processed    += r.processed;
      result.priceChanges += r.priceChanges;
      result.errors       += r.errors;

      if (i + BATCH_SIZE < works.length) await sleep(config.fetch.rateLimit);
    }
  }

  log.info('[detailFetcher] done', result);
  return result;
}

// ─── バッチ fetch ────────────────────────────────────────────────────────────

async function _fetchBatch(works, siteId) {
  const result = { processed: 0, priceChanges: 0, errors: 0 };

  // 最大50件を1URLに詰める
  const params = works.map(w => `product_id=${w.rj_code}`).join('&');
  const url    = `${BASE}/${siteId}/product/info/ajax?${params}&cdn_cache_min=1`;

  let body;
  try {
    const res = await fetchWithRetry(url, {
      headers: { Accept: 'application/json, text/javascript, */*' },
    });

    if (!res.ok) {
      log.warn('[detailFetcher] batch non-200', res.status, `(${works.length} works)`);
      works.forEach(w => _markCheckedNoChange(w.rj_code));
      result.errors += works.length;
      return result;
    }

    body = await res.json();
  } catch (err) {
    log.error('[detailFetcher] batch fetch failed', err.message, `(${works.length} works)`);
    works.forEach(w => _markCheckedNoChange(w.rj_code));
    result.errors += works.length;
    return result;
  }

  // バッチ全体を1トランザクションでまとめて保存 (③)
  db.transaction(() => {
    for (const work of works) {
      try {
        const changed = _processOne(work.rj_code, body);
        result.processed++;
        if (changed) result.priceChanges++;
      } catch (err) {
        log.error('[detailFetcher] process error', work.rj_code, err.message);
        result.errors++;
      }
    }
  });

  return result;
}

// ─── 1件処理 ────────────────────────────────────────────────────────────────

function _processOne(rjCode, body) {
  const parsed = parser.parseProductInfo(rjCode, body);
  if (!parsed) {
    log.warn('[detailFetcher] parse failed', rjCode);
    _markCheckedNoChange(rjCode);
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
    // ② セール開始: サークル全作品を優先チェック
    log.info('[detailFetcher] circle sale start – boosting all works', makerId);
    db.markCircleOnSale(makerId, true);
    db.boostCircleWorks(makerId, config.priority.circleOnSale, config.checkInterval.onSale);
  } else if (!isNowOnSale && wasOnSale) {
    // ② セール終了検知: サークルフラグをクリアし通常頻度に戻す
    log.info('[detailFetcher] circle sale end detected', makerId);
    db.markCircleOnSale(makerId, false);
    db.resetCircleWorksPriority(makerId, config.priority.normal, config.checkInterval.normal);
  }
}

// ─── 単体fetch (--rjオプション用) ───────────────────────────────────────────

async function fetchAndStore(rjCode, siteId = 'maniax') {
  const url = `${BASE}/${siteId}/product/info/ajax?product_id=${rjCode}&cdn_cache_min=1`;
  let body;
  try {
    const res = await fetchWithRetry(url, {
      headers: { Accept: 'application/json, text/javascript, */*' },
    });
    if (!res.ok) {
      log.warn('[detailFetcher] non-200', res.status, rjCode);
      _markCheckedNoChange(rjCode);
      return false;
    }
    body = await res.json();
  } catch (err) {
    log.error('[detailFetcher] fetch failed', rjCode, err.message);
    _markCheckedNoChange(rjCode);
    return false;
  }
  return _processOne(rjCode, body);
}

// ─── スケジュール計算 ────────────────────────────────────────────────────────

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

function _markCheckedNoChange(rjCode) {
  const w = db.getWorkByRj(rjCode);
  if (!w) return;
  const n = (w.consecutive_no_change ?? 0) + 1;
  const { interval, priority } = _calcSchedule(w, { is_on_sale: w.is_on_sale }, n);
  db.markChecked(rjCode, { check_interval: interval, priority, is_on_sale: w.is_on_sale ?? 0, consecutive_no_change: n });
}

function _groupBy(arr, keyFn) {
  return arr.reduce((acc, item) => {
    const k = keyFn(item);
    (acc[k] ??= []).push(item);
    return acc;
  }, {});
}

module.exports = { runDetailFetch, fetchAndStore };
