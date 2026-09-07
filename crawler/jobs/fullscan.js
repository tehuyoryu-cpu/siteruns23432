'use strict';

/**
 * crawler/jobs/fullscan.js
 * FSR全ページ走査。'fullscan'(全収集)と'fullscan_sale'(全セール収集)の
 * 2ジョブ名で共有される(saleフラグのみが異なる)。
 */
module.exports = async function runFullscanJob(ctx, { job }) {
  const { sseSend, progress, log, discovery } = ctx;

  const sale = job === 'fullscan_sale';
  Object.assign(progress, { job, page: 0, found: 0, site: null, startedAt: Math.floor(Date.now() / 1000), done: false });

  const result = await discovery.runFullScan({
    sale,
    maxPages: 0,
    onProgress: ({ site, page, found: pageFound, total }) => {
      Object.assign(progress, { site, page, found: total, totalPages: null });
      sseSend('progress', { site, page, found: total });
    },
  });

  const out = { ok: true, ...result, finishedAt: Date.now() };
  Object.assign(progress, { done: true });
  log.info('[api] fullScan done', result);

  return { result: out };
};
