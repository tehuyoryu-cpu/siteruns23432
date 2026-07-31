'use strict';

/**
 * crawler/warmUpHistory.js
 *
 * electron-main.js の warmUpSession() は毎回の実行結果を global._lastWarmUpDiag に
 * 上書き保存するだけで、直近1回分しか残らなかった。そのため「年齢確認セッションが
 * 周期的(数時間おき等)に切れているのか、それとも今回だけのたまたまの不調か」を
 * 判別する材料が無く、_startSessionRewarmJob（6時間おきの予防的再ウォームアップ）や
 * detailFetcher.js の空応答サーキットブレーカーから起動される再ウォームアップが
 * 実際にどのくらいの頻度で・どのサイトで発生しているのか時系列で追えなかった。
 *
 * ここに直近MAX_ENTRIES回分のサマリ(サイトごとのcookieObtained/clicked/reason +
 * トリガー種別)を残し、周期性・頻度の傾向を後から確認できるようにする。
 * フルの診断詳細(diag.bodyTextSample等)は容量を食うため、直近1回分は
 * 従来どおり global._lastWarmUpDiag に残し、履歴側はサマリのみ保持する。
 */

const MAX_ENTRIES = 30;
const _history = [];

/**
 * @param {object} entry
 *   trigger: 'startup' | 'periodic' | 'reactive'（起動時 / 6時間毎の予防的実行 / 空応答検知による再実行）
 *   results: { [site]: { cookieObtained, clicked, reason } }
 */
function record({ trigger, results }) {
  try {
    const summary = {};
    for (const [site, r] of Object.entries(results ?? {})) {
      summary[site] = {
        cookieObtained: r?.cookieObtained ?? null,
        clicked:        r?.clicked ?? null,
        reason:         r?.reason ?? null,
        regionBlocked:  r?.regionBlocked ?? false,
      };
    }
    const allOk = Object.values(summary).length > 0
      && Object.values(summary).every(s => s.cookieObtained === true);
    _history.push({ ts: new Date().toISOString(), trigger: trigger ?? 'unknown', allOk, results: summary });
    if (_history.length > MAX_ENTRIES) _history.shift();
  } catch { /* 履歴記録の失敗でwarmUp自体を止めない */ }
}

function getAll() { return [..._history]; }
function clear() { _history.length = 0; }

module.exports = { record, getAll, clear };
