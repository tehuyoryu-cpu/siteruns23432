'use strict';

/**
 * crawler/apiTrace.js
 *
 * product/info/ajax の「異常な」レスポンス（空応答・severely-partial・CDN汚染・
 * 非200）を直近MAX_ENTRIES件だけメモリに保持する。
 *
 * 背景: これまで空応答/汚染の検知はログメッセージ（件数・比率等の要約情報）
 * しか残さず、実際にDLsiteから返ってきたヘッダー(Content-Type等)や本文の
 * サンプルは破棄されていた。そのため「セッション切れなのかCDN汚染なのか」の
 * 切り分けが、過去の類似ログからの推測に頼るしかなかった。
 * ここに生サンプルを溜めておき、/api/debug/api-trace とdebugブランチ
 * (pushDebugBundle.js経由)の両方から参照できるようにする。
 *
 * プロセスメモリのみで永続化はしない（DBスキーマを汚さないための意図的な
 * トレードオフ。過去の傾向はdigest.log/events.jsonl側で追う）。
 */

const MAX_ENTRIES = 50;
const _trace = [];

/**
 * @param {object} entry
 *   kind: 'http-error' | 'empty' | 'severe-partial' | 'contamination' | 'price-issue'
 *   その他 site/url/status/contentType/requested/bodySample 等、呼び出し元が
 *   持っている情報を自由に詰めてよい。
 */
function record(entry) {
  try {
    _trace.push({ ts: new Date().toISOString(), ...entry });
    if (_trace.length > MAX_ENTRIES) _trace.shift();
  } catch { /* トレース記録自体の失敗で本処理を止めない */ }
}

function getAll() { return [..._trace]; }
function clear() { _trace.length = 0; }

module.exports = { record, getAll, clear };
