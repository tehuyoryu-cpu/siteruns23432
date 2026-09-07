'use strict';

/**
 * crawler/jobs/discover.js
 * RJ収集（新着/ランキング/セール等）。
 *
 * #1 apiServer分割 ステップ2: apiServer.js の handleRun() 内にあった
 * ジョブ本体をファイル単位に抽出したもの。ロック取得/解放・進捗初期化の
 * 共通処理は apiServer.js 側(ctx経由)に残し、ここには業務ロジックのみを置く。
 * 挙動は元のインラインコードと1:1で同じになるよう機械的に移植している。
 */
module.exports = async function runDiscoverJob(ctx) {
  const { sseSend, progress, discovery } = ctx;

  Object.assign(progress, {
    job: 'discover', page: 0, found: 0, site: 'maniax',
    startedAt: Math.floor(Date.now() / 1000), done: false,
  });

  const r = await discovery.runDiscovery();

  // バグ修正: 停止ボタンで中断された実行も ok:true のまま digest.log に
  // 記録されており、あとからログを見ても「意図的に停止したのか、
  // 単に完了したのか」が区別できなかった。完了時点の中止フラグを見て
  // stopped を明示する（他のジョブと同じパターン）。
  const stopped = !!global._crawlerAbort?.discovery;
  const result = { ok: true, discovered: r?.discovered ?? 0, stopped, finishedAt: Date.now() };
  sseSend('log', (stopped ? 'RJ収集を停止しました — ' : 'discovery完了 — ') + `新規: ${r?.discovered ?? 0}件`);

  return { result };
};
