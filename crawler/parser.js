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

    // ── 価格情報の優先ソース: discount オブジェクト / official_price ──────────
    // 価格取得精度の改善: 従来はprice_work/price/discount_rateの大小関係のみから
    // 「どちらが定価でどちらがセール価格か」を推測していたが、DLsiteのAPI構造の
    // 調査(dlsite-rs等、公開されているクライアント実装の解析結果)によると、
    // 推測を必要としないより直接的なフィールドが別途存在する:
    //   discount.campaign_price = 現在のセール価格そのもの
    //   discount.restore_price  = セール終了後に「復元」される定価そのもの
    //   official_price / regular_price = セールの有無に関わらない定価そのもの
    //   is_discount_work = セール中かどうかの明示フラグ（is_saleより直接的）
    // これらが利用できる場合は、下のprice_work等による推測ロジックより優先して
    // 使う。存在しない/想定と異なる場合は安全に既存ロジックへフォールバックする
    // (このプロジェクトではAPI応答の全フィールドを継続的に検証できないため、
    // 新フィールドは「使えるときだけ使う」形にして既存の実績あるロジックを
    // 壊さないようにしている)。
    const discObj        = (d.discount && typeof d.discount === 'object') ? d.discount : null;
    const campaignPrice  = _int(discObj?.campaign_price);
    const restorePrice   = _int(discObj?.restore_price);
    const officialPrice  = _int(d.official_price ?? d.regular_price);
    const isDiscountFlag = d.is_discount_work === true || d.is_discount_work === 1 || d.is_discount_work === '1';

    const priceWork = _int(d.price_work);              // 通常価格（DLsite APIの主フィールド、経験則）
    const priceCur  = _int(d.price);                   // 現在価格（セール中は値引き後）
    const discRate  = _int(d.discount_rate ?? d.rate); // 割引率 (%)
    // is_sale は "1" (文字列) / 1 (数値) の両方が返る
    const isOnSale  = isDiscountFlag || d.is_sale == 1 || (discRate != null && discRate > 0)
      || (campaignPrice != null && restorePrice != null && campaignPrice < restorePrice);

    let price, salePrice, disc = discRate;
    let priceIssue = null; // { type, raw } — 定価が信頼できなかった場合にセットされる

    if (isOnSale && campaignPrice != null && restorePrice != null && campaignPrice < restorePrice) {
      // 最優先: discountオブジェクトが直接示す「セール価格」と「復元後の定価」。
      // DLsite自身が管理する値であり、他フィールドの大小関係を見て推測する
      // 必要が無いため最も確実。
      price     = restorePrice;
      salePrice = campaignPrice;
    } else if (isOnSale && officialPrice != null && priceCur != null && priceCur < officialPrice) {
      // 次点: 公式定価フィールド(official_price/regular_price)と現在価格の比較。
      // price_workのような経験則由来のフィールドより公式性が高い。
      price     = officialPrice;
      salePrice = priceCur;
    } else if (isOnSale) {
      if (priceWork != null && priceCur != null && priceCur < priceWork) {
        // price_work=通常価格, price=セール価格（両フィールドあり、price<price_work）
        price     = priceWork;
        salePrice = priceCur;
      } else if (priceWork != null && priceCur != null && priceCur > priceWork) {
        // price_work=セール価格, price=通常価格（両フィールドあり、price>price_work）
        price     = priceCur;
        salePrice = priceWork;
      } else if (priceWork != null && discRate != null && discRate > 0 && discRate < 100) {
        // price_work のみ + discount_rate あり（price_work はセール後表示価格）
        // ゼロ除算を避ける: discRate < 100 チェック済み
        salePrice = priceWork;
        price     = Math.round(priceWork * 100 / (100 - discRate));
      } else if (priceCur != null && discRate != null && discRate > 0 && discRate < 100) {
        salePrice = priceCur;
        price     = Math.round(priceCur * 100 / (100 - discRate));
      } else if (officialPrice != null) {
        // price_workは無いが公式定価フィールド(official_price/regular_price)は
        // ある。price_curとの差が取れないため割引額は不明扱いだが、定価の値
        // 自体はofficial_priceの方がprice_workより信頼できるため、ambiguous
        // 分岐へ流す前にこちらを優先する。
        price     = officialPrice;
        salePrice = (priceCur != null && priceCur !== officialPrice) ? priceCur : null;
        if (salePrice == null) {
          priceIssue = { type: 'ambiguous', raw: { official_price: d.official_price, regular_price: d.regular_price, price: d.price, discount_rate: d.discount_rate, is_sale: d.is_sale } };
          log.warn('[parser] price ambiguous: on-sale flag set but no usable discount fields (official_price fallback)', rjCode, priceIssue.raw);
        }
      } else if (priceWork != null) {
        // price_work(通常価格らしきフィールド)はあるが、セール価格側の
        // 手がかりが無い(price_curが同額 or discRateが不使用)。
        // price_workを定価として信頼し、割引額は不明として扱う。
        price     = priceWork;
        salePrice = (priceCur != null && priceCur !== priceWork) ? priceCur : null;
        if (salePrice == null) {
          priceIssue = { type: 'ambiguous', raw: { price_work: d.price_work, price: d.price, discount_rate: d.discount_rate, is_sale: d.is_sale } };
          log.warn('[parser] price ambiguous: on-sale flag set but no usable discount fields', rjCode, priceIssue.raw);
        }
      } else if (priceCur != null) {
        // バグ修正(③): 旧実装はここに来た時点で無条件に「price_work欠損＝定価不明」
        // として priceIssue を記録していたが、discRate(discount_rate)の判定順序上、
        // このブランチに到達する時点で discRate は必ず 0/null である
        // (discRate>0かつ<100のケースは上の分岐で既に処理済みのため)。
        // つまりここに来る is_sale=true は「実際の値引きは無いポイント還元
        // キャンペーン等」であることがほとんどで、price_workが存在しないのは
        // 欠損ではなく「割引額という概念が無いので最初から返らない」という
        // 正常な仕様である可能性が高い。この場合 priceCur は普通に定価そのもの
        // であり、priceIssueとして記録するのは誤検知（dataブランチ実測で
        // 全price_issuesの約1割・5万件がこのケースに該当していた）。
        // discRateが未設定/0のときは正常な「定価そのもの」として扱い、
        // 万一discRateが100以上(全額ポイント還元/無料配布等の異常値)のときのみ
        // 真に定価不明としてpriceIssueに記録する。
        price     = priceCur;
        salePrice = null;
        if (discRate != null && discRate >= 100) {
          priceIssue = { type: 'price_work_missing_high_discount', raw: { price_work: d.price_work, price: d.price, discount_rate: d.discount_rate, is_sale: d.is_sale } };
          log.warn('[parser] price_work missing with discount_rate>=100 — price unreliable', rjCode, priceIssue.raw);
        }
      } else if (officialPrice != null || campaignPrice != null || restorePrice != null) {
        // price_work/priceともに欠損だが、official_price/regular_priceや
        // discountオブジェクトの断片(campaign_price/restore_priceのどちらか
        // 一方のみ等)は残っている場合の最終手段。0円で上書きするよりは、
        // 得られる中で最も定価らしい値を使う方が実害が小さい。
        price     = officialPrice ?? restorePrice ?? campaignPrice;
        salePrice = null;
        priceIssue = { type: 'ambiguous', raw: { official_price: d.official_price, regular_price: d.regular_price, discount: discObj, price_work: d.price_work, price: d.price } };
        log.warn('[parser] price_work/price欠損だがofficial_price等から代替', rjCode, priceIssue.raw);
      } else {
        price     = 0;
        salePrice = null;
        priceIssue = { type: 'no_price_field', raw: { price_work: d.price_work, price: d.price, official_price: d.official_price, regular_price: d.regular_price } };
        log.warn('[parser] no usable price field at all', rjCode, priceIssue.raw);
      }
    } else {
      // セール中でない場合も、price_workより公式性の高いofficial_price/
      // regular_priceが使えるなら優先する。
      price     = officialPrice ?? priceWork ?? priceCur ?? 0;
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
    // 精度改善: 生のAPIフィールドdiscRateではなく、上のロジックで確定した
    // 最終的なdisc(price/salePriceの差分から事後計算された場合を含む)を見る。
    // discRateだけを見ると「discount_rateフィールドは返らないが、price_work
    // (またはofficial_price)とpriceに実際の価格差がある」ケースを、値引きが
    // 無いポイント還元キャンペーンと誤分類してしまう。
    const isPriceDiscount = !!(disc && disc > 0);
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
      priceIssue,
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
