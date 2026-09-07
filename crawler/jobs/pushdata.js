'use strict';

/**
 * crawler/jobs/pushdata.js
 * 手動pushボタン: 日次04:30スケジューラー(runExportShards → push-data-shards.main())
 * と全く同じパイプラインをオンデマンドで実行する。
 */
module.exports = async function runPushdataJob(ctx) {
  const { sseSend, progress, log, runExportShards } = ctx;

  Object.assign(progress, { job: 'pushdata', page: 0, found: 0, site: null, startedAt: Math.floor(Date.now() / 1000), done: false });

  sseSend('log', '配信データを生成中...');
  const exportResult = await runExportShards();
  sseSend('log',
    `エクスポート完了 — ${exportResult?.works ?? 0}作品 / shard:${exportResult?.dataShardFiles ?? 0}件 / index:${exportResult?.idxShardFiles ?? 0}件`);
  Object.assign(progress, { found: exportResult?.works ?? 0 });

  sseSend('log', 'GitHub dataブランチへpush中...');
  // バグ修正(起動不能の真因): モジュール読み込み時に即requireすると、
  // electron-builderのfilesリストにscripts/**が含まれていなかった場合に
  // アプリ全体が起動できなくなる(build-202〜205)。呼び出し時に遅延requireし、
  // 万一ファイルが無くてもこのジョブだけがエラーになるようにする。
  const { main: pushDataShards } = require('../../scripts/push-data-shards');
  const pushResult = await pushDataShards({
    onProgress: ({ done, total }) => {
      Object.assign(progress, { page: done, totalPages: total });
      sseSend('progress', { page: done, total, phase: 'push' });
    },
  });

  let result;
  if (pushResult?.ok && pushResult?.skipped && pushResult?.reason === 'no-changes') {
    // 効率化(差分push): 前回pushから内容が一切変わっていない場合、
    // push-data-shards.js はコミット自体を作らずに正常終了する。
    // ok:true だが commit は存在しないため、他の成功時と分岐して案内する。
    result = { ok: true, ...pushResult, exportResult, finishedAt: Date.now() };
    sseSend('log', `GitHub push完了 — 変更なし(前回pushと同一のため${pushResult.files}ファイル中0件のみ確認)`);
    log.info('[api] pushdata done (no changes)', { exportResult, pushResult });
  } else if (pushResult?.ok) {
    result = { ok: true, ...pushResult, exportResult, finishedAt: Date.now() };
    const changedInfo = pushResult.changed != null ? ` (うち変更:${pushResult.changed}件)` : '';
    sseSend('change', `GitHub push完了 — ${pushResult.files}ファイル${changedInfo} / commit:${(pushResult.commit ?? '').slice(0, 7)}`);
    log.info('[api] pushdata done', { exportResult, pushResult });
  } else {
    // トークン未設定・出力なし等の意図的なスキップは「失敗」ではないが、
    // 手動ボタンから押した以上はユーザーに理由が見えないと意味がないため
    // 明示的に warn として可視化する（従来のスケジューラー任せの
    // log.info()化バグの再発防止）。
    result = { ok: false, skipped: !!pushResult?.skipped, error: pushResult?.message ?? 'push失敗', exportResult, finishedAt: Date.now() };
    sseSend('warn', `GitHub pushスキップ/失敗 — ${pushResult?.message ?? '不明なエラー'}`);
    log.warn('[api] pushdata skipped/failed', pushResult);
  }
  Object.assign(progress, { done: true });

  return { result };
};
