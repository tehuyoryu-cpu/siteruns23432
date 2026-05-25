'use strict';

// Use Electron net.fetch when available (Chromium stack, bypasses Cloudflare).
// Falls back to global fetch in Node.js CLI mode.
const _netFetch = (() => {
  try { const { net } = require('electron'); return net.fetch.bind(net); }
  catch { return (...a) => fetch(...a); }
})();

/**
 * crawler/queue.js
 * シンプルなfetch wrapper。レート制限・リトライ。
 */

const config = require('../config');
const log    = require('./logger');

const HEADERS = {
  'User-Agent':      config.dlsite.userAgent,
  'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'ja,en;q=0.5',
  'Referer':         'https://www.dlsite.com/',
  'Cookie':          config.dlsite.cookies,
};

/** fetch with timeout + retry (exponential backoff) */
async function fetchWithRetry(url, opts = {}) {
  const max   = config.fetch.retryMax;
  const delay = config.fetch.retryBaseDelay;
  let last;

  for (let i = 0; i <= max; i++) {
    if (i > 0) {
      const wait = delay * 2 ** (i - 1);
      log.warn(`[fetch] retry ${i}/${max} wait ${wait}ms`, url);
      await sleep(wait);
    }
    try {
      const ctrl = new AbortController();
      const tid  = setTimeout(() => ctrl.abort(), config.fetch.timeout);
      const res  = await fetch(url, {
        ...opts,
        headers: { ...HEADERS, ...opts.headers },
        signal: ctrl.signal,
      });
      clearTimeout(tid);

      if (res.status === 429 || res.status === 503) {
        log.warn(`[fetch] ${res.status} throttle`, url);
        last = new Error(`HTTP ${res.status}`);
        continue;
      }

      if (!res.ok) {
        log.warn(`[fetch] ${res.status}`, url);
      }
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
