'use strict';

/**
 * test/logger.test.js
 *
 * crawler/logger.js の log.trace() / dedupe集約 の挙動を固定化するユニットテスト。
 *
 * 背景: per-item(RJ単位)で大量発生しうる「対処済みの正常系」ログ
 * (no_price_field等のpriceIssue判定、key not in API responseなど)を
 * log.warn/errorからlog.trace()へ格下げし、events.jsonlだけに残す変更を
 * 行った。この変更が正しく機能しているか(=trace()がdlsite-error.logや
 * stdout/stderrを一切汚さず、events.jsonlにだけ書き込まれるか)を固定化する。
 *
 * events.jsonl等への実ファイル書き込みを検証するため、DLSITE_DATA_DIR を
 * 一時ディレクトリに向けてからrequireする(モジュールロード時にパスを
 * 確定させているため、requireより前に環境変数を設定する必要がある)。
 *
 * 実行: node test/logger.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dlsite-logger-test-'));
process.env.DLSITE_DATA_DIR = tmpDir;
// 既定(info)のまま検証する — trace()がLOG_LEVELの抑制を受けないことも
// このテストの重要な確認ポイントのため、あえてdebugには変更しない。
delete process.env.LOG_LEVEL;

const log = require(path.join(__dirname, '..', 'crawler', 'logger'));

let pass = 0, fail = 0;
const failures = [];
const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

function readFileSafe(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

// logger.js は fs.createWriteStream の write() でファイルに書き込んでおり、
// これは非同期I/Oのため呼び出し直後にreadFileSyncしても反映されているとは
// 限らない（ローカルの一時ディレクトリでも数msのラグが起きうる）。
// 小さな待機を挟んでから読み直す。
function flushWrites() {
  return new Promise(r => setTimeout(r, 80));
}

// ── log.trace() は events.jsonl にのみ書き込まれる ────────────────────────────
test('log.trace()はevents.jsonlに書き込まれる', async () => {
  const marker = 'TRACE_MARKER_' + Date.now();
  log.trace('[test] trace only', marker);
  await flushWrites();
  const events = readFileSafe(log.getEventsLogPath());
  assert.ok(events.includes(marker), 'events.jsonlにtraceメッセージが含まれるべき');
});

test('log.trace()はdlsite-tracker.log(main)に書き込まれない', async () => {
  const marker = 'TRACE_NOMAIN_' + Date.now();
  log.trace('[test] trace should not appear in main', marker);
  await flushWrites();
  const main = readFileSafe(log.getLogPath());
  assert.ok(!main.includes(marker), 'main logにtraceメッセージが含まれてはならない');
});

test('log.trace()はdlsite-error.log(error)に書き込まれない', async () => {
  const marker = 'TRACE_NOERR_' + Date.now();
  log.trace('[test] trace should not appear in error log', marker);
  await flushWrites();
  const err = readFileSafe(log.getErrorLogPath());
  assert.ok(!err.includes(marker), 'error logにtraceメッセージが含まれてはならない');
});

test('log.trace()はgetRecentErrors()(ダッシュボードUI用)に積まれない', async () => {
  const marker = 'TRACE_NORECENT_' + Date.now();
  const before = log.getRecentErrors().length;
  log.trace('[test] trace should not appear in recent errors', marker);
  await flushWrites();
  const after = log.getRecentErrors().length;
  assert.strictEqual(after, before, 'recentErrorsの件数が変化してはならない');
});

test('events.jsonlの各行はlevel:"trace"を持つ有効なJSON', async () => {
  const marker = 'TRACE_JSONSHAPE_' + Date.now();
  log.trace('[test] shape check', marker);
  await flushWrites();
  const lines = readFileSafe(log.getEventsLogPath()).trim().split('\n');
  const line  = lines.reverse().find(l => l.includes(marker));
  assert.ok(line, '該当行が見つかるべき');
  const obj = JSON.parse(line);
  assert.strictEqual(obj.level, 'trace');
  assert.ok(obj.msg.includes(marker));
  assert.ok(obj.ts, 'タイムスタンプを持つべき');
});

// ── warn/errorは従来どおりmain/error両方に書き込まれる（trace化の副作用がないことの確認）──
test('log.warn()は従来どおりmain/error両方に書き込まれる', async () => {
  const marker = 'WARN_MARKER_' + Date.now();
  log.warn('[test] normal warn', marker);
  await flushWrites();
  const main = readFileSafe(log.getLogPath());
  const err  = readFileSafe(log.getErrorLogPath());
  assert.ok(main.includes(marker), 'main logにwarnメッセージが含まれるべき');
  assert.ok(err.includes(marker),  'error logにwarnメッセージが含まれるべき');
});

// ── dedupe集約: 閾値超の同種メッセージは個別出力されず、flush()で1行に集約される ──
test('flush()で同種warnが閾値超過分、1行の集約サマリになる', async () => {
  const fp = 'DEDUPE_FINGERPRINT_' + Date.now();
  // フィンガープリントは数字・RJコード・長い16進を正規化するため、
  // 固定文字列のfpを埋め込んだメッセージを複数回発火させる。
  for (let i = 0; i < 6; i++) log.warn(`[test] repeated issue ${fp} item ${i}`);
  log.flush();
  await flushWrites();
  const main = readFileSafe(log.getLogPath());
  const occurrences = main.split(fp).length - 1;
  // DEDUPE_THRESHOLD=3件までは個別出力、残りは1行の集約サマリにまとまる
  // ため、"fp"を含む行の総出現数は 3(個別) + 1(集約サマリ内のsample) = 4 前後に収まるはず
  // (最低でも、6回すべてが個別に出力される7出現(main+error各1などのブレを考慮しても
  //  十分少ない)よりは大幅に少ないことを確認する)。
  assert.ok(occurrences > 0, '出現するはず');
  assert.ok(occurrences < 6, `集約されず${occurrences}件全て個別出力されてしまっている`);
  assert.ok(main.includes('(集約)'), '集約サマリ行が出力されるべき');
});

// ── テスト実行 ───────────────────────────────────────────────────────────────
(async () => {
  for (const { name, fn } of tests) {
    try {
      await fn();
      pass++;
    } catch (e) {
      fail++;
      failures.push({ name, error: e });
    }
  }

  console.log(`\n[logger.test.js] ${pass} passed, ${fail} failed`);
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
