'use strict';

/**
 * crawler/parser.js
 * DLsite HTMLからRJコード + 価格を抽出。
 * APIレスポンス（product/info/ajax）をパース。
 */

const cheerio = require('cheerio');
const log     = require('./logger');

// ─── Product Info API ─────────────────────────────────────────────────────────

function parseProductInfo(rjCode, body) {
  try {
    const d = body[rjCode];
    if (!d) {
      log.warn('[parser] key not found', rjCode, Object.keys(body).slice(0,3));
      return null;
    }

    const price      = _int(d.price_work ?? d.price ?? d.price_with_tax);
    const isOnSale   = !!(d.is_sale || d.discount_rate);
    const salePrice  = isOnSale
      ? _int(d.price_without_tax_sale ?? d.price_sale ?? d.discount_price)
      : null;
    let disc = _int(d.discount_rate ?? d.rate);
    if (disc === null && price && salePrice) {
      disc = Math.round((1 - salePrice / price) * 100);
    }

    return {
      work: {
        rj_code:      rjCode,
        title:        _str(d.work_name  ?? d.name),
        circle:       _str(d.maker_name ?? d.brand_name),
        maker_id:     _str(d.maker_id   ?? d.brand_id),
        work_type:    _str(d.work_type),
        site_id:      _str(d.site_id ?? 'maniax'),
        release_date: _str(d.regist_date ?? d.product_date ?? d.sales_date),
        dl_count:     _int(d.dl_count ?? d.down_count),
      },
      price: {
        price,
        sale_price:    salePrice,
        point:         _int(d.point ?? d.dl_point),
        discount_rate: disc,
        is_on_sale:    isOnSale ? 1 : 0,
      },
    };
  } catch (e) {
    log.error('[parser] parseProductInfo', rjCode, e.message);
    return null;
  }
}

// ─── HTML 一覧ページ ──────────────────────────────────────────────────────────

/**
 * HTMLからRJコードと価格を同時抽出。
 * DLsiteの複数レイアウトに対応。
 */
function parseWorkListWithPrice(html) {
  if (!html || html.length < 100) return [];

  try {
    const $     = cheerio.load(html);
    const found = new Map();

    // ── 方法1: data-product_id 属性（最も確実）──
    $('[data-product_id]').each((_, el) => {
      const rj = _rj($(el).attr('data-product_id'));
      if (!rj || found.has(rj)) return;

      const price    = _jpyText($(el).attr('data-price'))
                    ?? _jpyText($('.work_price', el).first().text());
      const salePr   = _jpyText($(el).attr('data-sale_price'))
                    ?? _jpyText($('.work_price_sale, .work_price.type_sale', el).first().text());

      found.set(rj, _priceObj(rj, price, salePr));
    });

    // ── 方法2: href に /product_id/RJ ──
    $('a[href*="/product_id/RJ"]').each((_, el) => {
      const rj = _rj($(el).attr('href'));
      if (rj && !found.has(rj)) {
        found.set(rj, _priceObj(rj, null, null));
      }
    });

    // ── 方法3: テキスト全体から RJ コードを正規表現スキャン ──
    const raw  = $.html();
    const hits = raw.match(/\bRJ\d{6,8}\b/gi) ?? [];
    for (const h of hits) {
      const rj = h.toUpperCase();
      if (!found.has(rj)) found.set(rj, _priceObj(rj, null, null));
    }

    const result = [...found.values()];
    log.debug('[parser] parseWorkListWithPrice', result.length, 'codes');
    return result;
  } catch (e) {
    log.error('[parser] parseWorkListWithPrice', e.message);
    return [];
  }
}

function parseWorkList(html)    { return parseWorkListWithPrice(html).map(r => r.rjCode); }
function parseRankingList(html) { return parseWorkList(html); }
function parseCircleWorks(html) { return parseWorkList(html); }
function parseSalePage(html)    { return parseWorkListWithPrice(html); }

// ─── helpers ─────────────────────────────────────────────────────────────────

function _rj(str) {
  if (!str) return null;
  const m = str.match(/\b(RJ\d{6,8})\b/i);
  return m ? m[1].toUpperCase() : null;
}

function _jpyText(text) {
  if (!text) return null;
  const n = parseInt(String(text).replace(/[^0-9]/g, ''), 10);
  return isNaN(n) || n === 0 ? null : n;
}

function _priceObj(rjCode, price, salePrice) {
  const disc = price && salePrice ? Math.round((1 - salePrice / price) * 100) : null;
  return { rjCode, price, salePrice, discountRate: disc, isOnSale: !!(salePrice) };
}

function _int(v) {
  if (v == null) return null;
  const n = parseInt(String(v).replace(/[^0-9]/g, ''), 10);
  return isNaN(n) ? null : n;
}

function _str(v) {
  if (v == null) return null;
  return String(v).trim() || null;
}

module.exports = {
  parseProductInfo,
  parseWorkListWithPrice,
  parseWorkList,
  parseRankingList,
  parseCircleWorks,
  parseSalePage,
};
