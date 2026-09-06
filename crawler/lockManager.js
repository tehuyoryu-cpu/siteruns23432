'use strict';

/**
 * crawler/lockManager.js
 *
 * apiServer.js / scheduler.js / electron-main.js に渡って重複していた
 * 「共有ロック(global._crawlerRunning)の所有者トークン管理」と
 * 「中断フラグ(global._crawlerAbort)のリセット/発火」のパターンを一元化する。
 *
 * 設計方針:
 *   - 内部状態は引き続き global._crawlerRunning / global._crawlerAbort に
 *     保持する。scheduler.js・electron-main.js は本モジュールを介さず
 *     直接これらのグローバルを読み書きし続けるため(今回はapiServer.js側の
 *     整理のみがスコープ)、同じフィールド名・同じセマンティクスを保つ。
 *   - 所有者トークン方式(Symbol)により、「横取りされたロックを誤って
 *     解放してしまう」バグを構造的に防ぐ。release/releaseOwned は
 *     渡されたトークンが現在の所有者と一致する場合のみ実際に解放する。
 *   - abortSignals.js(abortNow/resetAbortFlag)は既存のまま利用し、
 *     ここでは「どのタイミングでどのキーに対して呼ぶか」の手順を集約する。
 *
 * 注意: このモジュールはロック"管理"のみを担当し、各ジョブの業務ロジック
 * (discovery/detailFetcher呼び出し等)には一切関与しない。
 */

const { abortNow, resetAbortFlag } = require('./abortSignals');

function _shared() {
  if (!global._crawlerRunning) global._crawlerRunning = {};
  return global._crawlerRunning;
}

function _abortState() {
  if (!global._crawlerAbort) global._crawlerAbort = {};
  return global._crawlerAbort;
}

/** 指定キーが現在使用中か(scheduler.js/他ジョブによる占有も含む)。 */
function isBusy(key) {
  return !!_shared()[key];
}

/**
 * 所有者トークン付きでロックを取得する。
 * 既に他者が保持しているかどうかは呼び出し側で isBusy() を見て判断すること
 * (このメソッドは無条件に上書き取得する — 'all'/'turbo' のように
 *  abortAndTakeover() で明け渡しを待ってから取得する用途を想定)。
 * @returns {symbol} このロックの所有者トークン。release()/releaseOwned() に渡す。
 */
function acquire(key, label = key) {
  const shared = _shared();
  const token  = Symbol(`lock-${label}`);
  shared[key]              = true;
  shared[`_${key}Owner`]   = token;
  return token;
}

/** 自分が確保したロックの場合のみ解放する(横取りされていたら何もしない)。 */
function releaseOwned(key, token) {
  if (!token) return false;
  const shared = _shared();
  if (shared[`_${key}Owner`] !== token) return false;
  shared[key]            = false;
  shared[`_${key}Owner`] = null;
  return true;
}

/** 所有者チェックをせず無条件に解放する(sharedKeyがトークン運用されていない場合用)。 */
function releaseUnconditional(key) {
  _shared()[key] = false;
}

/**
 * 指定キーの中断フラグを false にリセットし、abortSignals側の
 * AbortController も使い回されないようにリセットする。
 * ジョブ開始直後、前回の停止操作の残留による誤中断を防ぐために呼ぶ。
 */
function resetAbort(keys) {
  const state = _abortState();
  for (const k of (Array.isArray(keys) ? keys : [keys])) {
    state[k] = false;
    resetAbortFlag(k);
  }
}

/**
 * 指定キーの中断フラグを true にし、進行中のfetch/バックオフ待機も
 * abortSignals経由で即座に中断させる。
 */
function requestAbort(keys) {
  const state = _abortState();
  for (const k of (Array.isArray(keys) ? keys : [keys])) {
    state[k] = true;
    abortNow(k);
  }
}

/**
 * 指定キーが解放される(isBusy(key)===falseになる)まで、または
 * timeoutMsが経過するまで待つ。ロックを奪わず、ただ待つだけ。
 * ('all' Phase1: 実行中のdiscoveryを横取りせず完了を待つ、の一般化)
 * @returns {boolean} 解放を確認して抜けた場合 true、タイムアウトの場合 false
 */
function waitForRelease(key, { timeoutMs = 120_000, pollMs = 1000 } = {}) {
  return new Promise(resolve => {
    if (!isBusy(key)) { resolve(true); return; }
    const start = Date.now();
    const t = setInterval(() => {
      if (!isBusy(key)) {
        clearInterval(t); resolve(true);
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(t); resolve(false);
      }
    }, pollMs);
  });
}

/**
 * 実行中の占有者に中断を要求し、解放されるのを待ってから自分がロックを取得する。
 * ('all' Phase0のdetail横取り、'turbo'の_abortAndTakeLockの一般化)
 *
 * @param {string} key      対象ロック('detail'/'discovery'等)
 * @param {object} opts
 * @param {string} opts.label       ログ/SSEに出す日本語ラベル(例: '価格更新')
 * @param {function} opts.sseSend   (event, data) => void。省略可。
 * @param {number} opts.timeoutMs   中断待ちの上限(既定15秒、既存挙動と同じ)
 * @returns {Promise<symbol>} 取得したロックの所有者トークン
 */
async function abortAndTakeover(key, { label = key, sseSend = null, timeoutMs = 15_000 } = {}) {
  if (isBusy(key)) {
    requestAbort([key]);
    sseSend?.('log', `${label}を中断して引き継ぎます...`);
    await waitForRelease(key, { timeoutMs, pollMs: 150 });
    resetAbort([key]);
  }
  return acquire(key, label);
}

module.exports = {
  isBusy,
  acquire,
  releaseOwned,
  releaseUnconditional,
  resetAbort,
  requestAbort,
  waitForRelease,
  abortAndTakeover,
};
