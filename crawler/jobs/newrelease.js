'use strict';

/**
 * crawler/jobs/newrelease.js
 * 過去1年以内に発売された全作品を、割引の有無を問わずFSR全ページ走査で収集する
 * (終了間近収集から割引条件と24時間以内終了条件を外したもの)。
 */
module.exports = async function runNewReleaseJob(ctx) {
  const { sseSend, progress, log, discovery } = ctx;

  Object.assign(progress, { job: 'newrelease', page: 0, found: 0, site: null, startedAt: Math.floor(Date.now() / 1000), done: false });

  const result = await discovery.runNewReleaseScan({
    onProgress: ({ site, page, found, total }) => {
      Object.assign(progress, { site, page, found: total, totalPages: null });
      sseSend('progress', { site, page, found: total });
    },
  });

  const out = { ok: true, ...result, finishedAt: Date.now() };
  Object.assign(progress, { done: true });
  sseSend('log', `新作収集完了 — 新規:${result?.grandTotal ?? 0}件`);
  log.info('[api] newReleaseScan done', result);

  return { result: out };
};
