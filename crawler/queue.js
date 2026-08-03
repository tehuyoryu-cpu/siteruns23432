'use strict';

/**
 * crawler/queue.js
 *
 * Electron main process → electron.net.fetch（Chromiumスタック）
 *   セッションCookieを自動送信 → CF/年齢確認を通過できる
 * Node.js CLI → globalThis.fetch（開発用）
 */

const config = require('../config');
const log    = require('./logger');
const { getAbortSignal } = require('./abortSignals');

// ─── fetch 実装を選択 ─────────────────────────────────────────────────────────
const _isElectron = process.type === 'browser';

const _fetch = (() => {
  if (_isElectron) {
    try {
      const { net } = require('electron');
      log.info('[queue] using electron.net.fetch (Chromium session)');
      return net.fetch.bind(net);
    } catch (e) {
      log.warn('[queue] electron.net unavailable, fallback to globalThis.fetch', e.message);
    }
  }
  return (...a) => globalThis.fetch(...a);
})();

// ─── ヘッダー ─────────────────────────────────────────────────────────────────
// Electron では Cookie ヘッダーを付けない（セッションが自動送信）
// Node.js CLI では手動 Cookie を付ける
const _baseHeaders = _isElectron
  ? {
      'User-Agent':      config.dlsite.userAgent,
      'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'ja,en;q=0.5',
      'Referer':         'https://www.dlsite.com/',
    }
  : {
      'User-Agent':      config.dlsite.userAgent,
      'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'ja,en;q=0.5',
      'Referer':         'https://www.dlsite.com/',
      'Cookie':          config.dlsite.cookies,
    };

// ─── fetchWithRetry ───────────────────────────────────────────────────────────

// ── ネットワーク断ポーズ（系統別 + グローバルエスカレーション） ─────────────
// ERR_NETWORK_IO_SUSPENDED 等の全接続失敗を検知したとき、同一系統
// (detail/discovery/comp等、concurrency分の全ワーカー)が独立してリトライを
// 繰り返すのを防ぐのが本来の目的だった。
//
// バグ修正(⑤ 系統横断でグローバルな点): しかし実装は queue.js モジュール
// 全体で単一の _networkPaused フラグを共有していたため、ある1系統
// (例: detail)が検知した単発のネットワークエラー(必ずしも本当のPC全体の
// 断ではない)だけで、無関係な他系統(discovery/comp、さらには
// scripts/push-data-shards.js が叩く api.github.com への通信のように
// DLsiteとは無関係なドメイン)まで一律 _PAUSE_DURATION 秒止まってしまっていた。
// detailFetcher.js のサイト単位サーキットブレーカーが「2サイト以上が
// 同時にサーキット開放中のときだけグローバル抑制へ昇格する」設計に
// なっているのと同じ考え方で、まず abortFlagName(系統)単位でポーズし、
// 短い時間窓内に GLOBAL_ESCALATION_MIN_SYSTEMS 系統以上が独立して
// ネットワークエラーを検知した場合にのみ、真に全系統を止める
// グローバルポーズへ昇格させる。
const _UNSCOPED_KEY = Symbol('unscoped');    // abortFlagName 未指定の呼び出し用の系統キー
const _pauseUntilBySystem   = new Map();     // 系統キー -> ポーズ解除時刻(ms)
const _pauseAnnouncedSystem = new Set();     // 「waiting Ns」を告知済みの系統キー
const GLOBAL_ESCALATION_MIN_SYSTEMS = 2;     // 同時ポーズでグローバル昇格する最小系統数
let   _globalPauseUntilMs   = 0;             // 0 = グローバル昇格していない
let   _globalPauseAnnounced = false;
const _NETWORK_ERRORS   = new Set([
  'ERR_NETWORK_IO_SUSPENDED', 'ERR_INTERNET_DISCONNECTED',
  'ERR_NETWORK_CHANGED', 'ERR_CONNECTION_RESET',
  'ERR_TIMED_OUT', 'net::ERR_NETWORK_IO_SUSPENDED',
  // バグ修正(2026-07-27 実運用で確認): ERR_NAME_NOT_RESOLVED(DNS解決失敗)が
  // このSetにも下の正規表現にも一致しておらず、_isNetworkError()がfalseを
  // 返していた。そのためDNSリゾルバの一時的な不調時にグローバルポーズが
  // 発動せず、concurrency分のワーカー全員が個別にリトライを繰り返す形と
  // なり、turboジョブで500件中500件が全滅する事象につながった
  // (debug-summary.mdで確認: 5回連続空応答→再ウォーム→回復せず、その後
  //  ERR_NAME_NOT_RESOLVEDが連発してバッチ全滅)。DNS障害はネットワーク断と
  // 同様に全ワーカーが足並みを揃えて待つべき系統的失敗のため追加する。
  'ERR_NAME_NOT_RESOLVED', 'net::ERR_NAME_NOT_RESOLVED',
  'ERR_ADDRESS_UNREACHABLE', 'ERR_CONNECTION_REFUSED',
]);
const _PAUSE_DURATION   = 30_000;   // 30秒待機してからリトライ

// リトライ/スロットル待機の上限（指数バックオフが際限なく伸びるのを防ぐ）
const _MAX_BACKOFF_MS = 60_000;

// ±20%のランダムジッター。複数ワーカーが同じ待機時間で揃うと、DLsite側から
// 見て規則的なリクエストパターンになりやすい（スロットリング/ブロックの
// 引き金になりうる）ため、待機のたびに分散させる。
function _jitter(ms) {
  const spread = ms * 0.2;
  return Math.round(ms - spread + Math.random() * spread * 2);
}

function _cappedBackoff(ms) {
  return _jitter(Math.min(ms, _MAX_BACKOFF_MS));
}

function _isNetworkError(msg) {
  return _NETWORK_ERRORS.has(msg) ||
    /ERR_NETWORK|NETWORK_IO_SUSPENDED|ECONNRESET|ETIMEDOUT|NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN|ECONNREFUSED/.test(msg);
}

/**
 * 中止シグナル対応の sleep。通常の sleep() と違い、abortFlagName に対応する
 * AbortSignal が abort() されたら待機時間の途中でも即座に返る。
 * これにより「中止ボタンを押したのにバックオフ待機が終わるまで反応しない」
 * バグ（最大60秒の指数バックオフ、Retry-Afterによる更に長い待機、
 * ネットワーク断ポーズの30秒など）を解消する。
 */
function _abortableSleep(ms, abortFlagName) {
  if (!abortFlagName) return sleep(ms);
  const signal = getAbortSignal(abortFlagName);
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const onAbort = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function _isAborted(abortFlagName) {
  return !!abortFlagName && getAbortSignal(abortFlagName).aborted;
}

function _systemKey(abortFlagName) { return abortFlagName ?? _UNSCOPED_KEY; }

/** 現時点でポーズ中(期限切れでない)の系統数を数える。グローバル昇格判定に使う。 */
function _countActivePausedSystems(now) {
  let n = 0;
  for (const until of _pauseUntilBySystem.values()) if (until > now) n++;
  return n;
}

async function _waitForNetwork(abortFlagName) {
  const key = _systemKey(abortFlagName);
  const now = Date.now();
  const sysUntil = _pauseUntilBySystem.get(key) ?? 0;
  // グローバル昇格中はどの系統(自分がまだポーズしていない系統も含む)も
  // 一律で待つ。そうでなければ自分の系統のポーズ期限のみに従う。
  const until = Math.max(sysUntil, _globalPauseUntilMs);
  if (until <= now) return;

  const remaining = until - now;
  const isGlobal  = _globalPauseUntilMs >= sysUntil;
  const label     = isGlobal ? '全系統' : `系統:${String(abortFlagName ?? 'unscoped')}`;
  const announced = isGlobal ? _globalPauseAnnounced : _pauseAnnouncedSystem.has(key);

  if (!announced) {
    if (isGlobal) _globalPauseAnnounced = true; else _pauseAnnouncedSystem.add(key);
    log.warn(`[fetch] network pause (${label}): waiting ${Math.ceil(remaining/1000)}s`);
  } else {
    log.trace(`[fetch] network pause (${label}): waiting ${Math.ceil(remaining/1000)}s (duplicate, other worker already announced)`);
  }
  await _abortableSleep(remaining, abortFlagName);

  // 自分の系統のポーズは解除。グローバル昇格の解除は他系統も見ている
  // ため、期限切れ(Date.now() >= _globalPauseUntilMs)に任せてここでは触らない。
  if (sysUntil <= now) return; // グローバル昇格分の待機だけだった場合は系統状態は元々未セット
  _pauseUntilBySystem.delete(key);
  _pauseAnnouncedSystem.delete(key);
}

// ─── グローバル同時接続数セマフォ（系統横断） ────────────────────────────────
// detailFetcher.js / discovery.js / compScan.js はそれぞれ自分の concurrency
// 設定しか見ておらず、他系統が今何本リクエストを飛ばしているか知らないまま
// 独立に動く。ロック(apiServer.jsのsharedKeys)で排他されない組み合わせ
// (turbo内のdetail+newrelease+endingsoonのPromise.all並走、circlegap実行中への
// scheduler定期fetchの割り込み等)では、系統別concurrencyをどれだけ絞っても
// DLsite側から見た合計同時接続数は際限なく積み上がりうる
// (config.js の fetch.globalMaxConcurrent コメント参照)。
// fetchWithRetryは全系統が経由する唯一の関数のため、ここで実際の fetch()
// 呼び出し（リトライ待機・レート制限sleepは含まない）だけを対象にした
// カウンティングセマフォを掛け、系統横断の合計同時接続数そのものをキャップする。
const _GLOBAL_MAX_CONCURRENT = Math.max(1, config.fetch.globalMaxConcurrent ?? 5);
let   _globalActive  = 0;
const _globalWaiters  = [];

/** 実行中のスロットを1つ確保する。空きがなければ空くまで待つ。 */
function _acquireGlobalSlot(abortFlagName) {
  if (_globalActive < _GLOBAL_MAX_CONCURRENT) {
    _globalActive++;
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const waiter = { resolve };
    const signal = abortFlagName ? getAbortSignal(abortFlagName) : null;
    if (signal) {
      const onAbort = () => {
        const idx = _globalWaiters.indexOf(waiter);
        // 既にキューから外れて実行中(=スロット確保済み)ならabortしても
        // ここでは何もしない。fetchWithRetry側のsignal監視がfetch自体を止める。
        if (idx !== -1) {
          _globalWaiters.splice(idx, 1);
          signal.removeEventListener('abort', onAbort);
          reject(new Error('aborted while waiting for global fetch slot'));
        }
      };
      signal.addEventListener('abort', onAbort, { once: true });
      waiter._cleanup = () => signal.removeEventListener('abort', onAbort);
    }
    _globalWaiters.push(waiter);
  });
}

/** スロットを1つ返却する。待機者がいれば直接その待機者へスロットを引き渡す。 */
function _releaseGlobalSlot() {
  const next = _globalWaiters.shift();
  if (next) {
    next._cleanup?.();
    next.resolve();   // スロットは減らさずそのまま次の待機者へ引き渡す
  } else {
    _globalActive = Math.max(0, _globalActive - 1);
  }
}

function globalActiveCount() { return _globalActive; }
function globalWaitingCount() { return _globalWaiters.length; }

/**
 * @param {string} url
 * @param {object} opts
 * @param {string|null} abortFlagName  'detail'/'discovery'/'comp' 等。
 *   指定すると、中止ボタン（abortSignals.abortNow）で fetch 自体・
 *   リトライ待機・ネットワーク断ポーズのいずれも即座に中断できる。
 */
async function fetchWithRetry(url, opts = {}, abortFlagName = null) {
  const maxRetry  = config.fetch.retryMax;
  const baseDelay = config.fetch.retryBaseDelay;
  let last;
  let throttledWait = false;

  for (let i = 0; i <= maxRetry; i++) {
    if (_isAborted(abortFlagName)) throw new Error(`aborted: ${url}`);

    // ネットワーク断ポーズ中は全ワーカーが同期して待機
    await _waitForNetwork(abortFlagName);
    if (_isAborted(abortFlagName)) throw new Error(`aborted: ${url}`);

    if (i > 0 && !throttledWait) {
      const wait = _cappedBackoff(baseDelay * 2 ** (i - 1));
      log.warn(`[fetch] retry ${i}/${maxRetry} wait ${wait}ms`, url);
      await _abortableSleep(wait, abortFlagName);
      if (_isAborted(abortFlagName)) throw new Error(`aborted: ${url}`);
    }
    throttledWait = false;
    try {
      const ctrl = new AbortController();
      const tid  = setTimeout(() => ctrl.abort(), config.fetch.timeout);

      // 中止ボタンが押されたら、進行中の fetch そのものも即座に中断する。
      // (以前は abortFlagName を fetch に一切伝えておらず、停止要求は
      //  次のループチェックまで無視され続けていた)
      const extSignal = abortFlagName ? getAbortSignal(abortFlagName) : null;
      const onExtAbort = () => ctrl.abort();
      if (extSignal) extSignal.addEventListener('abort', onExtAbort, { once: true });

      // グローバル同時接続数セマフォ: 空きスロットが出るまでここで待つ。
      // (バックオフsleep中はスロットを保持しないので、待機自体は無駄にならない)
      await _acquireGlobalSlot(abortFlagName);
      if (_isAborted(abortFlagName)) {
        _releaseGlobalSlot();
        clearTimeout(tid);
        if (extSignal) extSignal.removeEventListener('abort', onExtAbort);
        throw new Error(`aborted: ${url}`);
      }

      let res;
      try {
        // バグ修正: `cache: 'no-store'` は fetch() 呼び出し元(ブラウザ/Electron側)の
        // ローカルキャッシュポリシーを制御するだけで、DLsite側のCDN/エッジキャッシュや
        // 経路上の中間プロキシには一切影響しない。そのため、CDN側が別クエリの
        // レスポンスを誤って(または意図的に)使い回してしまうと、product/info/ajax が
        // 「別バッチの結果」を返し続けることがある(観測例: 全く異なる複数のRJ群に対して
        // 毎回同じ小さな固定キー集合しか返らない → recordApiMissingが誤発火し、
        // 実際には削除されていない作品の優先度が delisted まで落ちてしまう)。
        // 明示的な Cache-Control/Pragma ヘッダーでオリジン/CDN側にも
        // キャッシュ利用禁止を伝える。
        res = await _fetch(url, {
          ...opts,
          headers: {
            ..._baseHeaders,
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Pragma': 'no-cache',
            ...opts.headers,
          },
          cache: 'no-store',
          signal: ctrl.signal,
        });
      } finally {
        clearTimeout(tid);
        if (extSignal) extSignal.removeEventListener('abort', onExtAbort);
        _releaseGlobalSlot();
      }

      if (_isAborted(abortFlagName)) throw new Error(`aborted: ${url}`);

      if (res.status === 429 || res.status === 503) {
        const retryAfter = parseInt(res.headers.get('Retry-After') ?? '0', 10);
        // サーバー明示の Retry-After はそのまま尊重する（ジッターを足さない）。
        // こちら側の指数バックオフのみキャップ+ジッターを適用する。
        const wait = retryAfter > 0
          ? retryAfter * 1000
          : _cappedBackoff(baseDelay * 2 ** i);
        log.warn(`[fetch] ${res.status} throttle – wait ${wait}ms`, url);
        last = new Error(`HTTP ${res.status}`);
        await _abortableSleep(wait, abortFlagName);
        if (_isAborted(abortFlagName)) throw new Error(`aborted: ${url}`);
        throttledWait = true;
        continue;
      }
      // 404は呼び出し元(discovery.js の _fetchWithPrice)が「最終ページ到達」の
      // 正常な終端シグナルとして扱う既知の仕様。ここでWARN扱いにすると、
      // 実際は正常終了なのにエラーが起きたかのようなログノイズになる。
      if (!res.ok && res.status !== 404) log.warn(`[fetch] ${res.status}`, url);
      else if (!res.ok) log.debug(`[fetch] ${res.status} (expected end-of-pages)`, url);
      return res;
    } catch (e) {
      if (_isAborted(abortFlagName)) throw new Error(`aborted: ${url}`);
      last = e;
      const isNetErr = _isNetworkError(e.message);
      const now       = Date.now();
      const key       = _systemKey(abortFlagName);
      const alreadyPaused =
        (_pauseUntilBySystem.get(key) ?? 0) > now || _globalPauseUntilMs > now;

      if (isNetErr && alreadyPaused) {
        // 既に同系統(または昇格済みのグローバル)の他ワーカーがこの
        // エピソードを検知・告知済み。同種の断を追加でwarn連発しても
        // 情報価値が薄いため、traceに落とす(events.jsonlには残る)。
        log.trace(`[fetch] error (${e.message}) — network pause already active, suppressing duplicate warn`, url);
      } else {
        log.warn(`[fetch] error (${e.message})`, url);
      }

      // ネットワーク断を検知したら、まず自分の系統(abortFlagName)だけを
      // ポーズする（既にポーズ済みの場合は上書きしない = 最初の検知者の
      // タイマーを尊重）。無関係な他系統は、自分自身がエラーに遭遇するまで
      // 待たされない。
      if (isNetErr && !alreadyPaused) {
        _pauseUntilBySystem.set(key, now + _PAUSE_DURATION);
        _pauseAnnouncedSystem.delete(key);   // 「waiting Ns」の告知はまだこれから
        log.warn(`[fetch] network error detected [${String(abortFlagName ?? 'unscoped')}] — this system pausing ${_PAUSE_DURATION/1000}s`, e.message);

        // 短時間のうちに複数系統が独立してネットワークエラーを検知した
        // 場合は、単発の系統固有の不調ではなく本当のPC全体のネットワーク断
        // である可能性が高いため、全系統を止めるグローバルポーズへ昇格する
        // (detailFetcher.js のサイト単位サーキットブレーカーの
        //  GLOBAL_CIRCUIT_MIN_SITES と同じ考え方)。
        const activeSystems = _countActivePausedSystems(now);
        if (activeSystems >= GLOBAL_ESCALATION_MIN_SYSTEMS && _globalPauseUntilMs <= now) {
          _globalPauseUntilMs   = now + _PAUSE_DURATION;
          _globalPauseAnnounced = false;
          const pausedList = [..._pauseUntilBySystem.entries()]
            .filter(([, until]) => until > now)
            .map(([k]) => String(k === _UNSCOPED_KEY ? 'unscoped' : k))
            .join(',');
          log.warn(`[fetch] グローバルネットワーク断エスカレーション — ${activeSystems}系統(${pausedList})が同時にネットワークエラーを検知。全系統を${_PAUSE_DURATION/1000}s停止します`);
        }
      }
    }
  }
  throw last ?? new Error(`fetchWithRetry failed: ${url}`);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * 現在ネットワークポーズ中かどうか。
 * @param {string|null} abortFlagName  指定した系統についてのみ確認する場合。
 *   省略時はグローバル昇格中か、いずれかの系統がポーズ中かを返す。
 */
function isNetworkPaused(abortFlagName) {
  const now = Date.now();
  if (_globalPauseUntilMs > now) return true;
  if (abortFlagName !== undefined) {
    return (_pauseUntilBySystem.get(_systemKey(abortFlagName)) ?? 0) > now;
  }
  return _countActivePausedSystems(now) > 0;
}
module.exports = {
  fetchWithRetry, sleep, _isNetworkError, isNetworkPaused,
  globalActiveCount, globalWaitingCount,
};
