'use strict';

/**
 * test/lockManager.test.js
 *
 * crawler/lockManager.js（#1 apiServer分割 ステップ1で抽出）のユニットテスト。
 * global._crawlerRunning / global._crawlerAbort という共有状態に依存するため、
 * 各テストの前後で確実にリセットする。
 *
 * 実行: node test/lockManager.test.js
 */

const assert = require('assert');
const path   = require('path');

let pass = 0, fail = 0;
const failures = [];

// 全テストがglobal._crawlerRunning/_crawlerAbortという共有可変状態に
// 依存するため、Promise.all等で並行実行すると互いの状態リセットが
// 競合してしまう。登録だけ即座に行い、実行は末尾で1件ずつawaitする。
const _tests = [];
function test(name, fn) {
  _tests.push({ name, fn });
}

function _resetGlobals() {
  global._crawlerRunning = {};
  global._crawlerAbort   = {};
  // abortSignals.js はモジュールスコープでControllerを保持するため、
  // requireキャッシュごとクリアして完全に独立させる。
  delete require.cache[require.resolve('../crawler/abortSignals')];
  delete require.cache[require.resolve('../crawler/lockManager')];
}

// ════════════════════════════════════════════════════════════════════════════
// isBusy / acquire / releaseOwned
// ════════════════════════════════════════════════════════════════════════════

test('acquire: ロックを取得するとisBusyがtrueになる', () => {
  _resetGlobals();
  const lm = require('../crawler/lockManager');
  assert.strictEqual(lm.isBusy('detail'), false);
  const token = lm.acquire('detail');
  assert.strictEqual(lm.isBusy('detail'), true);
  assert.strictEqual(typeof token, 'symbol');
});

test('releaseOwned: 自分のトークンなら解放できる', () => {
  _resetGlobals();
  const lm = require('../crawler/lockManager');
  const token = lm.acquire('detail');
  const released = lm.releaseOwned('detail', token);
  assert.strictEqual(released, true);
  assert.strictEqual(lm.isBusy('detail'), false);
});

test('releaseOwned: 横取りされたロックは他人のトークンでは解放できない(構造的安全性の核心)', () => {
  _resetGlobals();
  const lm = require('../crawler/lockManager');
  const tokenA = lm.acquire('detail'); // 例: scheduler由来
  // 横取り: 別の所有者が同じキーを再取得(acquireは無条件取得の設計)
  const tokenB = lm.acquire('detail'); // 例: 'all'ジョブ由来
  // 古いトークンAでの解放は失敗し、Bのロックを壊さない
  const releasedByA = lm.releaseOwned('detail', tokenA);
  assert.strictEqual(releasedByA, false, '他人(横取りされる前の所有者)のトークンでは解放できてはいけない');
  assert.strictEqual(lm.isBusy('detail'), true, 'Bが取得したロックが生きたままであるべき');
  // Bによる解放は成功する
  const releasedByB = lm.releaseOwned('detail', tokenB);
  assert.strictEqual(releasedByB, true);
  assert.strictEqual(lm.isBusy('detail'), false);
});

test('releaseOwned: トークンがnull/undefinedなら何もせずfalseを返す', () => {
  _resetGlobals();
  const lm = require('../crawler/lockManager');
  lm.acquire('detail');
  assert.strictEqual(lm.releaseOwned('detail', null), false);
  assert.strictEqual(lm.isBusy('detail'), true);
});

test('releaseUnconditional: 所有者チェックなしで解放する', () => {
  _resetGlobals();
  const lm = require('../crawler/lockManager');
  lm.acquire('pushdata');
  lm.releaseUnconditional('pushdata');
  assert.strictEqual(lm.isBusy('pushdata'), false);
});

// ════════════════════════════════════════════════════════════════════════════
// resetAbort / requestAbort
// ════════════════════════════════════════════════════════════════════════════

test('requestAbort → resetAbort: フラグの発火とリセットが行える', () => {
  _resetGlobals();
  const lm = require('../crawler/lockManager');
  lm.requestAbort('detail');
  assert.strictEqual(global._crawlerAbort.detail, true);
  lm.resetAbort('detail');
  assert.strictEqual(global._crawlerAbort.detail, false);
});

test('requestAbort/resetAbort: 配列で複数キーをまとめて操作できる(turboのdetail+discovery相当)', () => {
  _resetGlobals();
  const lm = require('../crawler/lockManager');
  lm.requestAbort(['detail', 'discovery']);
  assert.strictEqual(global._crawlerAbort.detail, true);
  assert.strictEqual(global._crawlerAbort.discovery, true);
  lm.resetAbort(['detail', 'discovery']);
  assert.strictEqual(global._crawlerAbort.detail, false);
  assert.strictEqual(global._crawlerAbort.discovery, false);
});

// ════════════════════════════════════════════════════════════════════════════
// waitForRelease
// ════════════════════════════════════════════════════════════════════════════

test('waitForRelease: 既に空いていれば即座にtrueで解決する', async () => {
  _resetGlobals();
  const lm = require('../crawler/lockManager');
  const result = await lm.waitForRelease('detail', { timeoutMs: 1000, pollMs: 10 });
  assert.strictEqual(result, true);
});

test('waitForRelease: 途中で解放されればtrueで解決する', async () => {
  _resetGlobals();
  const lm = require('../crawler/lockManager');
  const token = lm.acquire('detail');
  setTimeout(() => lm.releaseOwned('detail', token), 50);
  const result = await lm.waitForRelease('detail', { timeoutMs: 2000, pollMs: 10 });
  assert.strictEqual(result, true);
});

test('waitForRelease: タイムアウトするとfalseで解決する(ロックは奪わない)', async () => {
  _resetGlobals();
  const lm = require('../crawler/lockManager');
  lm.acquire('detail');
  const result = await lm.waitForRelease('detail', { timeoutMs: 100, pollMs: 10 });
  assert.strictEqual(result, false);
  assert.strictEqual(lm.isBusy('detail'), true, 'タイムアウトしてもロックそのものには触れないべき');
});

// ════════════════════════════════════════════════════════════════════════════
// abortAndTakeover
// ════════════════════════════════════════════════════════════════════════════

test('abortAndTakeover: 空いていれば中断要求せずそのまま取得する', async () => {
  _resetGlobals();
  const lm = require('../crawler/lockManager');
  const sseEvents = [];
  const token = await lm.abortAndTakeover('detail', {
    label: '価格更新', sseSend: (ev, d) => sseEvents.push([ev, d]), timeoutMs: 1000,
  });
  assert.strictEqual(typeof token, 'symbol');
  assert.strictEqual(lm.isBusy('detail'), true);
  assert.strictEqual(sseEvents.length, 0, '空いている場合は中断ログを出すべきではない');
});

test('abortAndTakeover: 使用中なら中断要求→解放待ち→取得の順で進む('
  + "'all'/'turbo'の横取りパターン)", async () => {
  _resetGlobals();
  const lm = require('../crawler/lockManager');
  const existingToken = lm.acquire('detail');
  // 「既存の実行」が中断フラグを見て自発的に解放する動きをシミュレート
  const checkAborted = setInterval(() => {
    if (global._crawlerAbort.detail) {
      clearInterval(checkAborted);
      lm.releaseOwned('detail', existingToken);
    }
  }, 10);

  const sseEvents = [];
  const newToken = await lm.abortAndTakeover('detail', {
    label: '価格更新', sseSend: (ev, d) => sseEvents.push([ev, d]), timeoutMs: 2000,
  });

  assert.strictEqual(typeof newToken, 'symbol');
  assert.notStrictEqual(newToken, existingToken);
  assert.strictEqual(lm.isBusy('detail'), true, '新しい所有者としてロックを保持しているべき');
  assert.ok(sseEvents.some(([ev]) => ev === 'log'), '中断中であることをSSEで通知すべき');
  // 引き継ぎ後は中断フラグがリセットされ、次の中断操作に備えられているべき
  assert.strictEqual(global._crawlerAbort.detail, false);
});

test('abortAndTakeover: 相手が反応せずタイムアウトしても最終的には自分が取得する(既存挙動と同じ)', async () => {
  _resetGlobals();
  const lm = require('../crawler/lockManager');
  lm.acquire('detail'); // 誰も解放しないまま放置
  const newToken = await lm.abortAndTakeover('detail', { label: '価格更新', timeoutMs: 100 });
  assert.strictEqual(typeof newToken, 'symbol');
  assert.strictEqual(lm.isBusy('detail'), true);
});

// ════════════════════════════════════════════════════════════════════════════

(async () => {
  for (const { name, fn } of _tests) {
    try {
      await fn();
      pass++;
    } catch (e) {
      fail++;
      failures.push({ name, error: e.message });
    }
  }
  for (const f of failures) console.error(`  ✗ ${f.name}\n    ${f.error}`);
  console.log(`\n[lockManager.test.js] ${pass} passed, ${fail} failed`);
  if (fail > 0) { console.log('一部テスト失敗'); process.exitCode = 1; }
  else console.log('全テスト成功');
})();
