'use strict';

/**
 * crawler/jobs/compDetail.js
 * 総集編マーク Phase B: 候補の詳細解析（直接抽出→サークル推定）。
 */
module.exports = async function runCompDetailJob(ctx) {
  const { sseSend, progress, log, compScan, resetAbortFlag } = ctx;

  if (!global._crawlerAbort) global._crawlerAbort = {};
  global._crawlerAbort.comp = false;   // 停止ボタンからの中断要求フラグをリセット
  resetAbortFlag('comp');
  Object.assign(progress, { job: 'comp_detail', page: 0, found: 0, total: 0, site: null, startedAt: Math.floor(Date.now() / 1000), done: false });

  const result = await compScan.runDetailScan({
    limit: 200,
    shouldContinue: () => !global._crawlerAbort?.comp,
    onProgress: ({ processed, total, direct, confirmed, pending }) => {
      Object.assign(progress, { found: processed, total });
      sseSend('progress', { processed, total });
    },
  });

  const stopped = !!global._crawlerAbort?.comp;
  const out = { ok: true, ...result, stopped, finishedAt: Date.now() };
  Object.assign(progress, { done: true });
  sseSend(result.confirmed > 0 || result.direct > 0 ? 'change' : 'log',
    (stopped ? '総集編詳細解析を停止しました — ' : '総集編詳細解析完了 — ') +
    `処理:${result.processed}件 / 直接抽出:${result.direct}件 / 推定確定:${result.confirmed}件 / 要確認:${result.pending}件 / エラー:${result.errors}件`);
  log.info('[api] compDetailScan done', { ...result, stopped });

  return { result: out };
};
