'use strict';

/**
 * test/detailFetcher.test.js
 *
 * crawler/detailFetcher.js の内部状態機械のユニットテスト。
 *
 * 対象:
 *   1. _schedule() — 次回チェック間隔・優先度の決定テーブル
 *      (config.checkInterval/config.priorityの分岐は、memory記録上
 *       最も頻繁にバグ修正されてきた部類のロジックの一つ)
 *   2. _ageDays() — 発売日からの経過日数計算
 *   3. サーキットブレーカー(_recordApiEmptyAndMaybeRecover/_recordApiSuccess/
 *      _shouldSkipRequest/_resetSessionHealthState)の状態遷移、および
 *      2サイト同時オープンでのグローバル抑制エスカレーション
 *      (_maybeEscalateToGlobalCircuit)
 *
 * detailFetcher.js は起動時に crawler/db.js(better-sqlite3)を require するため、
 * このテストの実行には db.test.js 同様ネイティブモジュールが正しくビルド/配置
 * されている必要がある(このテスト自体はDBへ一切アクセスしない純粋な内部状態の
 * 検証のみ)。
 *
 * __testHooks は本番コード(scheduler.js/apiServer.js等)からは使用しない
 * テスト専用の追加公開であり、requireするだけでは何の副作用も発生しない
 * (既存の動作は一切変更していない)。
 *
 * 実行: node test/detailFetcher.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

// detailFetcher.js は require 時に crawler/db.js(better-sqlite3)を読み込むため、
// db.test.js と同様に DLSITE_DATA_DIR を専用の一時ディレクトリへ向けておく
// (実際にDBファイルを作成/使用することはこのテストでは無いが、他のテスト/
//  本番DBと衝突しないよう安全側に倒す)。
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dlsite-detailfetcher-test-'));
process.env.DLSITE_DATA_DIR = tmpDir;

const config  = require(path.join(__dirname, '..', 'config'));
const { __testHooks } = require(path.join(__dirname, '..', 'crawler', 'detailFetcher'));
const {
  _schedule, _ageDays,
  _recordApiSuccess, _recordApiEmptyAndMaybeRecover, _resetSessionHealthState,
  _shouldSkipRequest, _isInRateLimitBackoff, _isInGlobalBackoff,
  EMPTY_STREAK_THRESHOLD, GLOBAL_CIRCUIT_MIN_SITES,
} = __testHooks;

let pass = 0, fail = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    pass++;
  } catch (e) {
    fail++;
    failures.push({ name, error: e });
  }
}

async function asyncTest(name, fn) {
  try {
    await fn();
    pass++;
  } catch (e) {
    fail++;
    failures.push({ name, error: e });
  }
}

function daysAgo(n) {
  return new Date(Date.now() - n * 86400000).toISOString();
}

// ════════════════════════════════════════════════════════════════════════════
// _schedule() — 優先度・チェック間隔の決定テーブル
// ════════════════════════════════════════════════════════════════════════════

test('セール中は他条件に優先してonSaleへ分類される(新着かつ0連続無変化でも)', () => {
  const r = _schedule(
    { release_date: daysAgo(0), dl_count: 0 },
    { is_on_sale: 1 },
    0
  );
  assert.strictEqual(r.priority, config.priority.onSale);
  assert.strictEqual(r.interval, config.checkInterval.onSale);
});

test('セール中でなくても連続無変化5回以上はcoldへ分類される(新着でも)', () => {
  const r = _schedule(
    { release_date: daysAgo(1), dl_count: 0 },
    { is_on_sale: 0 },
    5
  );
  assert.strictEqual(r.priority, config.priority.cold);
  assert.strictEqual(r.interval, config.checkInterval.cold);
});

test('連続無変化4回(閾値未満)はcoldに落ちず年齢ベースの分類が優先される', () => {
  const r = _schedule(
    { release_date: daysAgo(1), dl_count: 0 },
    { is_on_sale: 0 },
    4
  );
  assert.strictEqual(r.priority, config.priority.newWork);
});

test('発売7日未満はnewWorkへ分類される', () => {
  const r = _schedule({ release_date: daysAgo(6), dl_count: 0 }, { is_on_sale: 0 }, 0);
  assert.strictEqual(r.priority, config.priority.newWork);
  assert.strictEqual(r.interval, config.checkInterval.newWork);
});

test('発売ちょうど7日はnewWorkの境界を外れrecentWorkへ分類される(days<7の厳密な境界)', () => {
  const r = _schedule({ release_date: daysAgo(7), dl_count: 0 }, { is_on_sale: 0 }, 0);
  assert.strictEqual(r.priority, config.priority.recentWork);
});

test('発売7〜29日はrecentWorkへ分類される', () => {
  const r = _schedule({ release_date: daysAgo(29), dl_count: 0 }, { is_on_sale: 0 }, 0);
  assert.strictEqual(r.priority, config.priority.recentWork);
});

test('発売30日以上かつdl_count1000以上はpopularへ分類される', () => {
  const r = _schedule({ release_date: daysAgo(60), dl_count: 1000 }, { is_on_sale: 0 }, 0);
  assert.strictEqual(r.priority, config.priority.popular);
  assert.strictEqual(r.interval, config.checkInterval.popular);
});

test('発売30日以上かつdl_count999(閾値未満)はnormalへ分類される', () => {
  const r = _schedule({ release_date: daysAgo(60), dl_count: 999 }, { is_on_sale: 0 }, 0);
  assert.strictEqual(r.priority, config.priority.normal);
});

test('dl_count未指定(undefined)はnullish coalescingで0扱いされnormalへ分類される', () => {
  const r = _schedule({ release_date: daysAgo(60) }, { is_on_sale: 0 }, 0);
  assert.strictEqual(r.priority, config.priority.normal);
  assert.strictEqual(r.interval, config.checkInterval.normal);
});

// ════════════════════════════════════════════════════════════════════════════
// _ageDays() — 発売日からの経過日数
// ════════════════════════════════════════════════════════════════════════════

test('_ageDays: 30日前の日付でおおよそ30を返す', () => {
  const d = _ageDays(daysAgo(30));
  assert.ok(d >= 29 && d <= 30, `expected ~30, got ${d}`);
});

test('_ageDays: 不正な日付文字列は例外を投げず9999を返す(newWork誤判定によるdelisted化事故の防止)', () => {
  assert.strictEqual(_ageDays('not-a-date'), 9999);
  assert.strictEqual(_ageDays(null), 9999);
  assert.strictEqual(_ageDays(undefined), 9999);
  assert.strictEqual(_ageDays(''), 9999);
});

// ════════════════════════════════════════════════════════════════════════════
// サーキットブレーカー — 単一サイトの状態遷移
// ════════════════════════════════════════════════════════════════════════════
//
// 以下のサーキットブレーカー系テストは全て同一モジュールの共有状態
// (_siteEmptyStreak/_circuitOpenBySite/_globalBackoffUntil等)を直接
// 書き換えるため、Promiseを並行に発火させると前後のテストの状態が
// 混ざって結果が不安定になる。async IIFE内でawaitしながら1つずつ
// 順番に実行する。

(async () => {

await asyncTest('サーキットブレーカー: 空応答がEMPTY_STREAK_THRESHOLD回連続するとサイトが開放される', async () => {
  _resetSessionHealthState();
  assert.strictEqual(_shouldSkipRequest('maniax'), false, '初期状態ではスキップされない');

  // global._reWarmUpSession が未定義(非Electron環境相当)の場合、
  // 閾値到達で即座にサーキットが開く分岐を通る
  for (let i = 0; i < EMPTY_STREAK_THRESHOLD; i++) {
    await _recordApiEmptyAndMaybeRecover('maniax');
  }
  assert.strictEqual(_shouldSkipRequest('maniax'), true, '閾値到達後はスキップされるべき');
});

await asyncTest('サーキットブレーカー: _recordApiSuccessでサイトのサーキットが閉じる', async () => {
  _resetSessionHealthState();
  for (let i = 0; i < EMPTY_STREAK_THRESHOLD; i++) await _recordApiEmptyAndMaybeRecover('maniax');
  assert.strictEqual(_shouldSkipRequest('maniax'), true);

  _recordApiSuccess('maniax');
  assert.strictEqual(_shouldSkipRequest('maniax'), false, '成功記録後はスキップされないべき');
});

await asyncTest('サーキットブレーカー: 閾値未満の空応答streakではサイトは開放されない', async () => {
  _resetSessionHealthState();
  for (let i = 0; i < EMPTY_STREAK_THRESHOLD - 1; i++) await _recordApiEmptyAndMaybeRecover('maniax');
  assert.strictEqual(_shouldSkipRequest('maniax'), false);
});

await asyncTest('_resetSessionHealthState: 実行後は全サイトの状態がクリアされる', async () => {
  for (let i = 0; i < EMPTY_STREAK_THRESHOLD; i++) await _recordApiEmptyAndMaybeRecover('maniax');
  assert.strictEqual(_shouldSkipRequest('maniax'), true);
  _resetSessionHealthState();
  assert.strictEqual(_shouldSkipRequest('maniax'), false, 'リセット後はサーキットが閉じているべき');
});

// ════════════════════════════════════════════════════════════════════════════
// グローバルサーキットエスカレーション(GLOBAL_CIRCUIT_MIN_SITES=2)
// ════════════════════════════════════════════════════════════════════════════

await asyncTest(`グローバル抑制: ${GLOBAL_CIRCUIT_MIN_SITES}サイト未満のオープンではグローバル抑制は発動しない`, async () => {
  _resetSessionHealthState();
  assert.strictEqual(_isInGlobalBackoff(), false);

  // 1サイトだけをオープンにする(GLOBAL_CIRCUIT_MIN_SITES=2未満)
  for (let i = 0; i < EMPTY_STREAK_THRESHOLD; i++) await _recordApiEmptyAndMaybeRecover('maniax');
  assert.strictEqual(_isInGlobalBackoff(), false, '1サイトのみのオープンではグローバル抑制は発動しないべき');
});

await asyncTest(`グローバル抑制: ${GLOBAL_CIRCUIT_MIN_SITES}サイトが同時にオープンするとグローバル抑制が発動する`, async () => {
  _resetSessionHealthState();
  assert.strictEqual(_isInGlobalBackoff(), false);

  const sites = ['maniax', 'girls', 'bl'].slice(0, GLOBAL_CIRCUIT_MIN_SITES);
  for (const site of sites) {
    for (let i = 0; i < EMPTY_STREAK_THRESHOLD; i++) await _recordApiEmptyAndMaybeRecover(site);
  }
  assert.strictEqual(_isInGlobalBackoff(), true,
    `${GLOBAL_CIRCUIT_MIN_SITES}サイト同時オープンでグローバル抑制が発動するべき`);

  // グローバル抑制発動中は、まだ自分自身のサーキットを開いていない
  // 第三のサイトへのリクエストも _isInRateLimitBackoff 経由で抑制対象になる
  // (queue.js側の系統別スコープとは別レイヤーの、detailFetcher内蔵の抑制)
  assert.strictEqual(_isInRateLimitBackoff('girls'), true,
    'グローバル抑制中は個別サイトのbackoff判定もtrueを返すべき');
});

// テスト間の汚染防止(後続のnpm test全体実行で他ファイルへ影響しないよう、最後にリセットしておく)
_resetSessionHealthState();

// ── 結果サマリ ───────────────────────────────────────────────────────────────
console.log(`\n[detailFetcher.test.js] ${pass} passed, ${fail} failed`);
if (failures.length) {
  for (const { name, error } of failures) {
    console.error(`\n✗ ${name}`);
    console.error('  ' + (error?.message ?? error));
  }
  process.exitCode = 1;
} else {
  console.log('全テスト成功');
}
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }

})();
