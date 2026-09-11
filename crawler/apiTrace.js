'use strict';

/**
 * crawler/apiTrace.js
 *
 * product/info/ajax の「異常な」レスポンス（空応答・severely-partial・CDN汚染・
 * 非200）を直近MAX_ENTRIES件だけ保持する。
 *
 * 背景: これまで空応答/汚染の検知はログメッセージ（件数・比率等の要約情報）
 * しか残さず、実際にDLsiteから返ってきたヘッダー(Content-Type等)や本文の
 * サンプルは破棄されていた。そのため「セッション切れなのかCDN汚染なのか」の
 * 切り分けが、過去の類似ログからの推測に頼るしかなかった。
 * ここに生サンプルを溜めておき、/api/debug/api-trace とdebugブランチ
 * (pushDebugBundle.js経由)の両方から参照できるようにする。
 *
 * データ保全対策⑤: 以前はプロセスメモリのみで、アプリ再起動(cronの
 * セッション再確立トラブル調査中に限ってアプリを再起動したくなることが
 * 多い)のたびに直近サンプルが消えてしまい、「再起動する前に見ておけば
 * よかった」という取りこぼしが度々起きていた。DBスキーマを汚さないという
 * 元の設計判断は維持しつつ、DLSITE_DATA_DIR配下の軽量JSONファイルへ
 * 非同期debounce書き込みし、起動時に読み戻すことで再起動をまたいで
 * 直近MAX_ENTRIES件を保持できるようにする（最大50件・1件あたり数百バイト
 * 程度のため、書き込みコストは無視できる規模）。
 */

const fs   = require('fs');
const path = require('path');

const MAX_ENTRIES = 50;

const _dataDir = process.env.DLSITE_DATA_DIR
  || process.env.PORTABLE_EXECUTABLE_DIR
  || process.cwd();
const _persistPath = path.join(_dataDir, 'api-trace-state.json');

function _loadFromDisk() {
  try {
    const raw = fs.readFileSync(_persistPath, 'utf8');
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) return arr.slice(-MAX_ENTRIES);
  } catch { /* ファイル無し/壊れている場合は空から始める(致命的ではない) */ }
  return [];
}

const _trace = _loadFromDisk();

// 短時間に連続でrecord()が呼ばれること(汚染検知ループ等)があるため、
// 呼び出しのたびに同期書き込みするのではなくdebounceして1回にまとめる
// (content.js の scheduleSaveLS と同じパターン)。
let _saveTimer = null;
function _scheduleSave() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    try { fs.writeFileSync(_persistPath, JSON.stringify(_trace)); } catch { /* 保存失敗はトレース機能自体を壊さない */ }
  }, 500);
}

/**
 * @param {object} entry
 *   kind: 'http-error' | 'empty' | 'severe-partial' | 'contamination' | 'price-issue' | 'json-parse-error'
 *   その他 site/url/status/contentType/requested/bodySample 等、呼び出し元が
 *   持っている情報を自由に詰めてよい。
 */
function record(entry) {
  try {
    _trace.push({ ts: new Date().toISOString(), ...entry });
    if (_trace.length > MAX_ENTRIES) _trace.shift();
    _scheduleSave();
  } catch { /* トレース記録自体の失敗で本処理を止めない */ }
}

function getAll() { return [..._trace]; }
function clear() {
  _trace.length = 0;
  clearTimeout(_saveTimer);
  try { fs.unlinkSync(_persistPath); } catch { /* ファイル無しは正常 */ }
}

module.exports = { record, getAll, clear };
