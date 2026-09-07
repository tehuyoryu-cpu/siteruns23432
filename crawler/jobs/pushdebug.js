'use strict';

/**
 * crawler/jobs/pushdebug.js
 * 手動デバッグPushボタン: ジョブ完了を待たず、いま現在のログ/DB統計を
 * debugブランチへ即時pushする（不具合調査でAI/開発者が即座に参照したい時用）。
 */
module.exports = async function runPushdebugJob(ctx) {
  const { sseSend, progress, log } = ctx;

  Object.assign(progress, { job: 'pushdebug', page: 0, found: 0, site: null, startedAt: Math.floor(Date.now() / 1000), done: false });
  sseSend('log', 'デバッグ情報(ログ・DB統計)をGitHub debugブランチへpush中...');
  const { pushDebugBundle } = require('../../scripts/pushDebugBundle');
  const pushResult = await pushDebugBundle({ job: 'manual' });

  let result;
  if (pushResult?.ok) {
    result = { ok: true, ...pushResult, finishedAt: Date.now() };
    sseSend('change', `デバッグ情報push完了 — ${pushResult.files}ファイル`);
    log.info('[api] pushdebug done', pushResult);
  } else {
    result = { ok: false, skipped: !!pushResult?.skipped, error: pushResult?.reason ?? pushResult?.error ?? '不明なエラー', finishedAt: Date.now() };
    sseSend('warn', `デバッグ情報pushスキップ/失敗 — ${pushResult?.reason ?? pushResult?.error ?? '不明なエラー'}`);
    log.warn('[api] pushdebug skipped/failed', pushResult);
  }
  Object.assign(progress, { done: true });

  return { result };
};
