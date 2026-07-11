'use strict';

/**
 * electron-main.js
 * Electron メインプロセス。
 *
 * 制御フロー:
 *   HTTP API (port 7777) ← web UI のボタン
 *   IPC (ipcMain)        ← renderer からの直接呼び出し（HTTP不要）
 *   Tray menu            ← OS ネイティブのトレイ操作
 *   App menu             ← ウィンドウ上部のメニューバー
 */

const {
  app, BrowserWindow, Tray, Menu, nativeImage,
  shell, ipcMain, dialog,
} = require('electron');

// ─── data dir ────────────────────────────────────────────────────────────────
// PORTABLE_EXECUTABLE_DIR がTEMPディレクトリを指す場合があるため検証してから使用する。
// TEMPなら app.getPath('userData') にフォールバックする。
{
  const path = require('path');
  const os   = require('os');

  const tmpDir = os.tmpdir().toLowerCase().replace(/\\/g, '/');
  const isTemp = p => !p || p.toLowerCase().replace(/\\/g, '/').startsWith(tmpDir);

  const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
  const dataDir =
    (process.env.NODE_ENV === 'development'
      ? process.cwd()
      : (!isTemp(portableDir) ? portableDir : null)
    ) ?? app.getPath('userData');

  process.env.DLSITE_DATA_DIR = dataDir;
  console.log('[main] data dir:', dataDir, portableDir ? `(PORTABLE_EXECUTABLE_DIR: ${portableDir})` : '');
}

// ─── backend ──────────────────────────────────────────────────────────────────

let db, apiServer, scheduler, discovery, detailFetcher;


// DLsite をヘッドレスChromiumで開き、CF/年齢確認をクリアして
// セッションCookieを確立する。以後 electron.net.fetch が自動でそのCookieを使う。
//
// バグ修正: 以前は 'https://www.dlsite.com/maniax/' だけを開いていたが、
// DLsiteはサイトファミリー(maniax/girls/bl等)ごとに個別の年齢確認ゲートを
//持っており、maniaxの年齢確認を突破してもgirls/blのゲートは未通過のままだった。
// そのため config.dlsite.sites に設定された girls/bl の product/info/ajax が
// 常に空応答({})を返し、診断ツールでも実際の巡回でも取得できずにいた。
// config.dlsite.sites の全サイトを順番に開いて年齢確認するように変更。
//
// バグ修正(本丸・長期未修正だった根本原因): 上記の対応後も、実際に開いていた
// URLは各サイトの「ルートページ」(https://www.dlsite.com/{site}/)のままだった。
// DLsiteの年齢確認ゲートはサイトルートではなく、個別の商品詳細ページ
// (/{site}/work/=/product_id/{RJ}.html)にアクセスしたときにのみ表示される
// 仕様であることが確認できた(ルートページは年齢確認なしで閲覧できる通常の
// ストア画面をそのまま返すため、_tryClickAgeGate は毎回クリック対象を
// 見つけられず、結果としてCookieも一切付与されないまま「クリック試行はした
// ことになっている」空振り状態が続いていた)。DB内に実在するRJコードを1件
// 拝借して商品詳細ページへ遷移するように変更する(DBが空の初回起動時は
// フォールバックでルートページを開く)。
async function warmUpSession() {
  const { BrowserWindow, session } = require('electron');
  const config = require('./config');
  const log    = require('./crawler/logger');
  const db     = require('./crawler/db');

  const w = new BrowserWindow({
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });

  const sites = config.dlsite.sites?.length ? config.dlsite.sites : ['maniax'];
  // バグ修正: 以前はサイトごとの成功/失敗が console.log のみで、dlsite-tracker.log
  // (dlsite-error.log) には一切残らなかった。product/info/ajax が HTTP 200 +
  // 空オブジェクトを返す(≒年齢確認Cookie未取得)事象が起きても、後からログだけを
  // 見ても warmUp が実際に成功していたのか判別できなかった。log.info/log.warn
  // (logger.js経由、ファイル保存される方)で記録するようにする。
  //
  // バグ修正: 以前は「クリックできたか(clicked)」だけを見ており、Cookieが実際に
  // 付与されたかは全サイト処理後に1回まとめて確認していた。これだと
  // (a) どのサイトのクリックが実際にCookie取得につながったのか個別に分からない、
  // (b) クリック自体は"成功"していても(例: 無関係な要素をキーワード一致で誤クリック)
  // 実際にはCookieが付与されていないケースを見逃す、という問題があった。
  // サイトごとに直後でCookie保有状況を確認するようにする。
  const results = {};
  for (const site of sites) {
    let targetUrl = `https://www.dlsite.com/${site}/`;
    let rjUsed = null;
    try {
      rjUsed = db.getSampleRjForSite(site);
    } catch (e) {
      log.warn('[warmUp] getSampleRjForSite failed', site, e.message);
    }
    if (rjUsed) {
      targetUrl = `https://www.dlsite.com/${site}/work/=/product_id/${rjUsed}.html`;
    } else {
      log.warn('[warmUp] DB内に', site, '向けの実在RJコードが無いためサイトルートで代用します(年齢確認ゲートが表示されない可能性が高い、初回起動時は正常)');
    }
    results[site] = await _warmUpOneSite(w, targetUrl);
    results[site].targetUrl = targetUrl;
    results[site].rjUsed = rjUsed;
    results[site].cookieObtained = await _checkAgeCookie(session, site);
  }
  log.info('[warmUp] age-gate results (per site)', results);
  const failedSites = Object.entries(results).filter(([, r]) => !r.cookieObtained).map(([s]) => s);
  if (failedSites.length) {
    log.warn('[warmUp] 年齢確認Cookieを取得できなかったサイト', failedSites,
      '— DLsite側のページ構造が変わった、またはクリックが実際のCookie取得に繋がっていない可能性があります');
  }

  try { w.destroy(); } catch {}
}

// 指定サイト向けの年齢確認Cookie(adult/age系)が現時点で付与されているかを確認する。
// warmUpSession() のループ内でサイトごとに呼び、クリックの成否とCookie取得の成否を
// 個別に突き合わせられるようにする(クリック成功≠Cookie取得成功のケースを検出するため)。
async function _checkAgeCookie(session, label) {
  const log = require('./crawler/logger');
  try {
    const cookies = await session.defaultSession.cookies.get({ domain: 'dlsite.com' });
    const ageCookies = cookies.filter(c => /adult|age/i.test(c.name));
    const hasAgeCookie = ageCookies.length > 0;
    log.info(`[warmUp] cookie check (${label})`, {
      hasAgeCookie,
      ageCookies: ageCookies.map(c => `${c.name}=${c.value}`),
      allCookieNames: cookies.map(c => c.name),
    });
    return hasAgeCookie;
  } catch (e) {
    log.warn(`[warmUp] cookie check failed (${label})`, e.message);
    return false;
  }
}

// ── 外部(detailFetcher.js等)から呼べるセッション再確立フック ──────────────────
// 巡回中に「同一サイトへのAPIリクエストが空応答(≒セッション切れ)を何度も
// 連続で返す」ことを検知した場合、detailFetcher.js はこの関数を呼んで
// セッションの再確立を試みる(electron-main.jsを直接requireできない/したくない
// detailFetcher.js側から、グローバル経由で疎結合に呼べるようにするため)。
// warmUpSession()自体は毎回新しいBrowserWindowを開いて全サイト分の年齢確認を
// やり直す比較的重い処理(最大45秒程度)なので、複数箇所からほぼ同時に
// 呼ばれても実際には1回だけ実行し、呼び出し元は全員その1回の完了を待つ
// (多重実行によるBrowserWindow乱立・二重の再ウォームアップを防ぐ)。
let _reWarmInFlight = null;
global._reWarmUpSession = () => {
  if (!_reWarmInFlight) {
    const log = require('./crawler/logger');
    log.warn('[warmUp] re-warmup triggered externally (repeated empty responses detected)');
    _reWarmInFlight = warmUpSession()
      .catch(e => { log.error('[warmUp] re-warmup error', e.message); })
      .finally(() => { _reWarmInFlight = null; });
  }
  return _reWarmInFlight;
};

// ページ遷移を1回行い、did-finish-load/did-fail-load/タイムアウトのいずれかで
// 解決する低レベルヘルパー。年齢確認ボタンのクリック等は一切行わない
// (それは _tryClickAgeGate に分離)。2段階遷移(トップページ→商品ページ)で
// 同じナビゲーション待ちロジックを2回使うために切り出した。
function _navigateAndWait(w, url, timeoutMs) {
  const log = require('./crawler/logger');
  return new Promise(resolve => {
    let resolved  = false;
    let pollTimer = null;
    let startTimer = null;

    const cleanup = () => {
      w.webContents.removeListener('did-finish-load', onFinish);
      w.webContents.removeListener('did-fail-load', onFailLoad);
      if (pollTimer)  { clearTimeout(pollTimer);  pollTimer  = null; }
      if (startTimer) { clearTimeout(startTimer);  startTimer = null; }
    };

    const done = (reason) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve({ reason });
    };

    // バグ修正: did-fail-load はメインフレームのナビゲーション失敗以外(広告/
    // トラッカー等のサブリソース、中断されたリダイレクト等)でも頻繁に発火する。
    // 特に errorCode -3 (net::ERR_ABORTED) は、サーバー側リダイレクトの過程で
    // 元のリクエストが中断される際にごく普通に発生するイベントで、実際には
    // その直後にリダイレクト先で did-finish-load が正常に発火することが多い。
    // ERR_ABORTED は無視して did-finish-load 側に処理を委ねる。
    const onFailLoad = (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (isMainFrame === false) return;
      if (errorCode === -3) {
        log.info('[warmUp] did-fail-load ERR_ABORTED (リダイレクト中の想定内イベント、無視)', { url });
        return;
      }
      log.warn('[warmUp] did-fail-load (main frame)', { url, errorCode, errorDescription });
      done('fail-load:' + errorCode);
    };
    const onFinish = () => done('finish-load');

    w.webContents.once('did-finish-load', onFinish);
    w.webContents.on('did-fail-load', onFailLoad);

    // バグ修正(本丸): タイムアウト診断ログで readyState:"complete",
    // bodyLen:580000超(=ページは完全に読み込まれている)にも関わらず
    // did-finish-load が一度も発火せず、15秒のタイムアウトを毎回まるまる
    // 浪費していることが判明した。原因はElectron側の何らかの事情
    // (サブフレームやservice worker絡み等)でイベントが正しく届いていない
    // ことにあると見られるが、実害としては「ページは読めているのに
    // 年齢確認ボタンをクリックする機会を得られない」ことなので、
    // did-finish-loadだけに依存せず document.readyState をポーリングして
    // 'complete' を検知した時点でも解決できるようにする。
    // ナビゲーション直後は前のページのreadyStateがまだ残っている可能性が
    // あるため、少し待ってからポーリングを開始し、location.hrefが
    // about:blank でないことも合わせて確認する(誤検知防止)。
    //
    // バグ修正: 当初 setInterval(500ms) で実装していたが、レンダラーが
    // 一時的に応答しない状態(ページが実際には裏で読み込み中、あるいは
    // システムスリープ明け等)になると、前回の executeJavaScript 呼び出しが
    // まだ完了していないのに次のティックが容赦なく積み重なり、レンダラーが
    // 復帰した瞬間に溜まっていた呼び出しが一斉に解決して同一ミリ秒に
    // 十数〜二十件の重複ログが出る事象が実機で確認された(done()自体は
    // resolved フラグで冪等なため実害としての多重resolveは防げていたが、
    // ログ出力とexecuteJavaScript呼び出し自体が無駄に何度も発生していた)。
    // setInterval をやめ、「前回のポーリングが完了してから次を予約する」
    // 自己再スケジュール方式の setTimeout に変更し、常に高々1件の
    // executeJavaScript 呼び出ししか同時に飛ばないようにする。
    const POLL_START_DELAY = 800;
    const POLL_INTERVAL    = 500;

    const schedulePoll = () => {
      if (resolved) return;
      pollTimer = setTimeout(async () => {
        pollTimer = null;
        if (resolved) return;
        try {
          const state = await w.webContents.executeJavaScript(
            '({ readyState: document.readyState, href: location.href })'
          );
          // await の間に did-finish-load 等、別経路で既に解決している
          // かもしれないため、ログ出力・done() 呼び出し前に再確認する。
          if (resolved) return;
          if (state?.readyState === 'complete' && state.href && state.href !== 'about:blank') {
            log.warn('[warmUp] did-finish-loadが発火しないため readyState ポーリングで検出',
              { url, href: state.href });
            done('finish-load');
            return;
          }
        } catch {
          // ページ遷移中で一時的にJS実行不可なことがある。次のポーリングに任せる。
        }
        schedulePoll();
      }, POLL_INTERVAL);
    };

    startTimer = setTimeout(() => {
      startTimer = null;
      schedulePoll();
    }, POLL_START_DELAY);

    // タイムアウト時もページの現在状態を可能な限り取得してログに残す
    // (診断コードがonFinish内にしか無いと、did-finish-loadが一度も
    // 発火しないタイムアウトケースで一切の手がかりが残らなかった)。
    setTimeout(async () => {
      if (resolved) return;
      try {
        const diag = await w.webContents.executeJavaScript(`
          ({
            url: location.href,
            title: document.title,
            readyState: document.readyState,
            bodyLen: (document.body && document.body.innerHTML || '').length,
          })
        `);
        log.warn('[warmUp] timeout diagnostics', { url, ...diag, isLoading: w.webContents.isLoading() });
      } catch (e) {
        log.warn('[warmUp] timeout diagnostics failed (page context unavailable)',
          { url, error: e.message, isLoading: w.webContents.isLoading() });
      }
      done('timeout');
    }, timeoutMs);

    w.loadURL(url);
  });
}

// 現在ロード済みのページ上で年齢確認ボタンを探してクリックする。
// 見つからなかった場合は診断用に title/URL/本文抜粋/リンク文言を返す。
async function _tryClickAgeGate(w, url) {
  const log = require('./crawler/logger');
  try {
    const evalResult = await w.webContents.executeJavaScript(`
      (function() {
        const selectors = [
          'a.btn_yes', 'a[href*="adult=1"]', '.btn_adult',
          'a[href*="age_check"]', 'input[value*="はい"]',
          '.age_check_yes', 'a[href*="adultchecked"]'
        ];
        for (const sel of selectors) {
          try {
            const el = document.querySelector(sel);
            if (el) { el.click(); return { clicked: true, via: 'selector:' + sel }; }
          } catch {}
        }
        const keywords = ['はい', '入場する', '18歳以上', 'adult', 'enter', '同意'];
        for (const a of document.querySelectorAll('a, button')) {
          const txt = (a.textContent || '').trim();
          if (keywords.some(k => txt.includes(k))) { a.click(); return { clicked: true, via: 'keyword:' + txt.slice(0, 20) }; }
        }
        return {
          clicked: false,
          diag: {
            title: document.title,
            url: location.href,
            bodyTextSample: (document.body?.innerText || '').slice(0, 200).replace(/\\s+/g, ' '),
            anchorTextsSample: Array.from(document.querySelectorAll('a')).slice(0, 15).map(a => (a.textContent||'').trim()).filter(Boolean),
          },
        };
      })()
    `);
    const clicked = !!evalResult?.clicked;
    if (!clicked && evalResult?.diag) {
      log.warn('[warmUp] 年齢確認ボタン未検出、診断情報', { url, ...evalResult.diag });
    }
    return clicked;
  } catch (e) {
    log.warn('[warmUp] executeJavaScript error', { url, error: e.message });
    return false;
  }
}

// 年齢確認ボタンをクリックした直後の待機。
// バグ修正: 以前は固定2秒の setTimeout のみで、クリックが実際にページ遷移/
// リダイレクトを伴うケース(フォーム送信等でCookieがリダイレクト完了後にしか
// 反映されない場合)に2秒で足りているか全く検証していなかった。
// クリック後に did-finish-load が発火するかを最大 maxMs まで待ち、発火したら
// Cookie反映の猶予を少し追加する。発火しない場合(AJAXのみでCookieを設定する
// ケース等)は最低 minMs だけ待つ。
function _waitAfterClick(w, minMs = 2000, maxMs = 6000) {
  return new Promise(resolve => {
    let settled = false;
    const onFinish = () => {
      if (settled) return;
      settled = true;
      setTimeout(() => resolve(true), 500); // ナビゲーション後のCookie反映猶予
    };
    w.webContents.once('did-finish-load', onFinish);
    setTimeout(() => {
      if (settled) return;
      settled = true;
      w.webContents.removeListener('did-finish-load', onFinish);
      resolve(false);
    }, Math.max(minMs, maxMs));
  });
}

// 1サイト分の年齢確認突破を試みる。
// 戻り値: { clicked: boolean, reason: string } — clicked は年齢確認ボタンの
// クリックに成功したかどうか(呼び出し側のログ・診断用)。
//
// バグ修正: 従来はトップページ(https://www.dlsite.com/{site}/)上でだけ
// 年齢確認ボタンを探していたが、実機診断の結果、DLsiteは(全年齢+成人混在の)
// トップページ自体では年齢確認を要求せず、個別の成人向け作品詳細ページに
// 直接アクセスした時だけ年齢確認ゲートを表示する仕様と判明した
// (診断ログでmaniaxのトップページのtitle/リンク一覧を確認したところ、
// 通常のストア画面がそのまま表示され、年齢確認ボタンがそもそも存在
// しなかった)。これによりwarmUpSession()はdid-finish-loadの発火自体は
// 成功していても、クリックすべきボタンが存在しないページを開いているだけ
// で、年齢確認Cookieを一切取得できていなかった可能性が高い。
// トップページでボタンが見つからない場合、ページ内の実商品リンクを1件
// 拾ってそこへ遷移し、そこで改めて年齢確認ボタンを探す2段階方式に変更。
// トップページで直接ボタンが見つかるサイト(従来通り動いていた場合)は
// 1段階目で完結するため、既存の動作を壊さない。
async function _warmUpOneSite(w, url) {
  const log = require('./crawler/logger');

  const rootNav = await _navigateAndWait(w, url, 15000);
  if (rootNav.reason !== 'finish-load') {
    log.info('[warmUp] site done', { url, clicked: false, reason: rootNav.reason });
    return { clicked: false, reason: rootNav.reason };
  }

  let clicked = await _tryClickAgeGate(w, url);
  if (clicked) {
    const navigated = await _waitAfterClick(w);
    log.info('[warmUp] site done', { url, clicked: true, reason: 'finish-load(root)', navigatedAfterClick: navigated });
    return { clicked: true, reason: 'finish-load(root)' };
  }

  let productUrl = null;
  try {
    productUrl = await w.webContents.executeJavaScript(
      `(function(){ const a = document.querySelector('a[href*="/product_id/RJ"]'); return a ? a.href : null; })()`
    );
  } catch (e) {
    log.warn('[warmUp] product link scan failed', { url, error: e.message });
  }

  if (!productUrl) {
    log.warn('[warmUp] 年齢確認ボタンが見つからず、商品リンクも見つからなかったため断念', { url });
    return { clicked: false, reason: 'no-age-gate-no-product-link' };
  }

  log.info('[warmUp] トップページに年齢確認ボタンなし。商品ページへ遷移して再試行', { url, productUrl });
  const productNav = await _navigateAndWait(w, productUrl, 15000);
  if (productNav.reason !== 'finish-load') {
    log.info('[warmUp] site done', { url, clicked: false, reason: 'product-page-' + productNav.reason });
    return { clicked: false, reason: 'product-page-' + productNav.reason };
  }

  clicked = await _tryClickAgeGate(w, productUrl);
  const navigated = await _waitAfterClick(w);
  const reason = clicked ? 'finish-load(product)' : 'no-button-on-product-page';
  log.info('[warmUp] site done', { url, clicked, reason, navigatedAfterClick: navigated });
  return { clicked, reason };
}
async function startBackend() {
  console.log('[startup] requiring modules...');
  db            = require('./crawler/db');
  apiServer     = require('./crawler/apiServer');
  scheduler     = require('./crawler/scheduler');
  discovery     = require('./crawler/discovery');
  detailFetcher = require('./crawler/detailFetcher');
  console.log('[startup] modules loaded, starting db.init()...');

  await db.init();
  console.log('[startup] db.init() done, starting apiServer...');

  apiServer.start();
  console.log('[startup] apiServer started');
}

// バックグラウンド価格変動通知
global._notifyPriceChange = (count) => {
  try {
    const { Notification } = require('electron');
    if (Notification.isSupported()) {
      new Notification({
        title: 'DLsite 価格変動',
        body: `${count}件の価格変動を検出しました`,
        silent: false,
      }).show();
    }
    // トレイアイコンのツールチップも更新
    if (_tray) _tray.setToolTip(`DLsite Price Tracker — 変動 ${count}件`);
    setTimeout(() => { if (_tray) _tray.setToolTip('DLsite Price Tracker'); }, 10_000);
  } catch (e) { console.warn('[notify] error', e.message); }
};

/** warmUp + scheduler を非同期で起動（ウィンドウ表示をブロックしない） */
async function startCrawlerBackground() {
  await new Promise(r => setTimeout(r, 500));

  // 1. 必須 Cookie を事前注入（ロケールのみ）
  //
  // バグ修正(重要): 以前は adultchecked=1 / agecheck=1 も静的に注入していた。
  // これは実際にDLsiteサーバー側が発行した年齢確認Cookieではない、こちらが
  // 決め打ちで書き込んだ「偽物」で、しかも _checkAgeCookie() の判定条件
  // (/adult|age/i にCookie名がマッチするか)がこの偽Cookieにもマッチして
  // しまうため、本物の年齢確認が実際には失敗していても常に
  // hasAgeCookie:true と誤判定される状態になっていた
  // (実機の「新着ページ取得」診断では年齢確認ページが検出されていたにも
  // 関わらず、cookie check側は毎回「成功」と報告していたのはこのため)。
  // これにより failedSites が常に空になり、再ウォームアップの自動発火
  // 条件(_checkAgeCookie失敗の検出)が一度も満たされなくなっていた。
  // adultchecked/agecheckの静的注入自体をやめ、_warmUpOneSite()の実際の
  // ナビゲーション+クリックで得られる本物のCookieだけを見るようにする。
  try {
    const { session } = require('electron');
    const ses = session.defaultSession;
    const base = { url: 'https://www.dlsite.com', domain: '.dlsite.com', path: '/', httpOnly: false };
    for (const [name, value] of [
      ['locale', 'ja-jp'],
    ]) {
      await ses.cookies.set({ ...base, name, value })
        .catch(e => console.warn('[cookie] set failed', name, e.message));
    }
    console.log('[startBackend] cookies pre-injected (locale only)');
  } catch(e) { console.warn('[cookie] session not ready', e.message); }

  // 2. DLsite セッションウォームアップ（バックグラウンド、ウィンドウ表示に影響しない）
  global._sseSend?.('log', 'DLsite セッション初期化中...');
  await warmUpSession();
  console.log('[startBackend] session warmed up, starting scheduler');
  global._sseSend?.('log', 'セッション初期化完了 — クローラー起動');

  // 3. クローラー起動
  scheduler.start().catch(err =>
    console.error('[electron] scheduler error', err.message)
  );
}

// ─── IPC: renderer → main ──────────────────────────────────────────────────

// 重複実行防止（schedulerと共有）
// キー: state名（scheduler/apiServerと統一） ← job名ではない
const _running = {};

// scheduler.js / apiServer.js が参照できるよう global に公開
global._crawlerRunning = _running;

function _bindIpc() {
  // ステータス取得
  ipcMain.handle('crawler:status', () => {
    try {
      return { ok: true, stats: db.getStats(), running: { ..._running } };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // 各ジョブ実行
  // ロック判定・取得は apiServer.js の handleRun() に一本化する。
  // ここで事前に _running[sk]=true をセットすると、_running は
  // apiServer.js と共有(global._crawlerRunning)しているため、
  // apiServer.js 側が「既に実行中」と誤判定してジョブを拒否してしまう。
  ipcMain.handle('crawler:run', async (_, job) => {
    setImmediate(async () => {
      try {
        await _execJob(job);
      } catch (err) {
        console.error('[electron] job error', job, err.message);
      } finally {
        if (_win && !_win.isDestroyed()) {
          _win.webContents.send('crawler:done', { job, stats: db.getStats() });
        }
      }
    });
    return { ok: true, message: `${job} started` };
  });
}

/**
 * ジョブ実行は必ず apiServer.js の HTTP API 経由で行う。
 * 理由: 以前はここに discovery/detailFetcher を直接呼ぶ別実装があり、
 * abort機構・ロックのトークン方式・999件処理などapiServer.js側に積んだ
 * 修正が一切反映されない「裏口」になっていた（トレイメニュー・アプリメニュー
 * から実行すると古い壊れた挙動に戻るバグ）。二重実装を防ぐため、
 * ここでは fetch で同じ /api/run/{job} を叩くだけにする。
 */
async function _execJob(job) {
  const log = require('./crawler/logger');
  log.info('[electron] job start (via HTTP API)', job);
  const cfg = require('./config');
  const host = cfg.ui?.host ?? '127.0.0.1';
  const port = cfg.ui?.port ?? 7777;
  const res = await fetch(`http://${host}:${port}/api/run/${job}`, { method: 'POST' });
  const body = await res.json().catch(() => ({}));
  if (!body.ok) {
    throw new Error(body.message || `job ${job} failed to start`);
  }
  // apiServer.js 側でジョブは非同期実行される。完了は /api/run/status をポーリングして待つ。
  //
  // 重大バグ修正: 以前は global._crawlerRunning[sk]（discovery/detail等の下位共有ロック）を
  // 見ていたが、これはジョブ単位の状態と一致しない。
  //   - 'all' は sk='discovery' だったが、discoveryロックはPhase1完了時点でfalseに戻るため、
  //     Phase2（価格更新・最も時間がかかる）実行中に待機ループが抜けて crawler:done が誤発火していた。
  //   - 'turbo' はマッピングに存在せず sk='turbo' になるが、apiServer.js は
  //     global._crawlerRunning.turbo というキーを一切セットしない（turboの共有ロックは'detail'）ため、
  //     while条件が最初から偽になり、待機ゼロで即座に crawler:done が発火していた。
  // ダッシュボードJS（_waitJobDone）と同じ方式：/api/run/status の _jobRunning[job] を直接見る。
  // このフラグは apiServer.js の handleRun() が全フェーズ完了後（finally節）まで true を保つため、
  // 'all'/'turbo' のような複数フェーズジョブでも正確に完了を検知できる。
  const start = Date.now();
  while (Date.now() - start < 30 * 60 * 1000) {
    await new Promise(r => setTimeout(r, 1000));
    try {
      const statusRes = await fetch(`http://${host}:${port}/api/run/status`);
      const status = await statusRes.json();
      if (!status[job]) break;
    } catch (e) {
      log.warn('[electron] status poll failed, retrying', e.message);
    }
  }
}

// ─── window ───────────────────────────────────────────────────────────────────

let _win  = null;
let _tray = null;

function createWindow() {
  _win = new BrowserWindow({
    width:     1280,
    height:    820,
    minWidth:  900,
    minHeight: 600,
    title:     'DLsite Price Tracker',
    backgroundColor: '#f0f2f5',
    show:            false,
    autoHideMenuBar: false, // バグ修正: true だとAltキーを押すまでメニューバー自体が
                             // 非表示になり、「ファイル→データベースの場所を開く」が
                             // 「機能が無くなった」ように見えていた。常時表示に変更。
    webPreferences: {
      nodeIntegration:  false,
      contextIsolation: true,
      preload: require('path').join(__dirname, 'preload.js'),
    },
  });

  // Electron ネイティブメニューバー
  _win.setMenu(_buildAppMenu());

  const _cfg  = require('./config');
  const _host = _cfg.ui?.host ?? '127.0.0.1';
  const _port = _cfg.ui?.port ?? 7777;
  _win.loadURL(`http://${_host}:${_port}`);

  _win.once('ready-to-show', () => _win.show());

  _win.on('close', e => {
    if (!app.isQuiting) {
      e.preventDefault();
      _win.hide();
    }
  });

  _win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

// ─── ネイティブメニューバー ────────────────────────────────────────────────────

// メニューバーが(誤操作で隠されている等)見えない状況でも辿り着けるよう、
// ファイルメニューとトレイメニュー両方から同じ処理を呼べるようにする。
function _openDbLocation() {
  const p = require('path');
  const dbPath = p.resolve(
    process.env.DLSITE_DATA_DIR || app.getPath('userData'),
    require('./config').db.path
  );
  shell.showItemInFolder(dbPath);
}

// CDN/プロキシキャッシュ汚染により誤って priority=delisted に落とされた疑いのある
// 作品を、通常優先度に戻す1回限りのDBメンテナンス。詳細は db.js の
// recoverSuspectedDelisted() のコメント参照。
// consecutive_errors が低い(=最近delistedになったばかりの)作品だけを対象にする
// ことで、長期間確認済みの本当のdelisted作品を誤って復旧しないようにする。
const _DELISTED_MIN_ERRORS = 2;
const _DELISTED_MAX_ERRORS = 3;

function _recoverDelisted() {
  if (!db) {
    dialog.showMessageBox(_win, { message: 'DBが初期化されていません。しばらく待ってから再度お試しください。', type: 'warning' });
    return;
  }
  let before;
  try {
    before = db.countSuspectedDelisted(_DELISTED_MIN_ERRORS, _DELISTED_MAX_ERRORS);
  } catch (e) {
    dialog.showMessageBox(_win, { message: `件数確認に失敗しました: ${e.message}`, type: 'error' });
    return;
  }
  if (before === 0) {
    dialog.showMessageBox(_win, {
      message: '対象の作品は見つかりませんでした（誤delistedの疑いがある作品は0件です）。',
      type: 'info',
    });
    return;
  }
  const choice = dialog.showMessageBoxSync(_win, {
    type: 'question',
    buttons: ['実行', 'キャンセル'],
    defaultId: 1,
    cancelId: 1,
    message:
      `priority=delisted（連続エラー${_DELISTED_MIN_ERRORS}〜${_DELISTED_MAX_ERRORS}回、` +
      `誤判定の疑いあり）の作品が ${before} 件見つかりました。\n` +
      `通常優先度に戻し、次回の巡回で再チェックします。実行しますか？\n\n` +
      `※本当に削除済みの作品は、再チェック時の強化済み判定で正しく再びdelistedになるため安全です。`,
  });
  if (choice !== 0) return;
  try {
    const recovered = db.recoverSuspectedDelisted(_DELISTED_MIN_ERRORS, _DELISTED_MAX_ERRORS);
    dialog.showMessageBox(_win, { message: `復旧完了: ${recovered}件を通常優先度に戻しました。`, type: 'info' });
  } catch (e) {
    dialog.showMessageBox(_win, { message: `復旧処理に失敗しました: ${e.message}`, type: 'error' });
  }
}

function _buildAppMenu() {
  // ロック判定は apiServer.js の handleRun() に一本化（事前ロックしない）
  const runItem = (label, job, accel) => ({
    label,
    accelerator: accel,
    click: async () => {
      _win?.webContents.send('crawler:started', { job });
      try {
        await _execJob(job);
      } catch (err) {
        dialog.showMessageBox(_win, { message: `${label}: ${err.message}`, type: 'warning' });
      } finally {
        _win?.webContents.send('crawler:done', { job, stats: db.getStats() });
      }
    },
  });

  return Menu.buildFromTemplate([
    {
      label: 'ファイル',
      submenu: [
        {
          label: 'データベースの場所を開く',
          click: _openDbLocation,
        },
        { type: 'separator' },
        {
          label: '誤delisted作品を復旧（1回限りのメンテナンス）',
          click: _recoverDelisted,
        },
        { type: 'separator' },
        {
          label: '設定（GitHub連携）',
          accelerator: 'Ctrl+,',
          click: () => _openSettingsModal(),
        },
        { type: 'separator' },
        { label: '終了', accelerator: 'Alt+F4', click: () => { app.isQuiting = true; app.quit(); } },
      ],
    },
    {
      label: '巡回',
      submenu: [
        runItem('RJ収集（新着/ランキング/セール）', 'discover',      'Ctrl+1'),
        runItem('価格更新（未取得・期限切れ）',    'fetch',          'Ctrl+2'),
        runItem('セール優先（サークル優先度維持）', 'saleboost',      'Ctrl+3'),
        { type: 'separator' },
        runItem('全て巡回',                        'all',            'Ctrl+Shift+A'),
        { type: 'separator' },
        runItem('終了間近収集（24時間以内）',       'endingsoon',     'Ctrl+Shift+E'),
        { type: 'separator' },
        runItem('全収集（FSR全ページ）',           'fullscan',       'Ctrl+Shift+F'),
        runItem('全セール収集',                    'fullscan_sale',  'Ctrl+Shift+S'),
      ],
    },
    {
      label: '表示',
      submenu: [
        { role: 'reload',     label: '再読み込み' },
        { role: 'toggleDevTools', label: '開発者ツール' },
        { type: 'separator' },
        { role: 'zoomIn',  label: '拡大' },
        { role: 'zoomOut', label: '縮小' },
        { role: 'resetZoom', label: 'ズームリセット' },
      ],
    },
  ]);
}

// ─── トレイ ───────────────────────────────────────────────────────────────────

function createTray() {
  _tray = new Tray(_buildTrayIcon());

  const rebuild = () => _tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: 'DLsite Price Tracker を開く',
      click: () => { if (_win) { _win.show(); _win.focus(); } else createWindow(); },
    },
    { type: 'separator' },
    { label: 'RJ収集',      click: () => _execJobSafe('discover') },
    { label: '価格更新',    click: () => _execJobSafe('fetch') },
    { label: 'セール優先',  click: () => _execJobSafe('saleboost') },
    { label: '全て巡回',    click: () => _execJobSafe('all') },
    { type: 'separator' },
    { label: '終了間近収集（24時間以内）', click: () => _execJobSafe('endingsoon') },
    { label: '全収集（時間がかかります）', click: () => _execJobSafe('fullscan') },
    { type: 'separator' },
    { label: '設定（GitHub連携）', click: () => _openSettingsModal() },
    {
      label: 'データベースの場所を開く',
      click: _openDbLocation,
    },
    {
      label: 'ブラウザで開く',
      click: () => { const c = require('./config'); shell.openExternal(`http://${c.ui?.host ?? '127.0.0.1'}:${c.ui?.port ?? 7777}`); },
    },
    { type: 'separator' },
    { label: '終了', click: () => { app.isQuiting = true; app.quit(); } },
  ]));

  rebuild();
  _tray.setToolTip('DLsite Price Tracker');
  _tray.on('double-click', () => {
    if (_win) { _win.show(); _win.focus(); }
  });
}

// メニュー/トレイから設定モーダルを直接開く。
// ウィンドウがまだ無い/hideされている場合は表示してから、ページ内のJS関数を
// 直接呼び出す（設定画面はダッシュボードHTML内のモーダルとして実装されている
// ため、別ウィンドウを作らずrenderer側の関数を叩くだけで済む）。
function _openSettingsModal() {
  if (!_win) { createWindow(); }
  _win.show();
  _win.focus();
  const inject = () => _win.webContents.executeJavaScript('window.showSettings && window.showSettings()').catch(() => {});
  if (_win.webContents.isLoading()) {
    _win.webContents.once('did-finish-load', inject);
  } else {
    inject();
  }
}

// ロック判定は apiServer.js の handleRun() に一本化（事前ロックしない）
async function _execJobSafe(job) {
  _win?.webContents.send('crawler:started', { job });
  try { await _execJob(job); } catch (err) {
    console.error('[electron] tray job error', job, err.message);
  } finally {
    _win?.webContents.send('crawler:done', { job, stats: db?.getStats() });
  }
}

// ─── app lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  console.log('[startup] app ready');
  await startBackend();
  console.log('[startup] _bindIpc...');
  _bindIpc();
  console.log('[startup] createTray...');
  createTray();
  console.log('[startup] createWindow...');
  createWindow();
  console.log('[startup] window created, starting background tasks...');
  startCrawlerBackground().catch(e =>
    console.error('[electron] background init error', e.message)
  );
});

app.on('window-all-closed', () => { /* トレイに残す */ });
app.on('activate', () => { if (_win) _win.show(); });

// 終了時に DB を確実にフラッシュする。
// _save() は800msデバウンスされているため、何もせず終了すると
// 直近の価格更新が最大800ms分失われる可能性がある。
//
// バグ修正: 以前はジョブが実行中でも即座に db.close()(_db = null)していたため、
// discovery/detailFetcher の非同期ループが再開した瞬間に
// 「transaction() called but _db is null」でクラッシュしていた
// (実際にログで確認: 巡回中にアプリを終了した際に発生)。
// 実行中のジョブがあれば中断シグナル(global._crawlerAbort)を送り、
// 一定時間(_QUIT_WAIT_MS)だけジョブの終了を待ってからDBを閉じる。
// タイムアウトしても強制的に閉じて終了する(ハングでアプリが終了できなくなるのを防ぐ)。
// (config.fetch.timeout=20秒のfetchが直前に飛んでいる可能性があるため、それより
//  少し長めに設定して「タイムアウト→中断チェック」が間に合うようにする)
const _QUIT_WAIT_MS = 22_000;
let _quitFinalizing = false;

function _isCrawlerBusy() {
  const r = global._crawlerRunning || {};
  return !!(r.discovery || r.detail || r.saleBoost || r.schedulerDetailRunning);
}

app.on('before-quit', (event) => {
  if (_quitFinalizing) return; // 2回目以降(強制終了時)はそのまま通す
  if (!_isCrawlerBusy()) {
    try { db?.close(); } catch (e) { console.error('[electron] db close error', e.message); }
    return;
  }

  event.preventDefault();
  console.log('[electron] job running — aborting and waiting up to', _QUIT_WAIT_MS, 'ms before quit');
  if (!global._crawlerAbort) global._crawlerAbort = {};
  global._crawlerAbort.discovery = true;
  global._crawlerAbort.detail    = true;

  (async () => {
    const start = Date.now();
    while (_isCrawlerBusy() && Date.now() - start < _QUIT_WAIT_MS) {
      await new Promise(r => setTimeout(r, 200));
    }
    if (_isCrawlerBusy()) {
      console.warn('[electron] quit wait timed out, forcing close anyway');
    }
    global._crawlerAbort.discovery = false;
    global._crawlerAbort.detail    = false;
    try { db?.close(); } catch (e) { console.error('[electron] db close error', e.message); }
    _quitFinalizing = true;
    app.quit();
  })();
});

// ─── tray icon ────────────────────────────────────────────────────────────────

function _buildTrayIcon() {
  const size = 16, buf = Buffer.alloc(size * size * 4);
  const cx = 7.5, cy = 7.5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      if (Math.hypot(x - cx, y - cy) < 7) {
        buf[i] = 59; buf[i+1] = 130; buf[i+2] = 246; buf[i+3] = 255;
      }
    }
  }
  return nativeImage.createFromBuffer(buf, { width: size, height: size });
}
