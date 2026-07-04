'use strict';

/**
 * crawler/parser.js
 * DLsite HTMLからRJコード + 価格を抽出。
 * APIレスポンス（product/info/ajax）をパース。
 */

const cheerio = require('cheerio');
const log     = require('./logger');
const config  = require('../config');

const VALID_SITE_IDS = new Set(config.dlsite.validSiteIds ?? ['maniax', 'girls', 'home', 'bl', 'pro']);

// ─── Product Info API ─────────────────────────────────────────────────────────

function parseProductInfo(rjCode, body) {
  try {
    // APIレスポンスのキーが大文字小文字・ゼロ埋め違いの場合に対応
    const d = body[rjCode]
      ?? body[rjCode.toLowerCase()]
      ?? (() => {
        const upper = rjCode.toUpperCase();
        // ゼロ埋めなし版も試す (RJ01234567 → RJ1234567)
        const nopad = upper.replace(/^RJ0+/, 'RJ');
        for (const k of Object.keys(body)) {
          if (k.toUpperCase() === upper || k.toUpperCase().replace(/^RJ0+/, 'RJ') === nopad) {
            return body[k];
          }
        }
        return undefined;
      })();

    if (!d) {
      log.warn('[parser] key not found', rjCode,
        'available:', Object.keys(body).slice(0, 5).join(', '));
      return null;
    }

    const priceWork = _int(d.price_work);              // 通常価格（DLsite APIの主フィールド）
    const priceCur  = _int(d.price);                   // 現在価格（セール中は値引き後）
    const discRate  = _int(d.discount_rate ?? d.rate); // 割引率 (%)
    // is_sale は "1" (文字列) / 1 (数値) の両方が返る
    const isOnSale  = d.is_sale == 1 || (discRate != null && discRate > 0);

    let price, salePrice, disc = discRate;

    if (isOnSale) {
      if (priceWork && priceCur && priceCur < priceWork) {
        // price_work=通常価格, price=セール価格（両フィールドあり、price<price_work）
        price     = priceWork;
        salePrice = priceCur;
      } else if (priceWork && priceCur && priceCur > priceWork) {
        // price_work=セール価格, price=通常価格（両フィールドあり、price>price_work）
        price     = priceCur;
        salePrice = priceWork;
      } else if (priceWork && discRate && discRate < 100) {
        // price_work のみ + discount_rate あり（price_work はセール後表示価格）
        // ゼロ除算を避ける: discRate < 100 チェック済み
        salePrice = priceWork;
        price     = Math.round(priceWork * 100 / (100 - discRate));
      } else if (priceCur && discRate && discRate < 100) {
        salePrice = priceCur;
        price     = Math.round(priceCur * 100 / (100 - discRate));
      } else {
        // ポイント還元セール等（価格変動なし）
        price     = priceWork ?? priceCur ?? 0;
        salePrice = null;
      }
    } else {
      price     = priceWork ?? priceCur ?? 0;
      salePrice = null;
    }

    // 最終安全チェック: price が null/undefined のときは 0 にする（APIが価格を返さなかった場合）
    if (price == null) price = 0;

    // 割引率が未設定なら price/salePrice から計算
    if (!disc && price && salePrice) {
      disc = Math.round((1 - salePrice / price) * 100);
    }

    // ポイント（dl_point / point_rate / rate_free など複数フィールド名が存在）
    const point = _int(d.point ?? d.dl_point ?? d.point_rate ?? d.dl_point_rate ?? d.rate_review);

    // is_on_sale の区別: discount あり vs ポイント還元のみ
    // discount_rate > 0 なら価格割引セール、そうでなければポイントキャンペーン
    const isPriceDiscount = !!(discRate && discRate > 0);
    const isPointCampaign = isOnSale && !isPriceDiscount;

    // 未使用フィールドをデバッグログに出力（開発/調査用）
    if (isOnSale && !isPriceDiscount) {
      log.debug('[parser] point campaign (no price discount)', rjCode,
        { is_sale: d.is_sale, discount_rate: d.discount_rate, point_rate: d.point_rate,
          dl_point: d.dl_point, price_work: d.price_work, price: d.price });
    }

    return {
      work: {
        rj_code:      rjCode,
        title:        _str(d.work_name  ?? d.name),
        circle:       _str(d.maker_name ?? d.brand_name),
        maker_id:     _str(d.maker_id   ?? d.brand_id),
        work_type:    _str(d.work_type),
        // バグ修正: DLsiteのAPIはURLサイトファミリーとは別の内部分類コード
        // (AI生成作品/スマホアプリ向けと思われる aix/appx 等)を site_id として
        // 返すことがある。これを無検証でそのまま採用すると、毎回のスキャンで
        // 正しいsite_idが上書きされ壊れ続ける。既知のサイトファミリーに
        // 一致しない場合は null を返し、呼び出し側(detailFetcher.js)で
        // 既存DB値の維持 or 'maniax' フォールバックを判断させる。
        site_id:      (() => {
          const raw = _str(d.site_id);
          return raw && VALID_SITE_IDS.has(raw) ? raw : null;
        })(),
        release_date: _str(d.regist_date ?? d.product_date ?? d.sales_date),
        dl_count:     _int(d.dl_count ?? d.down_count),
      },
      price: {
        price,
        sale_price:     salePrice,
        point,
        discount_rate:  disc,
        is_on_sale:     isOnSale ? 1 : 0,
        is_point_only:  isPointCampaign ? 1 : 0,
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

      const $el = $(el);

      // 価格
      const price  = _jpyText($el.attr('data-price'))
                  ?? _jpyText($('.work_price', el).first().text());
      const salePr = _jpyText($el.attr('data-sale_price'))
                  ?? _jpyText($('.work_price_sale, .work_price.type_sale', el).first().text());

      // タイトル
      const title = _str(
        $el.attr('data-title') ??
        $el.attr('data-work_name') ??
        ($('.work_name a, .dl_title a, dt.work_name a', el).first().text() || null) ??
        ($('a[title]', el).first().attr('title') || null)
      );

      // サークル / メーカー
      const circle = _str(
        $el.attr('data-maker') ??
        $('.maker_name a, .circle_name a, .brand_name a', el).first().text()
      );
      const makerId = _str(
        $el.attr('data-maker_id') ??
        (() => {
          const href = $('.maker_name a, .circle_name a', el).first().attr('href') ?? '';
          const m = href.match(/maker_id\/([^\/]+)/);
          return m ? m[1] : null;
        })()
      );

      // 作品種別 (audio / game / manga / etc.)
      const workType = _str(
        $el.attr('data-work_type') ??
        $el.find('.work_type, .icon_work_type').first().attr('data-value') ??
        $el.find('[class*="type_"]').first().attr('class')?.match(/type_(\w+)/)?.[1]
      );

      // 発売日
      const releaseDate = _str(
        $el.attr('data-regist_date') ??
        $el.attr('data-sales_date') ??
        $('.work_date, .date_text', el).first().text()
      );

      found.set(rj, { ..._priceObj(rj, price, salePr), title, circle, makerId, workType, releaseDate });
    });

    // ── 方法2: href に /product_id/RJ ──
    $('a[href*="/product_id/RJ"]').each((_, el) => {
      const rj = _rj($(el).attr('href'));
      if (rj && !found.has(rj)) {
        found.set(rj, { ..._priceObj(rj, null, null), title: null, circle: null, makerId: null, workType: null, releaseDate: null });
      }
    });

    // ── 方法3: メインコンテンツ領域のみ RJ コードをスキャン（サイドバー除外）──
    // サイドバー・レコメンド等ノイズを減らすため、コンテンツ本体に絞る
    const mainContent =
      $('ul.work_1col_item, .search_result_img_box_inner, #search_result_list, .work_list_main, .work_1col, main, #main').html()
      || $.html();  // 特定できない場合は全体にフォールバック

    const hits = mainContent.match(/\bRJ\d{6,8}\b/gi) ?? [];
    for (const h of hits) {
      const rj = h.toUpperCase();
      if (!found.has(rj)) {
        found.set(rj, { ..._priceObj(rj, null, null), title: null, circle: null, makerId: null, workType: null, releaseDate: null });
      }
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
