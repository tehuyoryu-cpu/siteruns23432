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

async function runDiscovery() {
  log.info('[discovery] start');

  const knownRjs = _loadKnown();
  const results  = {};

  // 直列で実行してレートリミット超過を防ぐ
  results.new     = await _collectPages('new',     knownRjs);
  results.ranking = await _collectPages('ranking', knownRjs);
  results.sale    = await _collectPages('sale',    knownRjs);

  // 既知サークルの新作確認（直列・上限20）
  results.circle = await _collectCircles(knownRjs);

  const total = Object.values(results).reduce((a, b) => a + b, 0);
  log.info('[discovery] done', { total, ...results });
  return { discovered: total, sources: results };
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

// ─── ページ種別別収集 ─────────────────────────────────────────────────────────

async function _collectPages(type, knownRjs) {
  const urlFor = (site, page) => {
    // DLsiteはpage=1のとき /page/1 を含まない
    const pagePart = page === 1 ? '' : `/page/${page}`;
    if (type === 'new')     return `${BASE}/${site}/new/=/per_page/100${pagePart}.html`;
    if (type === 'ranking') return `${BASE}/${site}/ranking/=/term/week/per_page/100${pagePart}.html`;
    if (type === 'sale')    return `${BASE}/${site}/campaign/=/per_page/100${pagePart}.html`;
  };

  const maxPages = {
    new:     config.dlsite.discoveryPages?.new     ?? 5,
    ranking: config.dlsite.discoveryPages?.ranking ?? 3,
    sale:    config.dlsite.discoveryPages?.sale    ?? 5,
  }[type];

  let count = 0;
  for (const site of config.dlsite.sites) {
    for (let page = 1; page <= maxPages; page++) {
      const items = await _fetchWithPrice(urlFor(site, page));
      if (!items.length) break;
      count += _upsert(items, site, knownRjs);
      await sleep(RL);
    }
  }
  return count;
}

async function _collectCircles(knownRjs) {
  const makerIds = db.getAllMakerIds().slice(0, 20);
  let count = 0;
  for (const mid of makerIds) {
    for (const site of config.dlsite.sites) {
      const url   = `${BASE}/${site}/circle/works/=/maker_id/${mid}/order/release_d.html`;
      const items = await _fetchWithPrice(url);
      count += _upsert(items, site, knownRjs);
      await sleep(RL);
    }
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
  const newItems = items.filter(i => !knownRjs.has(i.rjCode));
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

module.exports = { runDiscovery, runFullScan };
