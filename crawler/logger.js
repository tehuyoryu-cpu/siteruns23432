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

// 直近エラーをUI用に保持
const _recentErrors = [];
const MAX_ERRORS = 100;

// ストリーム遅延初期化
let _stream = null, _errStream = null;

function _getStream() {
  if (_stream) return _stream;
  try {
    _stream = fs.createWriteStream(LOG_PATH, { flags: 'a' });
    _stream.on('error', () => { _stream = null; });
  } catch {}
  return _stream;
}

function _getErrStream() {
  if (_errStream) return _errStream;
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
  try { _getStream()?.write(line); } catch {}

  // エラー専用ファイル（WARN以上のみ）
  if (level === 'warn' || level === 'error') {
    try { _getErrStream()?.write(line); } catch {}
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
