'use strict';

/**
 * test/jobs.test.js
 *
 * crawler/jobs/*.js（#1 apiServer分割 ステップ2で抽出したジョブ本体）の
 * ユニットテスト。各ジョブはDB/discovery/detailFetcher等をctx引数として
 * 受け取る設計にしたため、require.cacheモックは不要でプレーンなモック
 * オブジェクトを渡すだけでテストできる。
 *
 * 特に重点的に検証するのは以下2点:
 *   1. turbo.js が(apiServer.js側のsharedKeysに再登録される等で)
 *      自分自身のロックを相手に無駄な中断待ちをしないこと
 *      (#1ジョブ分割時に発見・修正したバグの回帰防止)
 *   2. all.js/turbo.js が返す tokens が finally解放に使われる想定の形
 *      (detail/discoveryキー)になっていること
 *
 * 実行: node test/jobs.test.js
 */

const assert = require('assert');
const path   = require('path');

let pass = 0, fail = 0;
const failures = [];
const _tests = [];
function test(name, fn) { _tests.push({ name, fn }); }

function _resetGlobals() {
  global._crawlerRunning = {};
  global._crawlerAbort   = {};
}

function _noopLog() {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

/** 最小構成のctxを作り、テストごとに必要なフィールドだけ上書きして使う */
function _baseCtx(overrides = {}) {
  const lockManager = require(path.join(__dirname, '..', 'crawler', 'lockManager'));
  const progress = {};
  const sseEvents = [];
  return {
    sseSend: (ev, data) => sseEvents.push([ev, data]),
    _sseEvents: sseEvents,
    progress,
    log: _noopLog(),
    config: { fetch: { turboRateLimit: 200, turboConcurrency: 6, concurrency: 3 } },
    db: {
      getCirclesOnSale: () => [],
      boostCirclesBulk: () => {},
      syncCircleWorksCounts: () => {},
    },
    lockManager,
    resetAbortFlag: () => {},
    checkHighErrorRate: () => ({ highErrorRate: false, errorRate: null }),
    notifyPriceChange: () => {},
    discovery: {
      runDiscovery:      async () => ({ discovered: 3 }),
      runFullScan:       async () => ({ grandTotal: 0 }),
      runEndingSoonScan: async () => ({ newCount: 1, boostedCount: 2 }),
      runNewReleaseScan: async () => ({ grandTotal: 5 }),
      runCircleGapScan:  async () => ({ checked: 1, totalCircles: 1, totalMissing: 0, missingByCircle: {}, skippedInvalidSite: 0 }),
    },
    detailFetcher: {
      runDetailFetch: async () => ({ processed: 10, priceChanges: 2, errors: 0 }),
    },
    compScan: {
      runListingScan: async () => ({ added: 4 }),
      runDetailScan:  async () => ({ processed: 1, direct: 1, confirmed: 0, pending: 0, errors: 0 }),
    },
    runExportShards: async () => ({ works: 100, dataShardFiles: 5, idxShardFiles: 2 }),
    ...overrides,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// 単純ジョブの基本動作
// ════════════════════════════════════════════════════════════════════════════

test('discover.js: 正常完了でresult.ok=trueを返す', async () => {
  _resetGlobals();
  const job = require('../crawler/jobs/discover');
  const ctx = _baseCtx();
  const { result, tokens } = await job(ctx, { job: 'discover' });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.discovered, 3);
  assert.strictEqual(result.stopped, false);
  assert.strictEqual(tokens, undefined, '単純ジョブはtokensを返さない');
  assert.ok(ctx._sseEvents.length > 0);
});

test('discover.js: 中止フラグが立っていればstopped=trueになる', async () => {
  _resetGlobals();
  global._crawlerAbort.discovery = true;
  const job = require('../crawler/jobs/discover');
  const { result } = await job(_baseCtx(), { job: 'discover' });
  assert.strictEqual(result.stopped, true);
});

test('fetch.js: priceChanges>0でnotifyPriceChangeが呼ばれる', async () => {
  _resetGlobals();
  let notified = null;
  const ctx = _baseCtx({ notifyPriceChange: (n) => { notified = n; } });
  const job = require('../crawler/jobs/fetch');
  const { result } = await job(ctx, { job: 'fetch' });
  assert.strictEqual(result.processed, 10);
  assert.strictEqual(notified, 2);
});

test('saleboost.js: resultはnull(従来通り進捗記録なし)', async () => {
  _resetGlobals();
  const job = require('../crawler/jobs/saleboost');
  const { result } = await job(_baseCtx(), { job: 'saleboost' });
  assert.strictEqual(result, null);
});

test('fullscan.js: job名からsaleフラグを正しく判定する', async () => {
  _resetGlobals();
  let capturedSale = null;
  const ctx = _baseCtx({
    discovery: { runFullScan: async (opts) => { capturedSale = opts.sale; return { grandTotal: 1 }; } },
  });
  const job = require('../crawler/jobs/fullscan');
  await job(ctx, { job: 'fullscan_sale' });
  assert.strictEqual(capturedSale, true);
  await job(ctx, { job: 'fullscan' });
  assert.strictEqual(capturedSale, false);
});

// ════════════════════════════════════════════════════════════════════════════
// all.js / turbo.js: ロック取得の核心的な回帰テスト
// ════════════════════════════════════════════════════════════════════════════

test('all.js: 何も実行中でなければ即座にロックを取得し、tokensを返す', async () => {
  _resetGlobals();
  const job = require('../crawler/jobs/all');
  const ctx = _baseCtx();
  const t0 = Date.now();
  const { result, tokens } = await job(ctx, { job: 'all' });
  const elapsed = Date.now() - t0;
  assert.strictEqual(result.ok, true);
  assert.strictEqual(typeof tokens.detail, 'symbol');
  assert.strictEqual(typeof tokens.discovery, 'symbol', 'Phase1で自前収集した場合はdiscoveryトークンも返るべき');
  assert.ok(elapsed < 500, `空いている状態からの実行は高速であるべき(実測${elapsed}ms)`);
  assert.strictEqual(ctx.lockManager.isBusy('detail'), true, '呼び出し元(apiServer.js)がfinallyで解放する前提のため、ここではまだ保持されている');
});

test('turbo.js: 何も実行中でなければ即座にロックを取得する(#1ジョブ分割で発見したバグの直接的な回帰テスト)', async () => {
  _resetGlobals();
  const job = require('../crawler/jobs/turbo');
  const ctx = _baseCtx();
  const t0 = Date.now();
  const { result, tokens } = await job(ctx, { job: 'turbo' });
  const elapsed = Date.now() - t0;
  assert.strictEqual(result.ok, true);
  assert.strictEqual(typeof tokens.detail, 'symbol');
  assert.strictEqual(typeof tokens.discovery, 'symbol');
  // かつての不具合: apiServer.js の sharedKeys に 'turbo':'detail' が登録されていたため、
  // ジョブ本体が呼ばれる前にpreambleが自分自身の分としてdetailロックを確保してしまい、
  // turbo.js内のabortAndTakeover('detail',...)が「今実行中の他ジョブ」と誤認して
  // 誰も解放しないロックの解放をtimeoutMs(本番15秒)いっぱいまで無駄に待っていた。
  // このテストはジョブ本体レベルでその種の自己待機が発生していないことを保証する
  // (実際の不具合はapiServer.js側の設定ミスだったため、これはturbo.js自体の
  //  ロジックが正しいことの確認であり、設定側の回帰はapiServer.jsのコメントで防止する)。
  assert.ok(elapsed < 500, `空いている状態からの実行は高速であるべき(実測${elapsed}ms、旧不具合下では15000ms以上かかっていた)`);
});

test('turbo.js: 実際に他ジョブがdetailロックを保持している場合は中断要求してから取得する', async () => {
  _resetGlobals();
  const lockManager = require('../crawler/lockManager');
  const existingToken = lockManager.acquire('detail', 'fetch'); // 他ジョブが実行中を模倣
  // 「既存の実行」が中断フラグを見て自発的に解放する動きをシミュレート
  const watcher = setInterval(() => {
    if (global._crawlerAbort.detail) {
      clearInterval(watcher);
      lockManager.releaseOwned('detail', existingToken);
    }
  }, 10);

  const job = require('../crawler/jobs/turbo');
  const ctx = _baseCtx();
  const { tokens } = await job(ctx, { job: 'turbo' });
  assert.strictEqual(typeof tokens.detail, 'symbol');
  assert.notStrictEqual(tokens.detail, existingToken, '新しい所有者トークンに切り替わっているべき');
  assert.ok(ctx._sseEvents.some(([ev, msg]) => ev === 'log' && String(msg).includes('価格更新')),
    '中断して引き継いだことをSSEで通知すべき');
});

test('all.js: discoveryが既に実行中なら自分では収集せず完了を待つ(discovered:0のまま)', async () => {
  _resetGlobals();
  const lockManager = require('../crawler/lockManager');
  const existingToken = lockManager.acquire('discovery', 'discover');
  setTimeout(() => lockManager.releaseOwned('discovery', existingToken), 30);

  let discoveryCalled = false;
  const ctx = _baseCtx({
    discovery: {
      runDiscovery: async () => { discoveryCalled = true; return { discovered: 999 }; },
    },
  });
  const job = require('../crawler/jobs/all');
  const { result, tokens } = await job(ctx, { job: 'all' });
  assert.strictEqual(discoveryCalled, false, "他ジョブ実行中は'all'自身がrunDiscoveryを呼んではいけない");
  assert.strictEqual(result.discovered, 0);
  assert.strictEqual(tokens.discovery, null, 'Phase1で自前取得しなかった場合はdiscoveryトークンはnullのまま');
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
  console.log(`\n[jobs.test.js] ${pass} passed, ${fail} failed`);
  if (fail > 0) { console.log('一部テスト失敗'); process.exitCode = 1; }
  else console.log('全テスト成功');
})();
