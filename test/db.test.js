'use strict';

/**
 * test/db.test.js
 *
 * crawler/db.js の以下2機能について、実DBファイル(better-sqlite3)を使った
 * 統合テストを行う。
 *   1. recordIntegrityCheck() / getIntegrityCheckHistory() — 定期整合性チェックの履歴化
 *   2. addCompCandidateScored() / decideCompPending() — comp_works へのreasons永続化
 *
 * DB_PATH は crawler/db.js の require 時点で process.env.DLSITE_DATA_DIR から
 * 一度だけ解決されるため、db.js を require する前に一時ディレクトリを
 * 環境変数へセットする必要がある（他のテスト/本番DBと絶対に衝突しないように、
 * 実行のたびに一意な一時ディレクトリを使う）。
 *
 * 実行: node test/db.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dlsite-db-test-'));
process.env.DLSITE_DATA_DIR = tmpDir;

const db = require(path.join(__dirname, '..', 'crawler', 'db'));

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

(async () => {
  await db.init();

  // ── integrity_checks 履歴 ──────────────────────────────────────────────
  await asyncTest('recordIntegrityCheck: 正常なDBはok=trueで記録される', async () => {
    const r = db.recordIntegrityCheck();
    assert.strictEqual(r.ok, true);
    assert.ok(typeof r.durationMs === 'number');
  });

  await asyncTest('getIntegrityCheckHistory: 記録した件数分取得できる（新しい順）', async () => {
    db.recordIntegrityCheck();
    db.recordIntegrityCheck();
    const hist = db.getIntegrityCheckHistory(10);
    assert.ok(hist.length >= 3);
    assert.strictEqual(hist[0].ok, 1);
    // 新しい順（checked_at降順）になっているか
    for (let i = 1; i < hist.length; i++) {
      assert.ok(hist[i - 1].checked_at >= hist[i].checked_at);
    }
  });

  await asyncTest('getIntegrityCheckHistory: 保持上限を超えたら古い記録が間引かれる', async () => {
    for (let i = 0; i < 205; i++) db.recordIntegrityCheck();
    const hist = db.getIntegrityCheckHistory(10000);
    assert.ok(hist.length <= 200, `expected <=200, got ${hist.length}`);
  });

  // ── comp_works の reasons 永続化 ─────────────────────────────────────────
  // 前提となる works 行を用意（外部キー制約は無いが、表示用JOINの確認も兼ねる）
  db.upsertWork({
    rj_code: 'RJ900001', title: '総集編テスト', circle: null, maker_id: null,
    work_type: null, site_id: 'maniax', release_date: null, dl_count: 0,
  });
  db.upsertWork({
    rj_code: 'RJ900002', title: '収録作品テスト(自動確定)', circle: null, maker_id: null,
    work_type: null, site_id: 'maniax', release_date: null, dl_count: 0,
  });
  db.upsertWork({
    rj_code: 'RJ900003', title: '収録作品テスト(要確認→承認)', circle: null, maker_id: null,
    work_type: null, site_id: 'maniax', release_date: null, dl_count: 0,
  });

  test('addCompCandidateScored: 閾値以上はcomp_worksへreasons付きで確定する', () => {
    const reasons = ['タイトル一致度: 0.92', 'サークル一致'];
    const { confirmed, pending } = db.addCompCandidateScored('RJ900001', [
      { rj: 'RJ900002', score: 85, reasons },
    ], 70);
    assert.strictEqual(confirmed, 1);
    assert.strictEqual(pending, 0);

    const detail = db.getCompWorkDetail('RJ900001', 'RJ900002');
    assert.ok(detail, 'comp_works detail should exist');
    assert.strictEqual(detail.source, 'estimated');
    assert.strictEqual(detail.score, 85);
    assert.deepStrictEqual(JSON.parse(detail.reasons), reasons);
  });

  test('addCompCandidateScored: 閾値未満はcomp_pendingへ入りcomp_worksには入らない', () => {
    const { confirmed, pending } = db.addCompCandidateScored('RJ900001', [
      { rj: 'RJ900003', score: 40, reasons: ['タイトル部分一致のみ'] },
    ], 70);
    assert.strictEqual(confirmed, 0);
    assert.strictEqual(pending, 1);
    assert.strictEqual(db.getCompWorkDetail('RJ900001', 'RJ900003'), null);
  });

  test('decideCompPending: 承認時にcomp_pendingのreasonsがcomp_worksへ引き継がれる', () => {
    db.decideCompPending('RJ900001', 'RJ900003', 'approved');
    const detail = db.getCompWorkDetail('RJ900001', 'RJ900003');
    assert.ok(detail, 'approved pair should now exist in comp_works');
    assert.deepStrictEqual(JSON.parse(detail.reasons), ['タイトル部分一致のみ']);
  });

  test('addCompWorksDirect: directソースはscore/reasonsがnullのまま登録される', () => {
    db.upsertWork({
      rj_code: 'RJ900004', title: '直接抽出テスト', circle: null, maker_id: null,
      work_type: null, site_id: 'maniax', release_date: null, dl_count: 0,
    });
    db.addCompWorksDirect('RJ900001', ['RJ900004']);
    const detail = db.getCompWorkDetail('RJ900001', 'RJ900004');
    assert.strictEqual(detail.source, 'direct');
    assert.strictEqual(detail.score, null);
    assert.strictEqual(detail.reasons, null);
  });

  test('getCompWorksForCompilation: 確定済み収録作品をスコア降順で全件返す', () => {
    const list = db.getCompWorksForCompilation('RJ900001');
    const rjs  = list.map(r => r.contained_rj);
    assert.ok(rjs.includes('RJ900002'));
    assert.ok(rjs.includes('RJ900003'));
    assert.ok(rjs.includes('RJ900004'));
  });

  await db.close();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }

  console.log(`\n[db.test.js] ${pass} passed, ${fail} failed`);
  if (failures.length) {
    for (const { name, error } of failures) {
      console.error(`\n✗ ${name}`);
      console.error('  ' + (error?.stack ?? error?.message ?? error));
    }
    process.exitCode = 1;
  } else {
    console.log('全テスト成功');
  }
})().catch(e => {
  console.error('[db.test.js] fatal', e);
  process.exitCode = 1;
});
