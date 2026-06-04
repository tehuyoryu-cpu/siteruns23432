'use strict';

/**
 * crawler/logger.js
 * ログをstdout/stderr + ファイル（dlsite-tracker.log）に同時出力。
 * exeでもログが確認できる。
 */

const fs   = require('fs');
const path = require('path');

const LEVELS   = { debug: 0, info: 1, warn: 2, error: 3 };
const MIN_LEVEL = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? 1;

// ログファイルパス: electron-main が DLSITE_DATA_DIR を設定済み
const LOG_DIR  = process.env.DLSITE_DATA_DIR
  || process.env.PORTABLE_EXECUTABLE_DIR
  || process.cwd();
const LOG_PATH = path.join(LOG_DIR, 'dlsite-tracker.log');

// 直近の warn/error を最大50件保持（UIに表示するため）
const _recentErrors = [];
const MAX_ERRORS = 50;

// ファイルストリーム（遅延初期化）
let _stream = null;
function _getStream() {
  if (_stream) return _stream;
  try {
    _stream = fs.createWriteStream(LOG_PATH, { flags: 'a' });
    _stream.on('error', () => { _stream = null; });
  } catch {}
  return _stream;
}

function _log(level, ...args) {
  if ((LEVELS[level] ?? 0) < MIN_LEVEL) return;

  const ts  = new Date().toISOString();
  const msg = args.map(a =>
    a instanceof Error    ? a.message :
    typeof a === 'object' ? JSON.stringify(a) :
    String(a)
  ).join(' ');

  const line = `${ts} [${level.toUpperCase().padEnd(5)}] ${msg}\n`;

  // stdout/stderr
  if (level === 'error' || level === 'warn') {
    process.stderr.write(line);
  } else {
    process.stdout.write(line);
  }

  // ファイル
  try { _getStream()?.write(line); } catch {}

  // 直近エラー記録
  if (level === 'warn' || level === 'error') {
    _recentErrors.push({ ts, level, msg });
    if (_recentErrors.length > MAX_ERRORS) _recentErrors.shift();
  }
}

module.exports = {
  debug: (...a) => _log('debug', ...a),
  info:  (...a) => _log('info',  ...a),
  warn:  (...a) => _log('warn',  ...a),
  error: (...a) => _log('error', ...a),
  getRecentErrors: () => [..._recentErrors],
  getLogPath: () => LOG_PATH,
};
