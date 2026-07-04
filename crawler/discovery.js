'use strict';

/**
 * crawler/discovery.js
 * RJコード収集。新着/ランキング/セール/FSR全収集。
 */

const config = require('../config');
const db     = require('./db');
const parser = require('./parser');
const log    = require('./logger');
const { fetchWithRetry, sleep } = require('./queue');

const BASE = config.dlsite.baseUrl;
const RL   = config.fetch.rateLimit;

// ─── 通常discovery ───────────────────────────────────────────────────────────

// 今月リリース FSR URL テンプレート
// {date} = YYYY-MM-DD（今月1日）、{page} = /page/N（ページ番号：1は省略）
const DISCOVERY_FSR = {
  maniax: 'https://www.dlsite.com/maniax/fsr/=/language/jp/sex_category%5B0%5D/male/regist_date_start/{date}/ana_flg/all/age_category%5B0%5D/general/age_category%5B1%5D/r15/age_category%5B2%5D/adult/work_category%5B0%5D/doujin/work_category%5B1%5D/books/work_category%5B2%5D/pc/work_category%5B3%5D/app/work_category%5B4%5D/ai/order/release_d/options_and_or/and/options%5B0%5D/JPN/options%5B1%5D/ENG/options%5B2%5D/CHI_HANS/options%5B3%5D/CHI_HANT/options%5B4%5D/KO_KR/options%5B5%5D/SPA/options%5B6%5D/GER/options%5B7%5D/FRE/options%5B8%5D/IND/options%5B9%5D/ITA/options%5B10%5D/POR/options%5B11%5D/SWE/options%5B12%5D/THA/options%5B13%5D/VIE/options%5B14%5D/OTL/options%5B15%5D/NM/per_page/100{page}/release_term/month/show_type/1',
  bl:     'https://www.dlsite.com/bl/fsr/=/language/jp/regist_date_start/{date}/ana_flg/all/age_category%5B0%5D/general/age_category%5B1%5D/r15/age_category%5B2%5D/adult/work_category%5B0%5D/doujin/work_category%5B1%5D/books/work_category%5B2%5D/drama/work_category%5B3%5D/pc/order/release_d/options_and_or/and/options%5B0%5D/JPN/options%5B1%5D/ENG/options%5B2%5D/CHI/options%5B3%5D/KO_KR/options%5B4%5D/SPA/options%5B5%5D/GER/options%5B6%5D/FRE/options%5B7%5D/IND/options%5B8%5D/ITA/options%5B9%5D/POR/options%5B10%5D/SWE/options%5B11%5D/THA/options%5B12%5D/VIE/options%5B13%5D/OTL/options%5B14%5D/NM/per_page/100{page}/is_tl/1/is_bl/1/is_gay%5B0%5D/1/release_term/month/show_type/1',
  girls:  'https://www.dlsite.com/girls/fsr/=/language/jp/regist_date_start/{date}/ana_flg/all/age_category%5B0%5D/general/age_category%5B1%5D/r15/age_category%5B2%5D/adult/work_category%5B0%5D/doujin/work_category%5B1%5D/books/work_category%5B2%5D/pc/work_category%5B3%5D/app/work_category%5B4%5D/ai/order%5B0%5D/release_d/options_and_or/and/options%5B0%5D/JPN/options%5B1%5D/ENG/options%5B2%5D/CHI_HANS/options%5B3%5D/CHI_HANT/options%5B4%5D/KO_KR/options%5B5%5D/SPA/options%5B6%5D/GER/options%5B7%5D/FRE/options%5B8%5D/IND/options%5B9%5D/ITA/options%5B10%5D/POR/options%5B11%5D/SWE/options%5B12%5D/THA/options%5B13%5D/VIE/options%5B14%5D/OTL/options%5B15%5D/NM/per_page/100{page}/release_term/month/show_type/1',
};

/** 今月1日の日付文字列を返す (YYYY-MM-DD) */
function _monthStart(offset = 0) {
  const d = new Date();
  // offset=-1 で前月1日を返す（月またぎ時のカバー用）
  d.setMonth(d.getMonth() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

/** 月が変わったばかり（1〜5日）かどうか */
function _isMonthRollover() {
  return new Date().getDate() <= 5;
}

/** FSR URL を指定日付(月初)から全ページスキャンして新着RJを収集 */
async function _scanFsrMonthly(site, knownRjs, dateStr = null) {
  const date = dateStr ?? _monthStart();
  const tmpl = DISCOVERY_FSR[site];
  if (!tmpl) return 0;

  let page = 1, count = 0;
  while (true) {
    const pagePart = page === 1 ? '' : `/page/${page}`;
    const url = tmpl.replace('{date}', date).replace('{page}', pagePart);
    const items = await _fetchWithPrice(url);
    if (!items.length) break;
    count += _upsert(items, site, knownRjs);
    log.info('[discovery] monthly', { site, date, page, parsed: items.length, newAdded: count });
    if (items.length < 100) break;
    page++;
    await sleep(config.fetch.rateLimit);
  }
  return count;
}

async function runDiscovery() {
  const month     = _monthStart();
  const prevMonth = _isMonthRollover() ? _monthStart(-1) : null;
  log.info('[discovery] start — monthly FSR', { month, prevMonth: prevMonth ?? '(skip)' });
  try {
    const knownRjs = _loadKnown();
    const results  = {};

    // 今月分を収集
    results.maniax = await _scanFsrMonthly('maniax', knownRjs);
    results.bl     = await _scanFsrMonthly('bl',     knownRjs);
    results.girls  = await _scanFsrMonthly('girls',  knownRjs);

    // 月が変わったばかり(1〜5日)の場合、前月末リリース分の取りこぼしをカバー
    // （月またぎで起動していなかった期間のRJを拾う）
    if (prevMonth) {
      log.info('[discovery] rollover: scanning previous month', prevMonth);
      results.maniax_prev = await _scanFsrMonthly('maniax', knownRjs, prevMonth);
      results.bl_prev     = await _scanFsrMonthly('bl',     knownRjs, prevMonth);
      results.girls_prev  = await _scanFsrMonthly('girls',  knownRjs, prevMonth);
    }

    results.circle = await _collectCircles(knownRjs);
    const total = Object.values(results).reduce((a, b) => a + b, 0);
    log.info('[discovery] done', { total, ...results });
    return { discovered: total, sources: results };
  } catch (err) {
    log.error('[discovery] CRASH', err.message,
      err.stack?.split('\n').slice(1, 3).join(' | '));
    throw err;
  }
}

// ─── 全収集 (FSR) ────────────────────────────────────────────────────────────

async function runFullScan({ sale = false, maxPages = 0, onProgress = null } = {}) {
  log.info('[discovery] fullScan start', { sale, maxPages });

  const knownRjs  = _loadKnown();   // ページをまたいで使い回す
  const fsrUrls   = config.dlsite.fsrUrls ?? {};
  let   grandTotal = 0;
  const sites     = {};

  for (const [site, urls] of Object.entries(fsrUrls)) {
    const baseUrl = sale ? urls.sale : urls.all;
    if (!baseUrl) continue;

    let page = 1, siteTotal = 0;

    while (true) {
      if (maxPages > 0 && page > maxPages) break;

      // page=1はURLに/page/1を含まないDLsiteの仕様に対応
      const url   = page === 1
        ? baseUrl.replace(/\/page\/\{page\}/, '')
        : baseUrl.replace('{page}', String(page));
      const items = await _fetchWithPrice(url);

      if (!items.length) {
        log.info('[discovery] fullScan end', { site, page });
        break;
      }

      const added = _upsert(items, site, knownRjs);
      siteTotal += added;
      grandTotal += added;

      if (onProgress) onProgress({ site, page, found: added, total: siteTotal });
      log.info('[discovery] fullScan', { site, page, parsed: items.length, added, total: siteTotal });

      // FSRは per_page=100 なので100件未満なら最終ページ
      if (items.length < 100) {
        log.info('[discovery] fullScan end', { site, page, reason: 'last page' });
        break;
      }

      page++;
      await sleep(RL);
    }

    sites[site] = siteTotal;
  }

  log.info('[discovery] fullScan done', { grandTotal, ...sites });
  return { grandTotal, sites };
}

async function _collectCircles(knownRjs) {
  // セール中を優先し、最も長くチェックされていないサークルをローテーション
  const toCheck = db.getCirclesForDiscovery(30);
  const CONC    = 5;  // 同時リクエスト数

  let count = 0;
  // CONC 件ずつ並列フェッチ
  for (let i = 0; i < toCheck.length; i += CONC) {
    const chunk = toCheck.slice(i, i + CONC);
    const results = await Promise.all(
      chunk.flatMap(mid =>
        config.dlsite.sites.map(async site => {
          const url   = `${BASE}/${site}/fsr/=/maker_id/${mid}/order/release/per_page/30/show_type/1`;
          const items = await _fetchWithPrice(url);
          return _upsert(items, site, knownRjs);
        })
      )
    );
    count += results.reduce((a, b) => a + b, 0);
    if (i + CONC < toCheck.length) await sleep(RL);
  }
  return count;
}

// ─── fetch + parse ───────────────────────────────────────────────────────────

async function _fetchWithPrice(url) {
  try {
    const res = await fetchWithRetry(url);
    if (!res.ok) {
      log.warn('[discovery] fetch non-200', res.status, url);
      return [];
    }
    const html = await res.text();
    return parser.parseWorkListWithPrice(html);
  } catch (e) {
    log.error('[discovery] fetch error', url, e.message);
    return [];
  }
}

// ─── DB書き込み ──────────────────────────────────────────────────────────────

function _upsert(items, siteId, knownRjs) {
  const newItems = items.filter(i => i.rjCode && !knownRjs.has(i.rjCode));
  if (!newItems.length) return 0;

  db.transaction(() => {
    for (const item of newItems) {
      db.upsertWork({
        rj_code:      item.rjCode,
        title:        item.title        ?? null,
        circle:       item.circle       ?? null,
        maker_id:     item.makerId      ?? null,
        work_type:    item.workType     ?? null,
        site_id:      siteId,
        release_date: item.releaseDate  ?? null,
        dl_count:     0,
      });
      knownRjs.add(item.rjCode);

      if (item.price !== null) {
        db.savePriceIfChanged(item.rjCode, {
          price:         item.price,
          sale_price:    item.salePrice    ?? null,
          discount_rate: item.discountRate ?? null,
          point:         null,
          is_on_sale:    item.isOnSale ? 1 : 0,
        });
      }
    }
  });

  return newItems.length;
}

function _loadKnown() {
  return db.getAllRjCodes();
}

// ─── 割引終了間近(24時間以内)収集 ────────────────────────────────────────────
// DLsiteのFSR検索には soon/1 という「割引終了まで24時間以内」フィルタが存在する。
// これに該当する作品は優先度を最優先(endingSoon)に上げ、チェック間隔も短くして、
// 終了直前の価格・割引状況の取りこぼしを防ぐ。

async function runEndingSoonScan({ onProgress = null } = {}) {
  log.info('[discovery] endingSoonScan start');

  const knownRjs = _loadKnown();
  const fsrUrls  = config.dlsite.fsrUrls ?? {};
  const priority = config.priority.endingSoon;
  const interval = config.checkInterval.endingSoon;

  let grandTotal = 0, newCount = 0, boostedCount = 0;
  const sites = {};

  for (const [site, urls] of Object.entries(fsrUrls)) {
    const baseUrl = urls.soon;
    if (!baseUrl) continue;

    let page = 1, siteTotal = 0;

    while (true) {
      // page=1はURLに/page/1を含まないDLsiteの仕様に対応
      const url = page === 1
        ? baseUrl.replace(/\/page\/\{page\}/, '')
        : baseUrl.replace('{page}', String(page));
      const items = await _fetchWithPrice(url);

      if (!items.length) {
        log.info('[discovery] endingSoonScan end', { site, page });
        break;
      }

      db.transaction(() => {
        for (const item of items) {
          if (!item.rjCode) continue;

          if (!knownRjs.has(item.rjCode)) {
            db.upsertWork({
              rj_code:      item.rjCode,
              title:        item.title       ?? null,
              circle:       item.circle      ?? null,
              maker_id:     item.makerId     ?? null,
              work_type:    item.workType    ?? null,
              site_id:      site,
              release_date: item.releaseDate ?? null,
              dl_count:     0,
            });
            knownRjs.add(item.rjCode);
            newCount++;
          }

          if (item.price !== null) {
            db.savePriceIfChanged(item.rjCode, {
              price:         item.price,
              sale_price:    item.salePrice    ?? null,
              discount_rate: item.discountRate ?? null,
              point:         null,
              is_on_sale:    item.isOnSale ? 1 : 0,
            });
          }

          // 割引終了間近 = 最優先 & 次回チェックをすぐに(next_check_at = now)
          db.boostWorkUrgent(item.rjCode, priority, interval);
          boostedCount++;
        }
      });

      siteTotal  += items.length;
      grandTotal += items.length;

      if (onProgress) onProgress({ site, page, found: items.length, total: siteTotal });
      log.info('[discovery] endingSoonScan', { site, page, parsed: items.length, total: siteTotal });

      // FSRは per_page=100 なので100件未満なら最終ページ
      if (items.length < 100) {
        log.info('[discovery] endingSoonScan end', { site, page, reason: 'last page' });
        break;
      }

      page++;
      await sleep(RL);
    }

    sites[site] = siteTotal;
  }

  log.info('[discovery] endingSoonScan done', { grandTotal, newCount, boostedCount, ...sites });
  return { grandTotal, newCount, boostedCount, sites };
}

// ─── サークル単位の欠落診断 ──────────────────────────────────────────────────
// 通常のdiscoveryは「今月分」+「直近未チェック30サークル」しか見ないため、
// 何らかの理由（bl の all/sale URL 未定義だった期間、アプリ停止中のリリース等）で
// 一度も収集対象にならなかったRJが既知サークル内に埋もれている可能性がある。
// 既知の全サークル(maker_id)についてDLsite上の全作品ページを走査し、
// DBに存在しないRJコードを正確に検出・登録する。

/**
 * @param {number|null} limit  診断するサークル数の上限（null=全サークル）
 */
async function runCircleGapScan({ onProgress = null, limit = null } = {}) {
  log.info('[discovery] circleGapScan start', { limit: limit ?? 'all' });

  const makerSites = db.getMakerSiteMap();   // Map<maker_id, site_id>
  let makerIds = [...makerSites.keys()];
  if (limit) makerIds = makerIds.slice(0, limit);

  const knownRjs = _loadKnown();
  let checked = 0;
  let totalMissing = 0;
  const missingByCircle = {};

  for (const makerId of makerIds) {
    const site = makerSites.get(makerId);
    if (!site) { checked++; continue; }

    // maker_id 単位のFSR全ページを走査（per_page=100、page1は/page/{page}を省略）
    let page = 1;
    const missingItems = [];
    while (true) {
      const pagePart = page === 1 ? '' : `/page/${page}`;
      const url = `${BASE}/${site}/fsr/=/maker_id/${makerId}/order/release/per_page/100${pagePart}/show_type/1`;
      const items = await _fetchWithPrice(url);
      if (!items.length) break;

      for (const item of items) {
        if (item.rjCode && !knownRjs.has(item.rjCode)) missingItems.push(item);
      }

      if (items.length < 100) break;   // 最終ページ
      page++;
      await sleep(RL);
    }

    if (missingItems.length) {
      const added = _upsert(missingItems, site, knownRjs);
      if (added > 0) {
        missingByCircle[makerId] = added;
        totalMissing += added;
        log.warn('[discovery] circleGap found missing works', { makerId, site, missing: added });
      }
    }

    checked++;
    if (onProgress) onProgress({ checked, total: makerIds.length, totalMissing, makerId, site });
    await sleep(RL);
  }

  log.info('[discovery] circleGapScan done', {
    checked, totalMissing, circlesWithGaps: Object.keys(missingByCircle).length,
  });
  return { checked, totalMissing, missingByCircle };
}

module.exports = { runDiscovery, runFullScan, runEndingSoonScan, runCircleGapScan };
