'use strict';

/**
 * crawler/parser.js
 *
 * C: parseWorkListWithPrice() — 一覧HTMLからRJコード + 価格を同時抽出
 * D: parseProductInfo() — product/info/ajax の全フィールドパターンを網羅
 */

const cheerio = require('cheerio');
const log     = require('./logger');

// ─── D: Product Info API (JSON) ──────────────────────────────────────────────

/**
 * /maniax/product/info/ajax?product_id=RJ... のレスポンスを解析。
 * フィールド名は DLsite のバージョンで変わるため全パターンを網羅。
 */
function parseProductInfo(rjCode, body) {
  try {
    const d = body[rjCode];
    if (!d) {
      log.warn('[parser] key not found in response', rjCode);
      return null;
    }

    // D: 価格フィールド — 税込/税別 × 通常/セール の全パターン
    const price = _resolvePrice(d);
    if (price.price === null) {
      log.warn('[parser] price field not found', rjCode, Object.keys(d).join(','));
    }

    const work = {
      rj_code:      rjCode,
      title:        _str(d.work_name    ?? d.name          ?? d.title),
      circle:       _str(d.maker_name   ?? d.brand_name    ?? d.circle_name),
      maker_id:     _str(d.maker_id     ?? d.brand_id),
      work_type:    _str(d.work_type    ?? d.work_type_id),
      site_id:      _str(d.site_id      ?? d.domain        ?? 'maniax'),
      release_date: _str(d.regist_date  ?? d.product_date  ?? d.sales_date ?? d.date),
      dl_count:     _int(d.dl_count     ?? d.down_count    ?? d.sales_count),
    };

    return { work, price };
  } catch (err) {
    log.error('[parser] parseProductInfo error', rjCode, err.message);
    return null;
  }
}

/**
 * D: DLsite の価格フィールドは時期・サイトで名前が変わる。
 * 優先順位付きで解決する。
 */
function _resolvePrice(d) {
  // 通常価格: 税込表示を優先
  const price =
    _int(d.price_work)            ??  // 最新API
    _int(d.price)                 ??  // 旧API
    _int(d.price_with_tax)        ??  // 一部作品
    _int(d.prices?.JPY)           ??  // 多通貨対応版
    null;

  const isOnSale = !!(d.is_sale || d.on_sale || d.discount_rate);

  // セール価格
  const salePrice = isOnSale
    ? (_int(d.price_without_tax_sale) ??  // 最新
       _int(d.price_sale)             ??  // 旧
       _int(d.discount_price)         ??  // 一部
       null)
    : null;

  // 割引率: APIが返す場合はそのまま、なければ計算
  let discountRate =
    _int(d.discount_rate) ??
    _int(d.rate)          ??
    null;

  if (discountRate === null && price && salePrice) {
    discountRate = Math.round((1 - salePrice / price) * 100);
  }

  // ポイント: 購入ポイント
  const point =
    _int(d.point)      ??
    _int(d.dl_point)   ??
    _int(d.point_rate) ??
    null;

  return {
    price,
    sale_price:    salePrice,
    point,
    discount_rate: discountRate,
    is_on_sale:    isOnSale ? 1 : 0,
  };
}

// ─── C: 一覧HTML からRJコード + 価格を同時抽出 ──────────────────────────────

/**
 * C: 一覧ページHTMLからRJコードと価格情報を同時に取得する。
 * detail fetchを節約できる（discovery時に初期価格を保存）。
 *
 * @param {string} html
 * @returns {Array<{ rjCode, price, salePrice, discountRate, isOnSale }>}
 */
function parseWorkListWithPrice(html) {
  try {
    const $    = cheerio.load(html);
    const items = new Map(); // rjCode → priceData

    // 各作品要素をたどる（複数セレクタ戦略）
    const containers = [
      '.work_1col',       // 新着リスト
      '.search_result_img_box_inner', // 検索結果
      'li[data-product_id]',          // data属性ベース
      '.work_img_main',               // ランキング
    ];

    for (const sel of containers) {
      $(sel).each((_, el) => {
        const $el   = $(el);
        const rjRaw = $el.attr('data-product_id')
                   || _findRjInAttr($el, 'href')
                   || _findRjInAttr($el.find('a'), 'href');
        const rj = _extractRj(rjRaw);
        if (!rj || items.has(rj)) return;

        // 価格要素を探す（複数パターン）
        const priceEl    = $el.find('.work_price .work_price_base, .price_base, .work_price:not(.type_sale)').first();
        const salePriceEl = $el.find('.work_price_sale, .price_sale, .work_price.type_sale .price').first();
        const rateEl     = $el.find('.work_discount_rate, .rate_off, [data-discount-rate]').first();

        const price     = _parseJpyText(priceEl.text() || $el.attr('data-price'));
        const salePrice = _parseJpyText(salePriceEl.text() || $el.attr('data-sale_price'));
        const rateRaw   = rateEl.text() || $el.attr('data-discount-rate');
        const discRate  = rateRaw ? _int(rateRaw.replace(/[^0-9]/g, '')) : null;
        const isOnSale  = !!(salePrice || discRate);

        items.set(rj, {
          rjCode:       rj,
          price:        price,
          salePrice:    isOnSale ? salePrice : null,
          discountRate: discRate ?? (price && salePrice ? Math.round((1 - salePrice/price)*100) : null),
          isOnSale,
        });
      });
    }

    // 価格が取れなかったものも RJコードだけ収録（従来の動作を維持）
    $('[data-product_id]').each((_, el) => {
      const rj = _extractRj($(el).attr('data-product_id'));
      if (rj && !items.has(rj)) {
        const priceRaw = _parseJpyText($(el).attr('data-price'));
        const saleRaw  = _parseJpyText($(el).attr('data-sale_price'));
        items.set(rj, {
          rjCode: rj, price: priceRaw, salePrice: saleRaw ?? null,
          discountRate: null, isOnSale: !!(saleRaw),
        });
      }
    });
    $('a[href*="/product_id/RJ"]').each((_, el) => {
      const rj = _extractRj($(el).attr('href'));
      if (rj && !items.has(rj)) {
        items.set(rj, { rjCode: rj, price: null, salePrice: null, discountRate: null, isOnSale: false });
      }
    });

    const result = [...items.values()];
    const withPrice = result.filter(r => r.price !== null).length;
    log.debug('[parser] parseWorkListWithPrice', result.length, 'codes,', withPrice, 'with price');
    return result;
  } catch (err) {
    log.error('[parser] parseWorkListWithPrice error', err.message);
    return [];
  }
}

/** 後方互換: RJコードのみ返す */
function parseWorkList(html) {
  return parseWorkListWithPrice(html).map(r => r.rjCode);
}

function parseRankingList(html) { return parseWorkList(html); }
function parseCircleWorks(html) { return parseWorkList(html); }
function parseSalePage(html)    { return parseWorkListWithPrice(html); }

// ─── helpers ─────────────────────────────────────────────────────────────────

const RJ_PATTERN = /\b(RJ\d{6,8})\b/i;

function _extractRj(str) {
  if (!str) return null;
  const m = str.match(RJ_PATTERN);
  return m ? m[1].toUpperCase() : null;
}

function _findRjInAttr($el, attr) {
  if (!$el || !$el.length) return null;
  const val = $el.first().attr(attr);
  return val ? _extractRj(val) : null;
}

/** "¥1,100" "1100円" → 1100 */
function _parseJpyText(text) {
  if (!text) return null;
  const n = parseInt(String(text).replace(/[^0-9]/g, ''), 10);
  return isNaN(n) || n === 0 ? null : n;
}

function _int(v) {
  if (v === null || v === undefined) return null;
  const n = parseInt(String(v).replace(/[^0-9]/g, ''), 10);
  return isNaN(n) ? null : n;
}

function _str(v) {
  if (v === null || v === undefined) return null;
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
