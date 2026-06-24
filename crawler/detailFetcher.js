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
const BATCH = Math.min(config.fetch.batchSize ?? 20, 20);  // DLsite API の安全上限

// ─── public ──────────────────────────────────────────────────────────────────

async function runDetailFetch(limit = 300, { onProgress } = {}) {
  // due な作品が limit を超える場合でも、1回の呼び出しで全件処理し終えるまでループする。
  // （以前は limit 件で必ず打ち切られ、「全て巡回」等で残りが無視されるバグがあった）
  const result = { processed: 0, priceChanges: 0, errors: 0, total: 0 };

  // サイト別グループ
  // DLsite product/info/ajax が受け付けるサイト識別子のみ許可。
  // 旧DBに残存する 'aix' 等の廃止サイト名は 'maniax' にフォールバック。
  const VALID_SITES = new Set(['maniax', 'girls', 'home', 'bl', 'pro']);

  while (true) {
    const due = db.getDueWorks(limit);
    if (!due.length) {
      if (result.total === 0) log.info('[detail] no due works');
      break;
    }

    result.total += due.length;
    log.info('[detail] due batch:', due.length, '(total so far:', result.total, ')');

    const bySite = {};
    for (const w of due) {
      const raw = w.site_id ?? 'maniax';
      const s   = VALID_SITES.has(raw) ? raw : 'maniax';
      if (s !== raw) log.warn('[detail] unknown site_id fallback:', raw, '->', s, w.rj_code);
      (bySite[s] ??= []).push(w);
    }

    for (const [site, works] of Object.entries(bySite)) {
      for (let i = 0; i < works.length; i += BATCH) {
        const batch = works.slice(i, i + BATCH);
        const r     = await _processBatch(batch, site);
        result.processed    += r.processed;
        result.priceChanges += r.priceChanges;
        result.errors       += r.errors;
        onProgress?.({ processed: result.processed, priceChanges: result.priceChanges, total: result.total });
        if (i + BATCH < works.length) await sleep(config.fetch.rateLimit);
      }
    }

    // 取得件数が limit 未満なら、これ以上 due な作品は残っていない
    if (due.length < limit) break;
  }

  log.info('[detail] done', result);
  return result;
}

// 単体fetch（--rj オプション / テスト用）
async function fetchAndStore(rjCode, siteId = 'maniax') {
  const body = await _apiFetch([{ rj_code: rjCode }], siteId);
  if (!body) { db.transaction(() => db.recordFetchError(rjCode)); return false; }
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

  // 失敗→バイナリ分割（半分ずつ）→1件まで再帰して個別エラー記録
  // SUB=10 固定にすると works.length < SUB の場合に無限ループするため halving を使う
  if (!body && works.length > 1) {
    log.warn('[detail] batch fail, splitting', works.length);
    const mid = Math.ceil(works.length / 2);
    const [r1, r2] = await Promise.all([
      _processBatch(works.slice(0, mid),  site),
      _processBatch(works.slice(mid),     site),
    ]);
    result.processed    += r1.processed    + r2.processed;
    result.priceChanges += r1.priceChanges + r2.priceChanges;
    result.errors       += r1.errors       + r2.errors;
    return result;
  }

  if (!body) {
    // 1件でも失敗 — transaction でまとめて保存
    db.transaction(() => {
      for (const w of works) db.recordFetchError(w.rj_code);
    });
    result.errors += works.length;
    return result;
  }

  // APIレスポンスのキーを正規化: 大文字版 + ゼロ埋めなし版の両方をインデックス
  const normalizedBody = {};
  for (const [k, v] of Object.entries(body)) {
    const upper  = k.toUpperCase();
    const nopad  = upper.replace(/^RJ0+/, 'RJ');
    normalizedBody[upper] = v;
    if (nopad !== upper) normalizedBody[nopad] = v;  // 例: RJ01234567 → RJ1234567 も登録
  }

  db.transaction(() => {
    for (const w of works) {
      try {
        const dbKey   = w.rj_code;                          // DB に登録されているキー（これのみDB操作に使う）
        const rj      = dbKey.toUpperCase();
        const rjNopad = rj.replace(/^RJ0+/, 'RJ');
        const found   = rj in normalizedBody || rjNopad in normalizedBody;

        if (!found) {
          log.warn('[detail] key not in API response', rj,
            'available:', Object.keys(normalizedBody).slice(0, 3).join(', '));
          db.recordFetchError(dbKey);
          result.errors++;
          continue;
        }

        // データ抽出用キーはnopadでも可、ただしDB操作は必ず dbKey を使う
        const dataKey     = (rj in normalizedBody) ? rj : rjNopad;
        const singleBody  = { [dbKey]: normalizedBody[dataKey] };  // DB キーで包み直す
        const changed     = _store(dbKey, singleBody);

        if (changed === null) {
          result.errors++;
        } else {
          result.priceChanges += changed ? 1 : 0;
          result.processed++;
        }
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
  // DLsite API は product_id[] 形式（配列）を要求する
  const params = works.map(w => `product_id%5B%5D=${encodeURIComponent(w.rj_code)}`).join('&');
  const url    = `${BASE}/${site}/product/info/ajax?${params}&cdn_cache_min=1`;
  try {
    const res = await fetchWithRetry(url, {
      headers: { Accept: 'application/json, */*' },
    });
    if (!res.ok) {
      log.error('[detail] API HTTP error', res.status, site, `${works.length}件`,
        works.slice(0,3).map(w=>w.rj_code).join(','));
      return null;
    }
    const body = await res.json();
    const returnedKeys = Object.keys(body).length;
    if (returnedKeys === 0) {
      log.warn('[detail] API returned empty object', site, `requested ${works.length}件`,
        'sample:', works.slice(0,2).map(w=>w.rj_code).join(','));
      return null;
    }
    if (returnedKeys < works.length * 0.5) {
      log.warn('[detail] API returned partial data', site,
        `got ${returnedKeys} / requested ${works.length}`);
    }
    return body;
  } catch (e) {
    log.error('[detail] API fetch error', e.message, site, `${works.length}件`);
    return null;
  }
}

// ─── 1件保存 ─────────────────────────────────────────────────────────────────

function _store(rjCode, body) {
  const parsed = parser.parseProductInfo(rjCode, body);
  if (!parsed) {
    // 生データをエラーログに出力して原因を特定できるようにする
    const raw = body[rjCode] ?? body[rjCode.toUpperCase()];
    log.error('[detail] parseProductInfo failed', rjCode,
      raw ? `fields: ${Object.keys(raw).join(',')}` : 'key not found in body');
    db.recordFetchError(rjCode);
    return null;   // null = parse failure (distinct from false = price unchanged)
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
