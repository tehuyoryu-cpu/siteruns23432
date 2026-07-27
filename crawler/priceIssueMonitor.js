'use strict';

/**
 * crawler/priceIssueMonitor.js
 *
 * 価格取得エラー(price_issues)の急増検知。
 * recordPriceIssue()は作品1件ごとに静かに記録されるだけで、DLsite側のAPI
 * 仕様変更や大規模なCDN/プロキシ汚染が起きても、ダッシュボードの「定価エラー」
 * モーダルを開かない限り誰も気づけない。巡回ジョブ完了ごとに前回計測値との
 * 差分を比較し、急増していればSSEで即座に警告する。
 *
 * プロセス起動をまたいだ状態は持たない(_lastCountはメモリのみ)。
 * 再起動直後の1回目のチェックはベースライン記録のみで警告は出さない
 * (直前値が無いため、それ自体を「急増」とは判定できない)。
 */

const db  = require('./db');
const log = require('./logger');

const SPIKE_ABS_THRESHOLD = 50;   // これ未満の絶対増加は通常の揺らぎとして無視
const SPIKE_REL_THRESHOLD = 0.2;  // 直前値に対して20%以上の増加も同時に要求（絶対数条件との誤検知防止のAND条件）

let _lastCount = null;

/**
 * @param {string} job 呼び出し元ジョブ名（ログ用途のみ）
 */
function checkSpike(job) {
  try {
    const current = db.getPriceIssuesCount();
    if (_lastCount != null) {
      const delta = current - _lastCount;
      if (delta >= SPIKE_ABS_THRESHOLD) {
        const rel = _lastCount > 0 ? delta / _lastCount : Infinity;
        if (rel >= SPIKE_REL_THRESHOLD) {
          const relStr = Number.isFinite(rel) ? `, +${Math.round(rel * 100)}%` : '';
          const msg = `⚠ 定価取得エラーが急増しています — ${_lastCount}件 → ${current}件 (+${delta}件${relStr})。` +
            `DLsite側のAPI仕様変更や大規模なCDN/プロキシ汚染の可能性があります。「定価エラー」パネルで内容を確認してください。`;
          log.warn('[priceIssueMonitor] spike detected', { job, before: _lastCount, after: current, delta });
          global._sseSend?.('warn', msg);
        }
      }
    }
    _lastCount = current;
  } catch (e) {
    log.warn('[priceIssueMonitor] check failed', e.message);
  }
}

module.exports = { checkSpike };
