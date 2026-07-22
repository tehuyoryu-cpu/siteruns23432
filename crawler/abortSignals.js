'use strict';

/**
 * crawler/abortSignals.js
 *
 * バグ修正: 中止ボタン（/api/stop/:job）は従来 global._crawlerAbort[flag] という
 * 真偽値フラグをセットするだけだった。discovery.js/detailFetcher.js/compScan.js の
 * ループはこのフラグをイテレーションの合間にしかチェックしないため、
 *   - 実行中の fetch 自体（最大 config.fetch.timeout=20秒）
 *   - リトライの指数バックオフ待機（最大 _MAX_BACKOFF_MS=60秒）
 *   - 429/503 の Retry-After 待機（サーバー指定、数十秒〜数分になりうる）
 *   - ネットワーク断時の全ワーカー同期ポーズ（30秒）
 * のいずれかの最中に停止ボタンを押すと、それらが終わるまで反応が無く
 * 「中止ボタンが効かない」ように見えるバグがあった。
 *
 * ジョブ系統（detail/discovery/comp）ごとに AbortController を持たせ、
 * 停止時に signal.abort() を発火することで、fetch とバックオフ待機の
 * どちらも即座に中断できるようにする。
 */

const _controllers = new Map();

function _get(name) {
  if (!_controllers.has(name)) _controllers.set(name, new AbortController());
  return _controllers.get(name);
}

/** 指定ジョブ系統の現在の AbortSignal を返す（未作成なら生成）。 */
function getAbortSignal(name) {
  return _get(name).signal;
}

/** 中止を要求する。対応する signal が abort イベントを発火する。 */
function abortNow(name) {
  const ctrl = _get(name);
  if (!ctrl.signal.aborted) ctrl.abort();
}

/**
 * 新しい実行を開始する前に呼ぶ。前回の中止で abort 済みの signal を
 * 使い回すと新規実行が即座に中断扱いになってしまうため、新しい
 * AbortController に差し替える。
 */
function resetAbortFlag(name) {
  _controllers.set(name, new AbortController());
}

module.exports = { getAbortSignal, abortNow, resetAbortFlag };
