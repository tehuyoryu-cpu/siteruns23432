'use strict';

/**
 * crawler/detailFetcher.js
 * 個別作品の価格詳細取得（product/info/ajax バッチAPI）。
 */

const config = require('../config');
const db     = require('./db');
const parser = require('./parser');
const log    = require('./logger');
const { fetchWithRetry, sleep } = require('./queue');

const BASE  = config.dlsite.baseUrl;
const BATCH = config.fetch.batchSize ?? 50;

// ─── public ──────────────────────────────────────────────────────────────────

async function runDetailFetch(limit = 300) {
  const due = db.getDueWorks(limit);
  if (!due.length) {
    log.info('[detail] no due works');
    return { processed: 0, priceChanges: 0, errors: 0 };
  }

  log.info('[detail] due:', due.length);
  const result = { processed: 0, priceChanges: 0, errors: 0 };

  // サイト別グループ
  const bySite = {};
  for (const w of due) {
    const s = w.site_id ?? 'maniax';
    (bySite[s] ??= []).push(w);
  }

  for (const [site, works] of Object.entries(bySite)) {
    for (let i = 0; i < works.length; i += BATCH) {
      const batch = works.slice(i, i + BATCH);
      const r     = await _processBatch(batch, site);
      result.processed    += r.processed;
      result.priceChanges += r.priceChanges;
      result.errors       += r.errors;
      if (i + BATCH < works.length) await sleep(config.fetch.rateLimit);
    }
  }

  log.info('[detail] done', result);
  return result;
}

// 単体fetch（--rj オプション / テスト用）
async function fetchAndStore(rjCode, siteId = 'maniax') {
  const body = await _apiFetch([{ rj_code: rjCode }], siteId);
  if (!body) { db.recordFetchError(rjCode); return false; }
  let changed = false;
  db.transaction(() => { changed = _store(rjCode, body); });
  return changed;
}

// discovery が取得した初期価格を保存
function saveDiscoveredPrice(rjCode, priceData) {
  const changed = db.savePriceIfChanged(rjCode, priceData);
  if (changed) db.save(); // Fix#7: ensure persistence outside transaction
  return changed;
}

// ─── バッチ処理 ───────────────────────────────────────────────────────────────

async function _processBatch(works, site) {
  const result = { processed: 0, priceChanges: 0, errors: 0 };
  let body = await _apiFetch(works, site);

  // 失敗→10件分割→失敗→1件ずつ
  if (!body && works.length > 1) {
    log.warn('[detail] batch fail, splitting', works.length);
    const SUB = 10;
    for (let i = 0; i < works.length; i += SUB) {
      const sub = works.slice(i, i + SUB);
      const r   = await _processBatch(sub, site);
      result.processed    += r.processed;
      result.priceChanges += r.priceChanges;
      result.errors       += r.errors;
      if (i + SUB < works.length) await sleep(config.fetch.rateLimit);
    }
    return result;
  }

  if (!body) {
    // 1件でも失敗
    for (const w of works) db.recordFetchError(w.rj_code);
    result.errors += works.length;
    return result;
  }

  db.transaction(() => {
    for (const w of works) {
      try {
        const changed = _store(w.rj_code, body);
        result.priceChanges += changed ? 1 : 0;
        result.processed++;
      } catch (e) {
        log.error('[detail] store error', w.rj_code, e.message);
        db.recordFetchError(w.rj_code);
        result.errors++;
      }
    }
  });

  return result;
}

// ─── API fetch ────────────────────────────────────────────────────────────────

async function _apiFetch(works, site) {
  const params = works.map(w => `product_id=${w.rj_code}`).join('&');
  const url    = `${BASE}/${site}/product/info/ajax?${params}&cdn_cache_min=1`;
  try {
    const res = await fetchWithRetry(url, {
      headers: { Accept: 'application/json, */*' },
    });
    if (!res.ok) { log.warn('[detail] API', res.status, `(${works.length}件)`); return null; }
    return await res.json();
  } catch (e) {
    log.error('[detail] API error', e.message, `(${works.length}件)`);
    return null;
  }
}

// ─── 1件保存 ─────────────────────────────────────────────────────────────────

function _store(rjCode, body) {
  const parsed = parser.parseProductInfo(rjCode, body);
  if (!parsed) {
    db.recordFetchError(rjCode);
    return false;
  }

  const { work, price } = parsed;
  db.upsertWork(work);

  if (work.maker_id) {
    db.upsertCircle(work.maker_id, work.circle ?? '');
    _handleCircleSale(work.maker_id, price);
  }

  const changed   = db.savePriceIfChanged(rjCode, price);
  const existing  = db.getWorkByRj(rjCode);
  const noChange  = changed ? 0 : (existing?.consecutive_no_change ?? 0) + 1;
  const schedule  = _schedule(work, price, noChange);

  db.markChecked(rjCode, {
    check_interval:        schedule.interval,
    priority:              schedule.priority,
    is_on_sale:            price.is_on_sale,
    consecutive_no_change: noChange,
    consecutive_errors:    0,
  });

  if (changed) log.info('[detail] price changed', { rj: rjCode, ...price });
  return changed;
}

// ─── サークルセール伝播 ───────────────────────────────────────────────────────

function _handleCircleSale(makerId, price) {
  const circle = db.getCircle(makerId);
  if (!circle) return;
  const onSale    = price.is_on_sale === 1;
  const wasOnSale = circle.on_sale === 1;

  if (onSale && !wasOnSale) {
    log.info('[detail] circle sale start', makerId);
    db.markCircleOnSale(makerId, true);
    db.boostCircleWorks(makerId, config.priority.circleOnSale, config.checkInterval.onSale);
  } else if (!onSale && wasOnSale) {
    log.info('[detail] circle sale end', makerId);
    db.markCircleOnSale(makerId, false);
    db.resetCircleWorksPriority(makerId, config.priority.normal, config.checkInterval.normal);
  }
}

// ─── スケジュール計算 ─────────────────────────────────────────────────────────

function _schedule(work, price, noChange) {
  const ci = config.checkInterval, p = config.priority;
  if (price.is_on_sale)   return { interval: ci.onSale,     priority: p.onSale };
  if (noChange >= 5)      return { interval: ci.cold,       priority: p.cold };
  const days = _ageDays(work.release_date);
  if (days <  7)          return { interval: ci.newWork,    priority: p.newWork };
  if (days < 30)          return { interval: ci.recentWork, priority: p.recentWork };
  if ((work.dl_count ?? 0) >= 1000) return { interval: ci.popular, priority: p.popular };
  return { interval: ci.normal, priority: p.normal };
}

function _ageDays(d) {
  try { return Math.floor((Date.now() - new Date(d).getTime()) / 86400000); }
  catch { return 9999; }
}

module.exports = { runDetailFetch, fetchAndStore, saveDiscoveredPrice };
