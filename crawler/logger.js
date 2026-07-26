'use strict';

/**
 * crawler/logger.js
 * ログを stdout/stderr + 複数ファイルに出力:
 *   dlsite-tracker.log  – 全ログ（info以上、人間向けテキスト）
 *   dlsite-error.log    – WARN/ERROR のみ（人間向けテキスト）
 *   digest.log          – ジョブ実行1回につき1行の要約（人間向けテキスト）
 *   events.jsonl         – 全イベントを1行1JSONで記録する構造化ログ（後続の集計・分析用）
 *
 * 「肥大化するだけ」を防ぐための仕組み:
 *   1. サイズベースのローテーション — 各ファイルが上限サイズを超えたら
 *      タイムスタンプ付きファイルに退避し、新規ファイルから書き始める。
 *   2. 保持期間による自動削除 — ローテーション済みファイルは種別ごとの
 *      保持日数を過ぎたら削除する（無限に積み上がらない）。
 *   3. 同種WARN/ERRORの間引き — 同じパターンのメッセージが短時間に連発した
 *      場合、最初の数件だけ書き込み、残りは件数をカウントしておいて
 *      ウィンドウ終了時に「◯◯回発生」の1行にまとめる。
 *   4. ジョブ単位のdigest — 生ログを読まなくても「いつ・何のジョブが・
 *      何件処理して・何が変わったか」を1行で追えるようにする。
 */

const fs   = require('fs');
const path = require('path');

const LEVELS    = { debug: 0, info: 1, warn: 2, error: 3 };
const MIN_LEVEL = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? 1;

const LOG_DIR = process.env.DLSITE_DATA_DIR
  || process.env.PORTABLE_EXECUTABLE_DIR
  || process.cwd();

const PATHS = {
  main:   path.join(LOG_DIR, 'dlsite-tracker.log'),
  error:  path.join(LOG_DIR, 'dlsite-error.log'),
  digest: path.join(LOG_DIR, 'digest.log'),
  events: path.join(LOG_DIR, 'events.jsonl'),
};

// ─── ローテーション/保持設定 ──────────────────────────────────────────────────
const MAX_SIZE_BYTES = {
  main:   20 * 1024 * 1024,
  error:  10 * 1024 * 1024,
  digest:  5 * 1024 * 1024,
  events: 20 * 1024 * 1024,
};
// ローテーション済みファイル(タイムスタンプ付き)を残しておく日数。
// digest/eventsは軽量かつ後から傾向分析したくなることが多いので長めに残す。
const RETENTION_DAYS = {
  main:   14,
  error:  30,
  digest: 90,
  events: 30,
};

// ─── 直近エラー（ダッシュボードUI用） ─────────────────────────────────────────
const _recentErrors = [];
const MAX_ERRORS = 100;

// ─── ストリーム遅延初期化 ──────────────────────────────────────────────────────
const _streams = {};

function _openStream(kind) {
  try {
    const s = fs.createWriteStream(PATHS[kind], { flags: 'a' });
    s.on('error', () => { _streams[kind] = null; });
    return s;
  } catch { return null; }
}

function _getStream(kind) {
  if (_streams[kind]) return _streams[kind];
  _streams[kind] = _openStream(kind);
  return _streams[kind];
}

// ─── ローテーション ────────────────────────────────────────────────────────────
// 書き込みのたびに毎回statSyncするのは無駄が多いため、一定回数ごとに間引いて
// チェックする（既にストリームが開いていて明らかに上限未満のケースが大半のため）。
let _rotateCheckCounter = 0;

function _maybeRotate(kind) {
  _rotateCheckCounter++;
  // ストリーム未初期化(=起動直後)は必ずチェックする。それ以外は20回に1回。
  if (_streams[kind] && _rotateCheckCounter % 20 !== 0) return;

  let size;
  try { size = fs.statSync(PATHS[kind]).size; } catch { return; }
  if (size < MAX_SIZE_BYTES[kind]) return;

  try {
    if (_streams[kind]) { _streams[kind].end(); _streams[kind] = null; }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const ext   = path.extname(PATHS[kind]);
    const base  = PATHS[kind].slice(0, -ext.length);
    const rotated = `${base}.${stamp}${ext}`;
    fs.renameSync(PATHS[kind], rotated);
    _pruneRotated(kind);
  } catch (e) {
    // renameが失敗する状況（ファイルロック等）では最終手段としてtruncateする
    try { fs.truncateSync(PATHS[kind], 0); } catch {}
    console.error('[logger] rotate error', kind, e.message);
  }
}

function _pruneRotated(kind) {
  try {
    const dir  = path.dirname(PATHS[kind]);
    const ext  = path.extname(PATHS[kind]);
    const base = path.basename(PATHS[kind], ext);
    const prefix   = base + '.';
    const selfName = base + ext;
    const cutoff   = Date.now() - RETENTION_DAYS[kind] * 86_400_000;

    for (const f of fs.readdirSync(dir)) {
      if (f === selfName || !f.startsWith(prefix) || !f.endsWith(ext)) continue;
      const full = path.join(dir, f);
      try {
        if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
      } catch {}
    }
  } catch (e) {
    console.error('[logger] prune error', kind, e.message);
  }
}

function _writeToFile(kind, line) {
  _maybeRotate(kind);
  try { _getStream(kind)?.write(line); } catch {}
}

// ─── 構造化イベント (events.jsonl) ────────────────────────────────────────────

function _writeEvent(obj) {
  let line;
  try { line = JSON.stringify({ ts: new Date().toISOString(), ...obj }) + '\n'; }
  catch { return; }
  _writeToFile('events', line);
}

// ─── 同種WARN/ERRORの間引き ────────────────────────────────────────────────────
// 「同じ原因で大量作品に対して連発する警告」で本当に重要なログが埋もれるのを防ぐ。
// フィンガープリント（RJコード・数値等を正規化した文字列）ごとに直近ウィンドウ内の
// 発生回数を数え、閾値を超えた分は個別には書き込まず、ウィンドウ終了時に
// 「◯◯回発生」の集約1行にまとめる。
const DEDUPE_WINDOW_MS = 60_000;
const DEDUPE_THRESHOLD = 3;   // この件数までは通常どおり出力する
const _dedupeMap = new Map();

function _fingerprint(msg) {
  return msg
    .replace(/RJ\d{4,}/gi, 'RJ#')
    .replace(/[0-9a-f]{12,}/gi, '#')
    .replace(/\b\d+\b/g, '#')
    .slice(0, 160);
}

/** true を返した場合、このメッセージは個別出力せず集約対象としてカウントのみ行う */
function _registerForDedupe(level, msg) {
  if (level !== 'warn' && level !== 'error') return false;
  const key = level + ':' + _fingerprint(msg);
  let ent = _dedupeMap.get(key);
  if (!ent) {
    ent = { count: 0, level, sample: msg, first: Date.now() };
    _dedupeMap.set(key, ent);
  }
  ent.count++;
  return ent.count > DEDUPE_THRESHOLD;
}

function _flushDedupe() {
  if (_dedupeMap.size === 0) return;
  const now = Date.now();
  for (const ent of _dedupeMap.values()) {
    if (ent.count <= DEDUPE_THRESHOLD) continue;
    const extra = ent.count - DEDUPE_THRESHOLD;
    const ts    = new Date().toISOString();
    const sec   = Math.max(1, Math.round((now - ent.first) / 1000));
    const line  = `${ts} [${ent.level.toUpperCase().padEnd(5)}] (集約) 同種メッセージが直近${sec}秒で${ent.count}回発生（${extra}件を抑制）／ 例: ${ent.sample.slice(0, 200)}\n`;

    process.stderr.write(line);
    _writeToFile('main', line);
    _writeToFile('error', line);
    _recentErrors.push({ ts, level: ent.level, msg: `(集約 ×${ent.count}) ${ent.sample.slice(0, 250)}` });
    if (_recentErrors.length > MAX_ERRORS) _recentErrors.shift();
    _writeEvent({ level: ent.level, msg: ent.sample.slice(0, 2000), aggregated: true, count: ent.count, windowSec: sec });
  }
  _dedupeMap.clear();
}

const _dedupeTimer = setInterval(_flushDedupe, DEDUPE_WINDOW_MS);
if (typeof _dedupeTimer.unref === 'function') _dedupeTimer.unref();

/** アプリ終了時などに未フラッシュの集約サマリを取りこぼさないよう呼ぶ */
function flush() { _flushDedupe(); }

// ─── フォーマット ──────────────────────────────────────────────────────────────

/** ログ引数を1行のテキストに整形する（オブジェクトはJSON化）。
 *  apiServer.js の SSE 転送でも同じ整形を使い、[object Object] 表示を防ぐ。
 */
function formatArgs(args) {
  return args.map(a =>
    a instanceof Error    ? `${a.message}\n${a.stack ?? ''}` :
    typeof a === 'object' ? JSON.stringify(a) :
    String(a)
  ).join(' ');
}

function _log(level, ...args) {
  if ((LEVELS[level] ?? 0) < MIN_LEVEL) return;

  const msg = formatArgs(args);

  // 集約対象（同種メッセージの4件目以降）は個別には一切書き込まない。
  // ウィンドウ終了時に _flushDedupe() がまとめて1行出力する。
  if (_registerForDedupe(level, msg)) return;

  const ts   = new Date().toISOString();
  const line = `${ts} [${level.toUpperCase().padEnd(5)}] ${msg}\n`;

  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line);
  _writeToFile('main', line);

  if (level === 'warn' || level === 'error') {
    _writeToFile('error', line);
    _recentErrors.push({ ts, level, msg: msg.slice(0, 300) });
    if (_recentErrors.length > MAX_ERRORS) _recentErrors.shift();
  }

  _writeEvent({ level, msg: msg.slice(0, 2000) });
}

// ─── ジョブ単位のダイジェスト (digest.log) ─────────────────────────────────────
// 「いつ・何のジョブが・何件処理して・何が変わったか」を1行で追えるようにする。
// 呼び出し側(apiServer.js / scheduler.js)は discovered/processed/priceChanges/errors
// /duration 等、任意のフィールドを渡せる。値がオブジェクトの場合はJSON文字列化する。
function digest(job, summary = {}) {
  const ts = new Date().toISOString();
  const parts = Object.entries(summary)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}:${v != null && typeof v === 'object' ? JSON.stringify(v) : v}`)
    .join(' ');
  const line = `${ts} [${job}] ${parts}\n`;
  _writeToFile('digest', line);
  _writeEvent({ type: 'job_digest', job, ...summary });
}

module.exports = {
  debug: (...a) => _log('debug', ...a),
  info:  (...a) => _log('info',  ...a),
  warn:  (...a) => _log('warn',  ...a),
  error: (...a) => _log('error', ...a),
  digest,
  flush,
  getRecentErrors:  () => [..._recentErrors],
  getLogPath:       () => PATHS.main,
  getErrorLogPath:  () => PATHS.error,
  getDigestLogPath: () => PATHS.digest,
  getEventsLogPath: () => PATHS.events,
  formatArgs,
};
