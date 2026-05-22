'use strict';

/**
 * crawler/discovery.js
 * RJコード収集。
 *
 * 効率化ポイント:
 *   - maniax/home を並列取得 (Promise.all)
 *   - 新着/ランキング/セールも並列化
 *   - 既知RJはスキップ (DB照合)
 *   - サークル探索は最大20件/セッション (変更なし)
 */

const config = require('../config');
const db     = require('./db');
const parser = require('./parser');
const log    = require('./logger');
const { fetchWithRetry, sleep } = require('./queue');
const { saveDiscoveredPrice } = require('./detailFetcher');

const BASE = config.dlsite.baseUrl;

// ─── メインエントリ ──────────────────────────────────────────────────────────

async function runDiscovery() {
  log.info('[discovery] start');

  // ⑦ 既知RJをSetで一括ロード (N回SELECT → 1回SELECT)
  const knownRjs = new Set(
    db.open().exec('SELECT rj_code FROM works')[0]?.values?.map(r => r[0]) ?? []
  );
  log.debug('[discovery] known RJs loaded', knownRjs.size);

  // 両サイトを並列で全ソース探索
  const siteResults = await Promise.all(
    config.dlsite.sites.map(site => _discoverSite(site, knownRjs))
  );

  const summary = siteResults.reduce(
    (acc, r) => ({ new: acc.new + r.new, ranking: acc.ranking + r.ranking, sale: acc.sale + r.sale }),
    { new: 0, ranking: 0, sale: 0 }
  );

  summary.circle = await _discoverFromKnownCircles();

  const total = Object.values(summary).reduce((a, b) => a + b, 0);
  log.info('[discovery] done', { total, ...summary });
  return { discovered: total, sources: summary };
}

// ─── サイト内全ソース並列取得 ────────────────────────────────────────────────

async function _discoverSite(site, knownRjs) {
  // 新着・ランキング・セールを並列実行 (各内部はページループのみ)
  const [newCount, rankCount, saleCount] = await Promise.all([
    _discoverNew(site, knownRjs),
    _discoverRanking(site, knownRjs),
    _discoverSale(site, knownRjs),
  ]);
  return { new: newCount, ranking: rankCount, sale: saleCount };
}

// ─── 新着 ────────────────────────────────────────────────────────────────────

async function _discoverNew(site, knownRjs) {
  let count = 0;
  for (let page = 1; page <= config.dlsite.discoveryPages.new; page++) {
    const url   = `${BASE}/${site}/new/=/per_page/100/page/${page}.html`;
    // C: 価格付き取得
    const items = await _fetchAndParseWithPrice(url);
    if (!items.length) break;
    count += _upsertNewWithPrice(items, site, knownRjs);
    await sleep(config.fetch.rateLimit);
  }
  return count;
}

// ─── ランキング ──────────────────────────────────────────────────────────────

async function _discoverRanking(site, knownRjs) {
  let count = 0;
  // term別を並列取得してから集約
  const terms   = ['day', 'week', 'month'];
  const pages   = config.dlsite.discoveryPages.ranking;
  const results = await Promise.all(
    terms.map(term => _discoverRankingTerm(site, term, pages, knownRjs))
  );
  results.forEach(n => { count += n; });
  return count;
}

async function _discoverRankingTerm(site, term, pages, knownRjs) {
  let count = 0;
  for (let page = 1; page <= pages; page++) {
    const url   = `${BASE}/${site}/ranking/=/term/${term}/page/${page}.html`;
    const codes = await _fetchAndParse(url, parser.parseRankingList);
    if (!codes.length) break;
    count += _upsertNew(codes, site, knownRjs);
    await sleep(config.fetch.rateLimit);
  }
  return count;
}

// ─── セール ──────────────────────────────────────────────────────────────────

async function _discoverSale(site, knownRjs) {
  let count = 0;
  for (let page = 1; page <= config.dlsite.discoveryPages.sale; page++) {
    const url   = `${BASE}/${site}/campaign/=/per_page/100/page/${page}.html`;
    // C: セールページは価格付きで取得 (割引率もHTML上に表示される)
    const items = await _fetchAndParseWithPrice(url);
    if (!items.length) break;
    count += _upsertNewWithPrice(items, site, knownRjs);
    await sleep(config.fetch.rateLimit);
  }
  return count;
}

// ─── サークル ────────────────────────────────────────────────────────────────

async function _discoverFromKnownCircles() {
  const makerIds = db.getAllMakerIds().slice(0, 20);
  let count = 0;
  for (const makerId of makerIds) {
    for (const site of config.dlsite.sites) {
      const url   = `${BASE}/${site}/circle/works/=/maker_id/${makerId}/order/release_d.html`;
      const codes = await _fetchAndParse(url, parser.parseCircleWorks);
      count += _upsertNew(codes, site, knownRjs);
      await sleep(config.fetch.rateLimit);
    }
  }
  log.debug('[discovery] circles', makerIds.length, 'new', count);
  return count;
}

// ─── ヘルパー ────────────────────────────────────────────────────────────────

async function _fetchAndParse(url, parseFn) {
  try {
    const res = await fetchWithRetry(url);
    if (!res.ok) { log.warn('[discovery] non-200', res.status, url); return []; }
    return parseFn(await res.text());
  } catch (err) {
    log.error('[discovery] fetch error', url, err.message);
    return [];
  }
}

/** C: 価格付き一覧を取得。RJコード + 初期価格を同時収集する。 */
async function _fetchAndParseWithPrice(url) {
  try {
    const res = await fetchWithRetry(url);
    if (!res.ok) { log.warn('[discovery] non-200', res.status, url); return []; }
    return parser.parseWorkListWithPrice(await res.text());
  } catch (err) {
    log.error('[discovery] fetch error', url, err.message);
    return [];
  }
}

/** 後方互換: コードのみのupsert */
function _upsertNew(codes, siteId, knownRjs) {
  const items = codes.map(rj => ({ rjCode: rj, price: null, salePrice: null, discountRate: null, isOnSale: false }));
  return _upsertNewWithPrice(items, siteId, knownRjs);
}

/** C: RJコード + 初期価格を同時upsert。既知Setで照合。 */
function _upsertNewWithPrice(items, siteId, knownRjs) {
  const newItems = items.filter(r => !knownRjs.has(r.rjCode));
  if (!newItems.length) return 0;

  db.transaction(() => {
    for (const item of newItems) {
      db.upsertWork({ rj_code: item.rjCode, title: null, circle: null, maker_id: null,
        work_type: null, site_id: siteId, release_date: null, dl_count: 0 });
      knownRjs.add(item.rjCode);

      // C: 価格が取れていれば即保存 (detail fetchを節約)
      if (item.price !== null) {
        saveDiscoveredPrice(item.rjCode, {
          price:         item.price,
          sale_price:    item.salePrice,
          discount_rate: item.discountRate,
          point:         null,
          is_on_sale:    item.isOnSale ? 1 : 0,
        });
        log.debug('[discovery] initial price saved', item.rjCode, item.price);
      }
    }
  });

  return newItems.length;
}

module.exports = { runDiscovery };
