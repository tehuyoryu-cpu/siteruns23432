'use strict';

/**
 * crawler/jobs/compListing.js
 * 総集編マーク Phase A: ジャンル515一覧を巡回し、総集編“作品”RJを収集する。
 */
module.exports = async function runCompListingJob(ctx) {
  const { sseSend, progress, log, compScan, resetAbortFlag } = ctx;

  if (!global._crawlerAbort) global._crawlerAbort = {};
  global._crawlerAbort.comp = false;   // 停止ボタンからの中断要求フラグをリセット
  resetAbortFlag('comp');
  Object.assign(progress, { job: 'comp_listing', page: 0, found: 0, site: null, startedAt: Math.floor(Date.now() / 1000), done: false });

  const result = await compScan.runListingScan({
    shouldContinue: () => !global._crawlerAbort?.comp,
    onProgress: ({ page, found, added, totalAdded }) => {
      Object.assign(progress, { page, found: totalAdded });
      sseSend('progress', { page, found: totalAdded });
    },
  });

  const stopped = !!global._crawlerAbort?.comp;
  const out = { ok: true, ...result, stopped, finishedAt: Date.now() };
  Object.assign(progress, { done: true });
  sseSend('log', stopped
    ? `総集編一覧走査を停止しました — 新規候補:${result.added ?? 0}件（続きから再開可能）`
    : result.alreadyDone
      ? '総集編一覧走査は完了済みです（再走査するには要リセット）'
      : `総集編一覧走査完了 — 新規候補:${result.added ?? 0}件`);
  log.info('[api] compListingScan done', { ...result, stopped });

  return { result: out };
};
