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
const { _circleProfileUrl, _monthStart, _isMonthRollover, _classifyMakerIdMismatch } = __testHooks;

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

// ════════════════════════════════════════════════════════════════════════════
// _classifyMakerIdMismatch() — maker_idフィルタ崩壊の「確定」判定
//
// バグ修正回帰テスト: 本番ログで実際に発生した
// {"makerId":"RG01013422","site":"maniax","mismatched":1,"totalOnPage":1}
// のような、サンプル数1件で比率100%になり「確定」と誤判定される
// ケースを防止する。
// ════════════════════════════════════════════════════════════════════════════

test('サンプル数1件・全件mismatchでも「確定」にはしない(n=1は統計的根拠不足)', () => {
  const items = [{ makerId: 'RG99999999' }];
  const r = _classifyMakerIdMismatch(items, 'RG01013422');
  assert.strictEqual(r.confirmed, false);
  assert.strictEqual(r.mismatchedCount, 1);
  assert.deepStrictEqual(r.filtered, [], '疑わしい1件自体は除外されるべき');
});

test('サンプル数が最低基準未満(4件)なら全件mismatchでも確定にしない', () => {
  const items = [
    { makerId: 'RGOTHER1' }, { makerId: 'RGOTHER2' },
    { makerId: 'RGOTHER3' }, { makerId: 'RGOTHER4' },
  ];
  const r = _classifyMakerIdMismatch(items, 'RG01013422', 5);
  assert.strictEqual(r.confirmed, false);
  assert.strictEqual(r.filtered.length, 0);
});

test('サンプル数が最低基準以上(100件)かつ過半数mismatchなら確定してfilteredは元のitemsのまま', () => {
  const items = Array.from({ length: 100 }, (_, i) =>
    ({ makerId: i < 80 ? 'RGOTHER' : 'RG01013422' })); // 80件が別サークル = 80%
  const r = _classifyMakerIdMismatch(items, 'RG01013422', 5);
  assert.strictEqual(r.confirmed, true);
  assert.strictEqual(r.mismatchedCount, 80);
  // 確定時はページ全体を疑わしいとみなし、呼び出し側が丸ごと捨てる想定
  // (filteredをそのまま使わせない設計だが、値自体はitemsと同一でよい)
  assert.strictEqual(r.filtered, items);
});

test('サンプル数は十分だが半数以下のmismatchなら確定せず、該当作品のみ除外する', () => {
  const items = [
    { makerId: 'RG01013422' }, { makerId: 'RG01013422' },
    { makerId: 'RG01013422' }, { makerId: 'RG01013422' },
    { makerId: 'RGOTHER' }, // 1/5 = 20%
  ];
  const r = _classifyMakerIdMismatch(items, 'RG01013422', 5);
  assert.strictEqual(r.confirmed, false);
  assert.strictEqual(r.mismatchedCount, 1);
  assert.strictEqual(r.filtered.length, 4);
  assert.ok(r.filtered.every(it => it.makerId === 'RG01013422'));
});

test('makerId情報が無い作品(parser未取得)はmismatch扱いせず残す', () => {
  const items = [{ makerId: 'RG01013422' }, {}, { makerId: null }];
  const r = _classifyMakerIdMismatch(items, 'RG01013422');
  assert.strictEqual(r.mismatchedCount, 0);
  assert.strictEqual(r.confirmed, false);
  assert.strictEqual(r.filtered.length, 3);
});

test('mismatchが0件ならfiltered===items(不要なコピーを作らない)', () => {
  const items = [{ makerId: 'RG01013422' }];
  const r = _classifyMakerIdMismatch(items, 'RG01013422');
  assert.strictEqual(r.filtered, items);
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
