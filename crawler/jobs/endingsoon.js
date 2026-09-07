'use strict';

/**
 * crawler/jobs/endingsoon.js
 * 割引終了まで24時間以内(soon/1)の作品を優先度最優先で収集する。
 */
module.exports = async function runEndingSoonJob(ctx) {
  const { sseSend, progress, log, discovery } = ctx;

  Object.assign(progress, { job: 'endingsoon', page: 0, found: 0, site: null, startedAt: Math.floor(Date.now() / 1000), done: false });

  const result = await discovery.runEndingSoonScan({
    onProgress: ({ site, page, found, total }) => {
      Object.assign(progress, { site, page, found: total, totalPages: null });
      sseSend('progress', { site, page, found: total });
    },
  });

  const out = { ok: true, ...result, finishedAt: Date.now() };
  Object.assign(progress, { done: true });
  sseSend('log', `終了間近収集完了 — 新規:${result?.newCount ?? 0}件 優先度UP:${result?.boostedCount ?? 0}件`);
  log.info('[api] endingSoonScan done', result);

  return { result: out };
};
