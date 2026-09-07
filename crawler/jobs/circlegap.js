'use strict';

/**
 * crawler/jobs/circlegap.js
 * サークル単位の欠落診断: 既知の全サークルについてDLsite上の全作品ページを
 * 走査し、DBに存在しないRJコードを検出・登録する。
 * 未チェック/最も古くチェックされたサークルから優先するため、中止しても
 * 次回実行時は続きから再開される（同じサークルを何度もなぞらない）。
 */
module.exports = async function runCircleGapJob(ctx) {
  const { sseSend, progress, log, discovery } = ctx;

  Object.assign(progress, { job: 'circlegap', page: 0, found: 0, totalPages: 0, site: null, startedAt: Math.floor(Date.now() / 1000), done: false });

  const result = await discovery.runCircleGapScan({
    onProgress: ({ checked, total, totalMissing, makerId, page }) => {
      Object.assign(progress, { found: checked, totalPages: total, site: makerId, page: page ?? 0 });
      sseSend('progress', { checked, total, totalMissing, makerId, page });
    },
  });

  const stopped = !!global._crawlerAbort?.discovery;
  const out = { ok: true, ...result, stopped, finishedAt: Date.now() };
  Object.assign(progress, { done: true });
  const gapSummary = `チェック:${result.checked}/${result.totalCircles}サークル` +
    (result.resumedFromPrevious ? '（前回の続きから再開）' : '') +
    ` / 発見した欠落:${result.totalMissing}件` +
    (result.totalMissing > 0 ? ` (${Object.keys(result.missingByCircle).length}サークルで検出)` : '') +
    (result.skippedInvalidSite > 0 ? ` / site_id不明で除外:${result.skippedInvalidSite}サークル` : '');
  const suffix = stopped ? '（続きは次回実行時に再開されます）'
    : result.timedOut ? '（1回の実行あたりの時間上限に到達 — 続きは次回実行時に再開されます）'
    : '';
  sseSend(result.totalMissing > 0 ? 'change' : 'log',
    (stopped ? 'サークル欠落診断を停止しました — ' : 'サークル欠落診断完了 — ') + gapSummary + suffix);
  log.info('[api] circleGapScan done', { ...result, stopped });

  return { result: out };
};
