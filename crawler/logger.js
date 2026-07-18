'use strict';

/**
 * crawler/logger.js
 * ログを stdout/stderr + 2ファイルに出力:
 *   dlsite-tracker.log  – 全ログ（info以上）
 *   dlsite-error.log    – WARN/ERROR のみ
 */

const fs   = require('fs');
const path = require('path');

const LEVELS    = { debug: 0, info: 1, warn: 2, error: 3 };
const MIN_LEVEL = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? 1;

const LOG_DIR    = process.env.DLSITE_DATA_DIR
  || process.env.PORTABLE_EXECUTABLE_DIR
  || process.cwd();
const LOG_PATH   = path.join(LOG_DIR, 'dlsite-tracker.log');
const ERROR_PATH = path.join(LOG_DIR, 'dlsite-error.log');

// バグ修正: ログファイルにサイズ上限が無く、長時間稼働で肥大化し続けた結果
// V8の文字列長上限(0x1fffffe8 ≈ 512MB)を超え、fs.readFileSync(path,'utf8')が
// RangeError("Cannot create a string longer than...")を投げてダッシュボードの
// 「ログ確認」自体が使えなくなる障害が発生した。
// 書き込み側にサイズ上限つきローテーションを追加する。ファイルが上限を超えたら
// 現行ファイルを *.old にリネームして新規ファイルから書き始める（*.old は
// 1世代のみ保持、次回ローテーション時に上書き）。
// 既に肥大化した既存ファイルも、次回起動時の最初の書き込みで自動的に
// ローテーションされ自己修復する（_getStream/_getErrStream が初回にサイズを
// チェックするため、手動でのファイル削除は不要）。
const MAX_LOG_BYTES   = 20 * 1024 * 1024;  // 20MB
const MAX_ERROR_BYTES = 10 * 1024 * 1024;  // 10MB

// 直近エラーをUI用に保持
const _recentErrors = [];
const MAX_ERRORS = 100;

// ストリーム遅延初期化 + 書き込みバイト数追跡（ローテーション判定用）
let _stream = null, _errStream = null;
let _streamBytes = 0, _errStreamBytes = 0;

function _sizeOf(p) {
  try { return fs.statSync(p).size; } catch { return 0; }
}

function _rotate(p) {
  try {
    const oldPath = p + '.old';
    try { fs.unlinkSync(oldPath); } catch {}
    fs.renameSync(p, oldPath);
  } catch (e) {
    // rename失敗時（ファイルロック中等）は最終手段としてtruncateする
    try { fs.truncateSync(p, 0); } catch {}
  }
}

function _getStream() {
  if (_stream) return _stream;
  _streamBytes = _sizeOf(LOG_PATH);
  if (_streamBytes >= MAX_LOG_BYTES) { _rotate(LOG_PATH); _streamBytes = 0; }
  try {
    _stream = fs.createWriteStream(LOG_PATH, { flags: 'a' });
    _stream.on('error', () => { _stream = null; });
  } catch {}
  return _stream;
}

function _getErrStream() {
  if (_errStream) return _errStream;
  _errStreamBytes = _sizeOf(ERROR_PATH);
  if (_errStreamBytes >= MAX_ERROR_BYTES) { _rotate(ERROR_PATH); _errStreamBytes = 0; }
  try {
    _errStream = fs.createWriteStream(ERROR_PATH, { flags: 'a' });
    _errStream.on('error', () => { _errStream = null; });
  } catch {}
  return _errStream;
}

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

  const ts  = new Date().toISOString();
  const msg = formatArgs(args);

  const line = `${ts} [${level.toUpperCase().padEnd(5)}] ${msg}\n`;

  // stdout / stderr
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line);

  // 全ログファイル
  try {
    const s = _getStream();
    s?.write(line);
    _streamBytes += Buffer.byteLength(line);
    if (_streamBytes >= MAX_LOG_BYTES) {
      s?.end();
      _stream = null;   // 次回書き込み時に _getStream() がローテーションして再作成する
    }
  } catch {}

  // エラー専用ファイル（WARN以上のみ）
  if (level === 'warn' || level === 'error') {
    try {
      const es = _getErrStream();
      es?.write(line);
      _errStreamBytes += Buffer.byteLength(line);
      if (_errStreamBytes >= MAX_ERROR_BYTES) {
        es?.end();
        _errStream = null;
      }
    } catch {}
    _recentErrors.push({ ts, level, msg: msg.slice(0, 300) });
    if (_recentErrors.length > MAX_ERRORS) _recentErrors.shift();
  }
}

module.exports = {
  debug: (...a) => _log('debug', ...a),
  info:  (...a) => _log('info',  ...a),
  warn:  (...a) => _log('warn',  ...a),
  error: (...a) => _log('error', ...a),
  getRecentErrors: () => [..._recentErrors],
  getLogPath:      () => LOG_PATH,
  getErrorLogPath: () => ERROR_PATH,
  formatArgs,
};
