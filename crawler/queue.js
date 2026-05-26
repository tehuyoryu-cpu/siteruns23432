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

async function fetchWithRetry(url, opts = {}) {
  const maxRetry  = config.fetch.retryMax;
  const baseDelay = config.fetch.retryBaseDelay;
  let last;

  for (let i = 0; i <= maxRetry; i++) {
    if (i > 0) {
      const wait = baseDelay * 2 ** (i - 1);
      log.warn(`[fetch] retry ${i}/${maxRetry} wait ${wait}ms`, url);
      await sleep(wait);
    }
    try {
      const ctrl = new AbortController();
      const tid  = setTimeout(() => ctrl.abort(), config.fetch.timeout);

      const res = await _fetch(url, {
        ...opts,
        headers: { ..._baseHeaders, ...opts.headers },
        signal: ctrl.signal,
      });
      clearTimeout(tid);

      if (res.status === 429 || res.status === 503) {
        log.warn(`[fetch] ${res.status} throttle`, url);
        last = new Error(`HTTP ${res.status}`);
        continue;
      }
      if (!res.ok) log.warn(`[fetch] ${res.status}`, url);
      return res;
    } catch (e) {
      last = e;
      log.warn(`[fetch] error (${e.message})`, url);
    }
  }
  throw last ?? new Error(`fetchWithRetry failed: ${url}`);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

module.exports = { fetchWithRetry, sleep };
