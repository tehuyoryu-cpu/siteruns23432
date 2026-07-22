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

// ── ネットワーク断グローバルポーズ ─────────────────────────────────────────
// ERR_NETWORK_IO_SUSPENDED 等の全接続失敗を検知したとき、
// concurrency=3 の全ワーカーが独立してリトライを繰り返すのを防ぐ。
// 最初にエラーを検知したワーカーがフラグをセットし、全ワーカーが
// ポーズ中はリクエストを送らずに待機する。
let   _networkPaused    = false;
let   _networkPauseMs   = 0;
const _NETWORK_ERRORS   = new Set([
  'ERR_NETWORK_IO_SUSPENDED', 'ERR_INTERNET_DISCONNECTED',
  'ERR_NETWORK_CHANGED', 'ERR_CONNECTION_RESET',
  'ERR_TIMED_OUT', 'net::ERR_NETWORK_IO_SUSPENDED',
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
  return _NETWORK_ERRORS.has(msg) || /ERR_NETWORK|NETWORK_IO_SUSPENDED|ECONNRESET|ETIMEDOUT/.test(msg);
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

async function _waitForNetwork(abortFlagName) {
  if (!_networkPaused) return;
  const remaining = _networkPauseMs - Date.now();
  if (remaining > 0) {
    log.warn(`[fetch] network pause: waiting ${Math.ceil(remaining/1000)}s`);
    await _abortableSleep(remaining, abortFlagName);
  }
  _networkPaused = false;
}

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
      if (!res.ok) log.warn(`[fetch] ${res.status}`, url);
      return res;
    } catch (e) {
      if (_isAborted(abortFlagName)) throw new Error(`aborted: ${url}`);
      last = e;
      log.warn(`[fetch] error (${e.message})`, url);
      // ネットワーク断を検知したらグローバルポーズをセット
      // （既にセット済みの場合は上書きしない = 最初の検知者のタイマーを尊重）
      if (_isNetworkError(e.message) && !_networkPaused) {
        _networkPaused  = true;
        _networkPauseMs = Date.now() + _PAUSE_DURATION;
        log.warn(`[fetch] network error detected — all workers pausing ${_PAUSE_DURATION/1000}s`, e.message);
      }
    }
  }
  throw last ?? new Error(`fetchWithRetry failed: ${url}`);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function isNetworkPaused() { return _networkPaused; }
module.exports = { fetchWithRetry, sleep, _isNetworkError, isNetworkPaused };
