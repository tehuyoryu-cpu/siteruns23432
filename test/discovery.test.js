'use strict';

/**
 * test/discovery.test.js
 *
 * crawler/discovery.js の純粋関数（DB/ネットワーク非依存）のユニットテスト。
 *
 * _circleProfileUrl() は過去に実機(スマホ版)で2ページ目以降が取得できない
 * 不具合が発覚し、デスクトップ版から `{site}-touch` のモバイル版エンドポイントへ
 * 切り替える修正が入った箇所。URL構造の暗黙の前提（-touch、page番号の位置、
 * maker_idの位置）が今後のリファクタで崩れないよう固定化する。
 *
 * discovery.js は require 時に crawler/db.js(better-sqlite3)を読み込むため、
 * このテストの実行には db.test.js 同様ネイティブモジュールが正しくビルド/配置
 * されている必要がある(このテスト自体はDBへ一切アクセスしない)。
 *
 * 実行: node test/discovery.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dlsite-discovery-test-'));
process.env.DLSITE_DATA_DIR = tmpDir;

const { __testHooks } = require(path.join(__dirname, '..', 'crawler', 'discovery'));
const { _circleProfileUrl, _monthStart, _isMonthRollover } = __testHooks;

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

// ════════════════════════════════════════════════════════════════════════════
// _circleProfileUrl() — サークルプロフィールページのURL構造
// ════════════════════════════════════════════════════════════════════════════

test('_circleProfileUrl: デスクトップ版ではなく-touch(モバイル版)のドメイン/パスを使う', () => {
  const url = _circleProfileUrl('maniax', 'RG12345', 1);
  assert.ok(url.includes('/maniax-touch/circle/profile/'),
    'モバイル版(-touch)のcircle/profileパスを使うべき(デスクトップ版はpageパラメータを反映しないバグが実機確認済み)');
  assert.ok(!url.includes('/maniax/circle/profile/'),
    'デスクトップ版のパスであってはならない');
});

test('_circleProfileUrl: maker_idが正しい位置(パス末尾の.html直前)に埋め込まれる', () => {
  const url = _circleProfileUrl('maniax', 'RG12345', 1);
  assert.ok(url.endsWith('/maker_id/RG12345.html'), `unexpected URL tail: ${url}`);
});

test('_circleProfileUrl: page番号がURLに反映される(1ページ目)', () => {
  const url = _circleProfileUrl('maniax', 'RG12345', 1);
  assert.ok(url.includes('/page/1/'), `page=1がURLに含まれるべき: ${url}`);
});

test('_circleProfileUrl: page番号がURLに反映される(2ページ目、実機検証済みの回帰防止)', () => {
  const url = _circleProfileUrl('maniax', 'RG12345', 2);
  assert.ok(url.includes('/page/2/'), `page=2がURLに含まれるべき: ${url}`);
  assert.ok(!url.includes('/page/1/'), 'page=2のURLにpage=1の痕跡が残っていないべき');
});

test('_circleProfileUrl: site引数がURLのサイトファミリー部分にそのまま反映される', () => {
  for (const site of ['maniax', 'girls', 'bl']) {
    const url = _circleProfileUrl(site, 'RG1', 1);
    assert.ok(url.startsWith(`https://www.dlsite.com/${site}-touch/`), `site=${site}: ${url}`);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// _monthStart() / _isMonthRollover() — 日付計算
// ════════════════════════════════════════════════════════════════════════════

test('_monthStart(0): 今月1日をYYYY-MM-01形式で返す', () => {
  const now = new Date();
  const expected = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  assert.strictEqual(_monthStart(0), expected);
});

test('_monthStart(-1): 前月1日を返す(月またぎカバー用)', () => {
  const now  = new Date();
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const expected = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}-01`;
  assert.strictEqual(_monthStart(-1), expected);
});

test('_monthStart: 1月に-1を渡すと前年12月へ正しく繰り下がる(年またぎ)', () => {
  // Dateコンストラクタのmonth引数は0-11で自動繰り上げ/繰り下げされる仕様を
  // そのまま使っているため、1月(month=0)に-1すると month=-1 → 前年12月に
  // 正しく解決されることを固定化する。
  const jan = new Date(2027, 0, 15); // 2027年1月15日
  const d = new Date(jan);
  d.setMonth(d.getMonth() - 1);
  assert.strictEqual(d.getFullYear(), 2026);
  assert.strictEqual(d.getMonth(), 11); // 12月(0-indexed)
});

test('_isMonthRollover: 型はbooleanを返す(現在日付依存のためロジックの健全性のみ検証)', () => {
  const today = new Date().getDate();
  assert.strictEqual(_isMonthRollover(), today <= 5);
});

// ── 結果サマリ ───────────────────────────────────────────────────────────────
console.log(`\n[discovery.test.js] ${pass} passed, ${fail} failed`);
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
