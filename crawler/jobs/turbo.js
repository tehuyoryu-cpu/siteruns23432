'use strict';

/**
 * crawler/jobs/turbo.js
 * ぶっ飛ばしモード: 価格更新(detail)・新作収集(newrelease)・
 * 終了間近収集(endingsoon)を同時並行で実行する。
 *
 * detail は 'detail' ロック、newrelease/endingsoon は 'discovery' ロックを使う
 * （discover/fullscan等と同じ系統）。開始時にどちらかが既に実行中なら、
 * detailと同じ中断→引き継ぎパターンで乗っ取る。
 *
 * 重要: このジョブは detail/discovery の両方を自前で確保するため、
 * apiServer.js側の共通preamble(sharedKeys)には登録しない。
 * かつて 'turbo' が sharedKeys にも登録されており、preambleが先に
 * detailロックを取得 → このジョブ内のabortAndTakeover('detail')が
 * 「自分自身」を相手に中断待ちしてtimeoutMs(15秒)を毎回無駄にする
 * バグがあった(#1ジョブ分割時に発見・修正)。
 */
module.exports = async function runTurboJob(ctx) {
  const {
    sseSend, progress, log, config, lockManager,
    discovery, detailFetcher, checkHighErrorRate, notifyPriceChange,
  } = ctx;

  const myDetailToken = await lockManager.abortAndTakeover('detail', {
    label: '価格更新', sseSend, timeoutMs: 15_000,
  });
  const myDiscoveryToken = await lockManager.abortAndTakeover('discovery', {
    label: '収集系ジョブ', sseSend, timeoutMs: 15_000,
  });

  sseSend('log', '🚀 ぶっ飛ばしモード開始 — 価格更新・新作収集・終了間近収集を並列実行します');
  // subJobs: newrelease/endingsoon の進捗はダッシュボードのメイン進捗バー
  // (found/total)には反映しない（価格更新の件数と混ざって意味不明になるため）。
  // ログパネルへは既存の [discovery] ログ転送(SSE 'log')でそのまま流れる。
  Object.assign(progress, {
    job: 'turbo', found: 0, total: 0,
    startedAt: Math.floor(Date.now() / 1000), done: false,
    subJobs: { newrelease: {}, endingsoon: {} },
  });

  // バグ修正: 99999 は「実質無制限」のつもりの値だったが、実装上は
  // ハードキャップとして扱われるため、due作品数がこれを超えると
  // 残りが未処理のまま打ち切られていた（カタログ増加で顕在化）。
  // Infinity にすることで、真に due が枯渇するまで処理を続ける。
  //
  // 3つとも Promise.all で並列起動する。newrelease/endingsoon側で例外が
  // 起きても .catch() で握りつぶし、価格更新(detail)の結果は必ず持ち帰る
  // （収集系がエラーで落ちただけで「ぶっ飛ばし全体が失敗」にはしたくない）。
  const [detailR, newReleaseR, endingSoonR] = await Promise.all([
    detailFetcher.runDetailFetch(Infinity, {
      jobName:     'turbo',
      rateLimit:   config.fetch.turboRateLimit,
      concurrency: Math.max(config.fetch.concurrency ?? 1, config.fetch.turboConcurrency),
      onProgress: ({ processed, priceChanges, total }) => {
        Object.assign(progress, { found: processed, total });
        sseSend('progress', { processed, priceChanges, total });
        if (priceChanges > 0) sseSend('change', `価格変動: ${priceChanges}件`);
      },
    }),
    discovery.runNewReleaseScan({
      onProgress: ({ site, page, found, total }) => {
        progress.subJobs.newrelease = { site, page, found: total };
        sseSend('progress', { job: 'newrelease', site, page, found: total });
      },
    }).catch(e => {
      log.error('[api] turbo: newReleaseScan error (continuing)', e.message);
      sseSend('warn', `新作収集エラー: ${e.message} — 価格更新・終了間近収集は続行します`);
      return { grandTotal: 0, error: e.message };
    }),
    discovery.runEndingSoonScan({
      onProgress: ({ site, page, found, total }) => {
        progress.subJobs.endingsoon = { site, page, found: total };
        sseSend('progress', { job: 'endingsoon', site, page, found: total });
      },
    }).catch(e => {
      log.error('[api] turbo: endingSoonScan error (continuing)', e.message);
      sseSend('warn', `終了間近収集エラー: ${e.message} — 価格更新・新作収集は続行します`);
      return { grandTotal: 0, newCount: 0, boostedCount: 0, error: e.message };
    }),
  ]);

  // バグ修正: 停止ボタンによる中断か正常完了かを digest.log から判別できるようにする。
  const stopped = !!global._crawlerAbort?.detail || !!global._crawlerAbort?.discovery;
  const errRate = checkHighErrorRate('turbo', detailR);
  const result = {
    ok: true, ...detailR,
    newRelease: newReleaseR, endingSoon: endingSoonR,
    stopped, ...errRate, finishedAt: Date.now(),
  };
  const msg =
    (stopped ? '🚀 ぶっ飛ばしを停止しました — ' : 'ぶっ飛ばし完了 — ') +
    `価格更新:${detailR?.processed ?? 0}件 変動:${detailR?.priceChanges ?? 0}件` +
    ` / 新作収集:新規${newReleaseR?.grandTotal ?? 0}件` +
    ` / 終了間近:新規${endingSoonR?.newCount ?? 0}件・優先度UP${endingSoonR?.boostedCount ?? 0}件`;
  sseSend(detailR?.priceChanges > 0 ? 'change' : 'log', msg);
  if (detailR?.priceChanges > 0) notifyPriceChange(detailR.priceChanges);

  return { result, tokens: { detail: myDetailToken, discovery: myDiscoveryToken } };
};
