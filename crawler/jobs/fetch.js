'use strict';

/**
 * crawler/jobs/fetch.js
 * 価格更新（未取得・期限切れ作品のdue分をまとめて処理）。
 */
module.exports = async function runFetchJob(ctx) {
  const { sseSend, progress, detailFetcher, notifyPriceChange } = ctx;

  const startedAt = Math.floor(Date.now() / 1000);
  Object.assign(progress, { job: 'fetch', page: 0, found: 0, total: 0, site: null, startedAt, done: false });

  const r = await detailFetcher.runDetailFetch(300, {
    jobName: 'fetch',
    onProgress: ({ processed, priceChanges, total }) => {
      Object.assign(progress, { found: processed, total });
      sseSend('progress', { processed, priceChanges, total });
      if (priceChanges > 0) sseSend('change', `価格変動: ${priceChanges}件`);
    },
  });

  // バグ修正: 停止ボタンによる中断か、単なる正常完了かを digest.log から
  // 判別できるようにする。
  const stopped = !!global._crawlerAbort?.detail;
  const result = { ok: true, ...r, stopped, finishedAt: Date.now() };
  sseSend(r?.priceChanges > 0 ? 'change' : 'log',
    (stopped ? '価格更新を停止しました — ' : '価格更新完了 — ') + `処理:${r?.processed ?? 0}件 変動:${r?.priceChanges ?? 0}件`);
  if (r?.priceChanges > 0) notifyPriceChange(r.priceChanges);

  return { result };
};
