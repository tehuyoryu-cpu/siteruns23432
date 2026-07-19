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
const { pushDebugBundle } = require('../scripts/pushDebugBundle');

const BASE = config.dlsite.baseUrl;
const RL   = config.fetch.rateLimit;

// バグ修正: アプリ終了時に discovery ループを安全に止める手段が無かった。
// detailFetcher.js の isAborted() と同じパターンで global._crawlerAbort.discovery を
// 各ループの先頭でチェックする(electron-main.js の graceful shutdown から利用される)。
function _discoveryAborted() {
  return !!global._crawlerAbort?.discovery;
}

// バグ修正: サークル単位の作品一覧取得に、これまで /fsr/=/maker_id/{id}/... という
// 汎用検索エンドポイント(fsr)のURLを使っていたが、実際にDLsiteで検証したところ
// fsrはmaker_idを filter として認識しておらず、指定したmaker_idに関係なく
// サイトごとに同じ汎用一覧(新着順など)を返していた(circleGapScanのmaker_id
// 不一致検証で確定)。正しくは /circle/profile/=/.../maker_id/{id}.html という
// 専用のサークルプロフィールページを使う必要がある。
//
// 追加バグ修正: 上記で切り替えた専用ページも、2ページ目以降が取得できない
// 不具合が発覚した。ユーザーが実機(スマホ版)で確認した実際のページ2の
// URLと比較したところ、パラメータの並び順・構造自体は一致していたが、
// サイトパス部分が `{site}` ではなく `{site}-touch` （モバイル版）だった。
// デスクトップ版の /circle/profile/ は page パラメータを正しく反映しない
// （または無視する）とみられ、モバイル版のエンドポイントが本来使うべき
// 正しいURLだった。
const _LANG_JP   = '%E6%97%A5%E6%9C%AC%E8%AA%9E';       // 日本語
const _LANG_NONE = '%E8%A8%80%E8%AA%9E%E4%B8%8D%E8%A6%81'; // 言語不要

function _circleProfileUrl(site, makerId, page) {
  return `${BASE}/${site}-touch/circle/profile/=/order%5B0%5D/release_d/options%5B0%5D/JPN/options%5B1%5D/NM/per_page/100/show_type/3/hd/1/lang_options%5B0%5D/${_LANG_JP}/lang_options%5B1%5D/${_LANG_NONE}/page/${page}/maker_id/${makerId}.html`;
}

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

  let page = 1, count = 0, consecutiveShort = 0, failCount = 0;
  while (true) {
    if (_discoveryAborted()) { log.warn('[discovery] monthly aborted', { site, date, page }); break; }
    const pagePart = page === 1 ? '' : `/page/${page}`;
    const url = tmpl.replace('{date}', date).replace('{page}', pagePart);
    const items = await _fetchWithPrice(url);

    if (!items.length) {
      // 「本当に空」と「一時的な取得失敗」を区別し、失敗ならページを進めずに再試行する
      if (items.failed) {
        failCount++;
        if (failCount >= 3) {
          log.error('[discovery] monthly: 取得失敗が続いたため打ち切ります', { site, date, page, failCount });
          break;
        }
        log.warn('[discovery] monthly: 取得失敗、同じページを再試行します', { site, date, page, failCount });
        await sleep(config.fetch.rateLimit * 2);
        continue;
      }
      break;
    }
    failCount = 0;

    count += _upsert(items, site, knownRjs);
    log.info('[discovery] monthly', { site, date, page, parsed: items.length, newAdded: count });
    // 100件未満は通常「最終ページ」の合図だが、一時的な取得失敗/パース漏れで
    // 途中のページがたまたま短くなることがある。1回だけなら疑って継続し、
    // 2回連続で短ければ本当に終わりと判断する。
    if (items.length < 100) {
      consecutiveShort++;
      if (consecutiveShort >= 2) break;
      log.warn('[discovery] monthly: 疑わしい短ページ、次ページで確認します', { site, date, page, parsed: items.length });
    } else {
      consecutiveShort = 0;
    }
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
    if (_discoveryAborted()) { log.warn('[discovery] fullScan aborted (before site)', { site }); break; }
    const baseUrl = sale ? urls.sale : urls.all;
    if (!baseUrl) continue;

    let page = 1, siteTotal = 0, consecutiveShort = 0, failCount = 0;

    while (true) {
      if (_discoveryAborted()) { log.warn('[discovery] fullScan aborted', { site, page }); break; }
      if (maxPages > 0 && page > maxPages) break;

      // page=1はURLに/page/1を含まないDLsiteの仕様に対応
      const url   = page === 1
        ? baseUrl.replace(/\/page\/\{page\}/, '')
        : baseUrl.replace('{page}', String(page));
      const items = await _fetchWithPrice(url);

      if (!items.length) {
        // バグ修正: 「本当に空(=カタログの終わり)」と「一時的な取得失敗」を区別する。
        // 失敗の場合はページを進めずに最大3回まで再試行し、それでもダメなら
        // 諦めてそのサイトの巡回を打ち切る（誤って「完了」扱いにしないよう
        // failedとして明示的にログを残す）。
        if (items.failed) {
          failCount++;
          if (failCount >= 3) {
            log.error('[discovery] fullScan: 取得失敗が続いたため打ち切ります', { site, page, failCount });
            break;
          }
          log.warn('[discovery] fullScan: 取得失敗、同じページを再試行します', { site, page, failCount });
          await sleep(RL * 2);
          continue;   // page を進めずに同じURLを再取得
        }
        log.info('[discovery] fullScan end', { site, page, reason: 'empty page' });
        break;
      }
      failCount = 0;

      const added = _upsert(items, site, knownRjs);
      siteTotal += added;
      grandTotal += added;

      if (onProgress) onProgress({ site, page, found: added, total: siteTotal });
      log.info('[discovery] fullScan', { site, page, parsed: items.length, added, total: siteTotal });

      // バグ修正: 以前は100件未満のページに遭遇した瞬間に「最終ページ」と
      // 断定して打ち切っていた。しかし一時的な取得失敗/パース漏れ/スロットリング
      // で途中のページがたまたま100件未満になることがあり、そのまま巡回全体が
      // 数十万件分残したまま停止してしまう（実際に15万件付近で止まる報告あり）。
      // 100件未満は1回だけなら「疑わしい」として次ページで確認を続け、
      // 2回連続で短ければ本当に最終ページと判断する。
      if (items.length < 100) {
        consecutiveShort++;
        if (consecutiveShort >= 2) {
          log.info('[discovery] fullScan end', { site, page, reason: 'confirmed short page x2' });
          break;
        }
        log.warn('[discovery] fullScan: 疑わしい短ページを検出、次ページで確認します', { site, page, parsed: items.length });
      } else {
        consecutiveShort = 0;
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
    if (_discoveryAborted()) { log.warn('[discovery] collectCircles aborted', { processed: i, total: toCheck.length }); break; }
    const chunk = toCheck.slice(i, i + CONC);
    const results = await Promise.all(
      chunk.flatMap(mid =>
        config.dlsite.sites.map(async site => {
          const url   = _circleProfileUrl(site, mid, 1);
          const items = await _fetchWithPrice(url);
          // 検証: maker_idフィルタが本当に効いているか確認する(circleGapScanと同じ理由)。
          // 効いていない場合、要求したサークルと無関係な一般カタログpage相当を
          // 「このサークルの新着」として誤集計してしまうため、確定次第スキップする。
          const mismatched = items.filter(it => it.makerId && it.makerId !== mid).length;
          if (items.length > 0 && mismatched / items.length > 0.5) {
            log.error('[discovery] collectCircles: maker_idフィルタが機能していません(確定)。スキップします', {
              makerId: mid, site, mismatched, totalOnPage: items.length,
            });
            return 0;
          }
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

// バグ修正: 従来は「本当にページが空(=カタログの終わり)」と「一時的な取得失敗
// (ネットワーク断・リトライ枯渇等)」の両方を同じ空配列[]で返しており、呼び出し側は
// 区別できなかった。多ページ走査の途中でこれが起きると、実際にはまだ続きがある
// のに「終わり」と誤判定して巡回を打ち切ってしまう。配列に .failed フラグを
// 付与することで、既存の「items.length で判定するだけ」の呼び出し元との
// 後方互換を保ったまま、区別したい箇所だけ items.failed を見られるようにする。
const _404_CONFIRM_RETRIES = 2;      // 404を「確定終端」と判断するまでの再確認回数
const _404_CONFIRM_DELAY   = 1500;   // 再確認の間隔(ms)。回数ごとに線形に伸ばす

async function _fetchWithPrice(url) {
  try {
    const res = await fetchWithRetry(url);
    if (res.status === 404) {
      // バグ修正: サークルプロフィールページ(/circle/profile/=/...)は、ページ番号が
      // 実際の範囲を超えると200+空リストではなく404を返す仕様だった。これを
      // 「取得失敗」として3回リトライしていたため、1ページで収まる大多数の
      // サークルで毎回無駄なリトライ(数十秒)とERRORログが発生していた。
      // 404は「確定的にもう先がない」ことを示す正常なシグナルとして扱う
      // (.failedは付けない = 呼び出し側は空ページとして扱い、即座に完了と判断する)。
      //
      // 追加バグ修正: 上記は「範囲外は必ず404」という仕様を信頼した実装だったが、
      // 単発の404を無条件に「確定終端」と信じてしまうと、一時的なサーバー不調や
      // WAF等の瞬断でたまたま404が返ったケースまで「もう先がない」と誤判定し、
      // 本来まだ存在するはずの後続ページ(=作品)を丸ごと欠落させたまま
      // 正常終了扱いになってしまう(取得失敗とは違いエラーログにも残らないため
      // 発覚しにくい)。少し間隔を空けて数回だけ再確認し、それでも404が続く
      // 場合にのみ確定的な終端として扱う。再確認中にデータが返ってきた場合は
      // 「一時的な404だった」とみなしそのデータを採用する。
      return await _confirm404(url);
    }
    if (!res.ok) {
      log.warn('[discovery] fetch non-200', res.status, url);
      const arr = [];
      arr.failed = true;
      return arr;
    }
    const html = await res.text();
    return parser.parseWorkListWithPrice(html);   // 成功時は .failed は undefined(falsy)
  } catch (e) {
    log.error('[discovery] fetch error', url, e.message);
    const arr = [];
    arr.failed = true;
    return arr;
  }
}

/**
 * 404を受け取った際に、それが「本当に範囲外(確定終端)」なのか
 * 「一時的な瞬断でたまたま404が返っただけ」なのかを短い間隔を空けて再確認する。
 * - 再確認で404以外の応答が返れば、その結果をそのまま採用する(終端ではなかった)
 * - 再確認でも404が続けば、確定終端として空配列(.failedなし)を返す
 * - 再確認中にネットワークエラー等が起きた場合は「まだ確定していない」として
 *   再確認を続け、全て試しても確証が得られなければ確定終端扱いにフォールバックする
 *   (無限に粘り続けて巡回全体を止めてしまわないようにするため)
 */
async function _confirm404(url) {
  for (let i = 0; i < _404_CONFIRM_RETRIES; i++) {
    await sleep(_404_CONFIRM_DELAY * (i + 1));
    let res;
    try {
      res = await fetchWithRetry(url);
    } catch (e) {
      log.warn('[discovery] 404confirm: retry fetch error, continuing to confirm', url, e.message);
      continue;
    }
    if (res.status === 404) continue; // まだ404 → もう1回確認へ

    // 404以外が返ってきた = 単発の瞬断だった可能性が高い
    if (res.ok) {
      log.warn('[discovery] 404 was transient, recovered on confirm retry', url);
      const html = await res.text();
      return parser.parseWorkListWithPrice(html);
    }
    log.warn('[discovery] 404confirm: non-404 non-ok response', res.status, url);
    const arr = [];
    arr.failed = true;
    return arr;
  }
  log.info('[discovery] 404 confirmed after retries (end of pages)', url);
  return [];
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
    if (_discoveryAborted()) { log.warn('[discovery] endingSoonScan aborted (before site)', { site }); break; }
    const baseUrl = urls.soon;
    if (!baseUrl) continue;

    let page = 1, siteTotal = 0, consecutiveShort = 0, failCount = 0;

    while (true) {
      if (_discoveryAborted()) { log.warn('[discovery] endingSoonScan aborted', { site, page }); break; }
      // page=1はURLに/page/1を含まないDLsiteの仕様に対応
      const url = page === 1
        ? baseUrl.replace(/\/page\/\{page\}/, '')
        : baseUrl.replace('{page}', String(page));
      const items = await _fetchWithPrice(url);

      if (!items.length) {
        if (items.failed) {
          failCount++;
          if (failCount >= 3) {
            log.error('[discovery] endingSoonScan: 取得失敗が続いたため打ち切ります', { site, page, failCount });
            break;
          }
          log.warn('[discovery] endingSoonScan: 取得失敗、同じページを再試行します', { site, page, failCount });
          await sleep(RL * 2);
          continue;
        }
        log.info('[discovery] endingSoonScan end', { site, page });
        break;
      }
      failCount = 0;

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

      // 100件未満は1回だけなら疑って継続し、2回連続で短ければ最終ページと判断する
      // (詳細は runFullScan 側の同様の修正コメント参照)
      if (items.length < 100) {
        consecutiveShort++;
        if (consecutiveShort >= 2) {
          log.info('[discovery] endingSoonScan end', { site, page, reason: 'confirmed short page x2' });
          break;
        }
        log.warn('[discovery] endingSoonScan: 疑わしい短ページ、次ページで確認します', { site, page, parsed: items.length });
      } else {
        consecutiveShort = 0;
      }

      page++;
      await sleep(RL);
    }

    sites[site] = siteTotal;
  }

  log.info('[discovery] endingSoonScan done', { grandTotal, newCount, boostedCount, ...sites });
  return { grandTotal, newCount, boostedCount, sites };
}

// ─── 新作収集(過去1年以内・割引条件なし) ─────────────────────────────────────
// runEndingSoonScan(割引終了間近収集)から「割引条件(campaign/campaign)」と
// 「24時間以内に終了(soon/1)」の2条件を外し、代わりに regist_date_start で
// 発売日を絞り込んだもの。割引の有無を問わず、直近1年以内に発売された全作品を
// FSR全ページ走査で収集する。endingSoonScanと異なり優先度のブースト(urgent化)は
// 行わない — あくまで「取りこぼしていた新作をDBに登録する」ための収集ジョブ。

/** 1年前の日付文字列を返す (YYYY-MM-DD) */
function _oneYearAgo() {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function runNewReleaseScan({ onProgress = null } = {}) {
  const sinceDate = _oneYearAgo();
  log.info('[discovery] newReleaseScan start', { sinceDate });

  const knownRjs = _loadKnown();
  const fsrUrls  = config.dlsite.fsrUrls ?? {};

  let grandTotal = 0;
  const sites = {};

  for (const [site, urls] of Object.entries(fsrUrls)) {
    if (_discoveryAborted()) { log.warn('[discovery] newReleaseScan aborted (before site)', { site }); break; }
    const tmpl = urls.newRelease;
    if (!tmpl) continue;

    let page = 1, siteTotal = 0, consecutiveShort = 0, failCount = 0;

    while (true) {
      if (_discoveryAborted()) { log.warn('[discovery] newReleaseScan aborted', { site, page }); break; }

      // page=1はURLに/page/1を含まないDLsiteの仕様に対応(runFullScanと同じパターン)
      let url = tmpl.replace('{date}', sinceDate);
      url = page === 1 ? url.replace(/\/page\/\{page\}/, '') : url.replace('{page}', String(page));
      const items = await _fetchWithPrice(url);

      if (!items.length) {
        if (items.failed) {
          failCount++;
          if (failCount >= 3) {
            log.error('[discovery] newReleaseScan: 取得失敗が続いたため打ち切ります', { site, page, failCount });
            break;
          }
          log.warn('[discovery] newReleaseScan: 取得失敗、同じページを再試行します', { site, page, failCount });
          await sleep(RL * 2);
          continue;
        }
        log.info('[discovery] newReleaseScan end', { site, page });
        break;
      }
      failCount = 0;

      const added = _upsert(items, site, knownRjs);
      siteTotal  += added;
      grandTotal += added;

      if (onProgress) onProgress({ site, page, found: added, total: siteTotal });
      log.info('[discovery] newReleaseScan', { site, page, parsed: items.length, added, total: siteTotal });

      // 100件未満は1回だけなら疑って継続し、2回連続で短ければ最終ページと判断する
      if (items.length < 100) {
        consecutiveShort++;
        if (consecutiveShort >= 2) {
          log.info('[discovery] newReleaseScan end', { site, page, reason: 'confirmed short page x2' });
          break;
        }
        log.warn('[discovery] newReleaseScan: 疑わしい短ページを検出、次ページで確認します', { site, page, parsed: items.length });
      } else {
        consecutiveShort = 0;
      }

      page++;
      await sleep(RL);
    }

    sites[site] = siteTotal;
  }

  log.info('[discovery] newReleaseScan done', { grandTotal, ...sites });
  return { grandTotal, sites };
}

// ─── サークル単位の欠落診断 ──────────────────────────────────────────────────
// 通常のdiscoveryは「今月分」+「直近未チェック30サークル」しか見ないため、
// 何らかの理由（bl の all/sale URL 未定義だった期間、アプリ停止中のリリース等）で
// 一度も収集対象にならなかったRJが既知サークル内に埋もれている可能性がある。
// 既知の全サークル(maker_id)についてDLsite上の全作品ページを走査し、
// DBに存在しないRJコードを正確に検出・登録する。
//
// 改修: 全サークルを毎回同じ順序（先頭から）で走査していたため、
//   - limit指定時は毎回同じ先頭N件しかチェックされず、それ以降のサークルには
//     永遠に手が届かなかった
//   - 中止ボタンや異常終了で中断すると、次回実行時も先頭からやり直しになり、
//     既にチェック済みだった大量のサークルを再度なぞる無駄が発生していた
//     （circlegapは1サークルあたり複数ページ・数百msのレート制限待ちを伴う
//     重い処理で、"時間がかかります"と案内しているだけに影響が大きい）
// circles.last_gap_checked（最後にこの診断でチェックした時刻）を基準に
// 「未チェック/最も古くチェックされたサークル」から優先的に対象とすることで、
// 中断・再開・limit指定のいずれでも自然に全サークルをローテーションし、
// 一度全サークルを一巡した後も継続的な再検証として機能するようにした
// （getDueWorksのnext_check_atと同じ考え方）。

/**
 * @param {number|null} limit  診断するサークル数の上限（null=全サークル）
 */
async function runCircleGapScan({ onProgress = null, limit = null } = {}) {
  log.info('[discovery] circleGapScan start', { limit: limit ?? 'all' });

  // バグ修正: getMakerSiteMap()はconfig.dlsite.validSiteIds(5種、home/pro含む)基準で
  // site_idの妥当性を見ているが、実際に年齢確認(warmUpSession)を通しているのは
  // config.dlsite.sites(maniax/bl/girlsの3種)だけ。site_idが'home'/'pro'等の
  // 未ウォームアップサイトになっているサークルをそのまま巡回すると、年齢確認未通過
  // による空応答症状が再発しうる。実際に巡回可能なサイトだけに絞る。
  const activeSites = new Set(config.dlsite.sites ?? ['maniax', 'girls', 'bl']);

  const makerSitesRaw = db.getMakerSiteMap();   // Map<maker_id, site_id>（無効なsite_idのサークルは含まれない）
  const allMakerIds   = db.getAllMakerIds();
  const makerSites = new Map([...makerSitesRaw].filter(([, site]) => activeSites.has(site)));
  const skippedInvalidSite = allMakerIds.filter(m => !makerSites.has(m)).length;
  if (skippedInvalidSite > 0) {
    log.warn('[discovery] circleGapScan: site_id不明/巡回対象外のためスキップしたサークル', { count: skippedInvalidSite });
  }

  // 最後にチェックした時刻の昇順（未チェック=0が先頭）でソートしてから
  // limitを適用する。これにより中断/再開/limit指定のいずれでも
  // 「まだ見ていないサークル」から確実に消化していく。
  const gapCheckedMap = db.getCircleGapCheckedMap();
  let makerIds = [...makerSites.keys()].sort((a, b) =>
    (gapCheckedMap.get(a) ?? 0) - (gapCheckedMap.get(b) ?? 0));
  const resumedCount = makerIds.filter(id => (gapCheckedMap.get(id) ?? 0) > 0).length;
  if (limit) makerIds = makerIds.slice(0, limit);

  const knownRjs = _loadKnown();
  let checked = 0;
  let totalMissing = 0;
  const missingByCircle = {};

  // バグ修正: 以前は1サークルの走査が完了するたびにしか onProgress を呼んでおらず、
  // (1) ループ開始直後〜1サークル目完了まで total が一度も通知されずUIに「?」と表示され続ける
  // (2) 1サークル内が複数ページ・リトライ等で時間がかかっても進捗がまったく更新されず、
  //     UIが固まって見える
  // という2つの問題があった。ループ開始前に総数を即時通知し、ページ単位でも
  // 進捗を通知するようにする。
  if (onProgress) onProgress({ checked: 0, total: makerIds.length, totalMissing: 0, makerId: null, site: null });
  log.info('[discovery] circleGapScan targets', {
    total: makerIds.length, skippedInvalidSite,
    resuming: resumedCount > 0, alreadyCheckedBefore: resumedCount,
  });

  // 以前はここに「50ページ/missing150件で打ち切り」という上限があった。
  // これはmaker_idフィルタが壊れている可能性を疑っての安全弁だったが、
  // 直接検証(下記のmakerId不一致チェック)により実際にはフィルタは正常に
  // 機能しており、上限に達していたサークル(RG01000107等)は本当にそれだけの
  // 作品数を持つ実在の巨大サークルだったと確定した。
  //
  // circlegapは「待っていても二度と収集されない過去の取りこぼしを掘り起こす」
  // ためのツールであり、巨大サークルほど取りこぼしが残りやすい。上限で
  // 打ち切ってしまうとその目的に反するため撤廃し、真の無限ループ対策として
  // 現実的にあり得ない水準の上限(1000ページ=10万作品/サークル)だけを
  // 最終防波堤として残す。
  const MAX_PAGES_PER_CIRCLE = 1000;

  async function _scanOneCircle(makerId, site) {
    let circleMissing = 0;
    let abortedThisCircle = false;
    try {
      // maker_id 単位のFSR全ページを走査（per_page=100、page1は/page/{page}を省略）
      let page = 1, consecutiveShort = 0, failCount = 0;
      while (true) {
        if (_discoveryAborted()) {
          log.warn('[discovery] circleGap aborted', { makerId, site, page });
          abortedThisCircle = true;   // 中断: このサークルは未完了のまま次回に持ち越す（checked済みにしない）
          break;
        }
        if (page > MAX_PAGES_PER_CIRCLE) {
          log.error('[discovery] circleGap: ページ数が異常上限(1000)に到達、打ち切り(要調査)', { makerId, site, page, circleMissing });
          break;
        }

        const url = _circleProfileUrl(site, makerId, page);
        const items = await _fetchWithPrice(url);

        if (!items.length) {
          // バグ修正: 「本当に空(=このサークルの最終ページ)」と「一時的な取得失敗」を
          // 区別する。失敗の場合はページを進めずに最大3回まで再試行する。
          if (items.failed) {
            failCount++;
            if (failCount >= 3) {
              log.error('[discovery] circleGap: 取得失敗が続いたため打ち切ります', { makerId, site, page, failCount });
              break;
            }
            log.warn('[discovery] circleGap: 取得失敗、同じページを再試行します', { makerId, site, page, failCount });
            await sleep(RL * 2);
            continue;
          }
          break;
        }
        failCount = 0;

        // 検証: DLsiteのmaker_idフィルタが本当に効いているかを直接確認する。
        // これまでは「missing件数が異常に多い」という間接的な兆候でしか
        // フィルタ異常を疑えなかったが、parser.jsは各作品の実際のmakerIdも
        // 返しているため、要求したmakerIdと実際のmakerIdを直接比較できる。
        // 半数以上が別サークルの作品であれば、フィルタが機能しておらず
        // 実質カタログ全体(またはそれに近いもの)を返していると確定できる。
        const mismatched = items.filter(i => i.makerId && i.makerId !== makerId).length;
        if (items.length > 0 && mismatched / items.length > 0.5) {
          log.error('[discovery] circleGap: maker_idフィルタが機能していません(確定)。このサークルをスキップします', {
            makerId, site, page, mismatched, totalOnPage: items.length,
            sampleOtherMakerId: items.find(i => i.makerId && i.makerId !== makerId)?.makerId,
          });
          break;
        }

        // バグ修正: 以前はサークル内の全ページを走査し終えてから最後にまとめて
        // _upsert していたため、途中で例外が起きるとそれまでのページ分の欠落発見が
        // 丸ごと失われていた。ページごとに即座に保存するようにする。
        const missingOnPage = items.filter(item => item.rjCode && !knownRjs.has(item.rjCode));
        if (missingOnPage.length) {
          const added = _upsert(missingOnPage, site, knownRjs);
          if (added > 0) {
            circleMissing += added;
            missingByCircle[makerId] = (missingByCircle[makerId] ?? 0) + added;
            totalMissing += added;
            log.warn('[discovery] circleGap found missing works', { makerId, site, page, missing: added });
          }
        }

        // ページ単位の途中経過通知（サークル内訳: 現在何ページ目まで進んだか）
        if (onProgress) {
          onProgress({ checked, total: makerIds.length, totalMissing, makerId, site, page });
        }

        // 100件未満は1回だけなら疑って継続し、2回連続で短ければ最終ページと判断する
        if (items.length < 100) {
          consecutiveShort++;
          if (consecutiveShort >= 2) break;
        } else {
          consecutiveShort = 0;
        }
        page++;
        await sleep(RL);
      }
    } catch (err) {
      // バグ修正: 以前は1サークルの取得でエラー(ネットワーク断・リトライ枯渇等)が
      // 起きると例外がここまで伝播し、それまでの進捗を保持したまま診断ジョブ全体が
      // 異常終了していた(「サークル診断が続かない」の主因)。1サークル分をスキップして
      // 次に進むようにする。
      log.error('[discovery] circleGap: サークル処理中にエラー、スキップして続行します', { makerId, site, error: err.message });
    }

    // 中断（ユーザーが停止ボタンを押した等）の場合は未完了のまま次回に持ち越し、
    // それ以外（正常完了・エラーによるスキップ問わず）は「この巡回サイクルで
    // チェック済み」として記録する。次回実行時は未チェック/最も古いサークルから
    // 優先されるため、同じ壊れたサークルに毎回時間を浪費することも避けられる。
    if (!abortedThisCircle) db.markCircleGapChecked(makerId);

    checked++;
    if (onProgress) onProgress({ checked, total: makerIds.length, totalMissing, makerId, site });
  }

  // work-stealing方式のワーカープール（detailFetcher.jsと同じパターン）。
  // 1ワーカー=1サークルを丸ごと担当し、終わり次第キューから次のmaker_idを取る。
  let nextIdx = 0;
  async function worker() {
    while (nextIdx < makerIds.length) {
      if (_discoveryAborted()) { log.warn('[discovery] circleGapScan worker aborted', { nextIdx, total: makerIds.length }); break; }
      const myIdx  = nextIdx++;
      const makerId = makerIds[myIdx];
      const site    = makerSites.get(makerId);
      if (!site) { checked++; continue; }

      await _scanOneCircle(makerId, site);

      // 次に処理するサークルが残っている場合のみレート制限のsleepを挟む
      if (nextIdx < makerIds.length) await sleep(RL);
    }
  }

  const poolSize = Math.max(1, Math.min(config.fetch.concurrency ?? 1, makerIds.length));
  log.info('[discovery] circleGapScan concurrency=' + poolSize);
  await Promise.all(Array.from({ length: poolSize }, () => worker()));

  log.info('[discovery] circleGapScan done', {
    checked, totalMissing, circlesWithGaps: Object.keys(missingByCircle).length, skippedInvalidSite,
  });
  return { checked, totalMissing, missingByCircle, skippedInvalidSite, totalCircles: makerIds.length, resumedFromPrevious: resumedCount > 0 };
}

// ─── 完了ごとの自動デバッグpush ─────────────────────────────────────────────────
// scheduler.js（cron）とapiServer.js（UI手動実行）のどちらから呼ばれても
// 漏れなくpushされるよう、個々の関数内ではなくexport時にラップする。
function _withDebugPush(jobName, fn) {
  return async (...args) => {
    let result, err;
    try {
      result = await fn(...args);
      return result;
    } catch (e) {
      err = e;
      throw e;
    } finally {
      try {
        await pushDebugBundle({ job: jobName, result: err ? { error: err.message } : result });
      } catch (pushErr) {
        log.error('[discovery] pushDebugBundle failed', pushErr.message);
      }
    }
  };
}

module.exports = {
  runDiscovery:      _withDebugPush('discovery',   runDiscovery),
  runFullScan:       _withDebugPush('fullscan',    runFullScan),
  runEndingSoonScan: _withDebugPush('endingsoon',  runEndingSoonScan),
  runNewReleaseScan: _withDebugPush('newrelease',  runNewReleaseScan),
  runCircleGapScan:  _withDebugPush('circlegap',   runCircleGapScan),
};
