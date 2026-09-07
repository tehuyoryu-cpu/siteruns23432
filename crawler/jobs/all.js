'use strict';

/**
 * crawler/jobs/all.js
 * 全て巡回: RJ収集 → 価格更新 → セールブースト。
 *
 * detail/discovery ロックは apiServer.js 側の共通preambleでは確保せず、
 * このジョブが自前で abortAndTakeover()/acquire()/releaseOwned() を使って
 * 取得・解放する（実行中の他ジョブを中断して引き継ぐ必要があるため）。
 * 取得したトークンは戻り値の tokens として呼び出し元(apiServer.js)へ返し、
 * 呼び出し元の共通finallyブロックで最終解放させる。
 */
module.exports = async function runAllJob(ctx) {
  const {
    sseSend, progress, log, config, db, lockManager,
    discovery, detailFetcher, checkHighErrorRate, notifyPriceChange,
  } = ctx;

  let myDetailToken    = null;
  let myDiscoveryToken = null;

  Object.assign(progress, { job: 'all', page: 0, found: 0, total: 0, site: null, startedAt: Math.floor(Date.now() / 1000), done: false });

  // ── Phase 0: 実行中の価格更新を中断して detail ロックを取得 ──
  log.info('[api] all: acquiring detail lock (aborting running fetch if any)...');
  myDetailToken = await lockManager.abortAndTakeover('detail', {
    label: '価格更新', sseSend, timeoutMs: 15_000,
  });
  log.info('[api] all: detail lock acquired');

  // ── Phase 1: RJ収集（失敗しても Phase2 へ進む）──
  // 以前は handleRun 冒頭で 'all' 自身が discovery ロックを確保してしまっており、
  // このチェックが常に自分自身を指して true になるため、'all' は毎回120秒待った末に
  // 自分の discovery を一度も実行せず「スキップ」していたバグがあった。
  // (check → claim を await を挟まず同期的に行うことでスケジューラーとの競合も防ぐ)
  let discR = { discovered: 0 };
  if (lockManager.isBusy('discovery')) {
    log.info('[api] all: waiting for ongoing discovery...');
    sseSend('log', 'RJ収集が実行中のため完了を待っています...');
    const released = await lockManager.waitForRelease('discovery', { timeoutMs: 120_000, pollMs: 1000 });
    sseSend('log', released
      ? 'RJ収集スキップ（他のジョブで実行済み）'
      : 'RJ収集の完了待ちがタイムアウトしました。スキップして価格更新へ進みます');
  } else {
    // ここまで await を挟んでいないため、このチェック→確保は他から横取りされない
    const myAllDiscoveryToken = lockManager.acquire('discovery', 'all-discovery');
    myDiscoveryToken = myAllDiscoveryToken;
    try {
      discR = await discovery.runDiscovery() ?? discR;
      sseSend('log', `RJ収集完了 — 新規: ${discR.discovered}件`);
    } catch (discErr) {
      log.error('[api] all: discovery error (continuing to detail fetch)', discErr.message);
      sseSend('log', `⚠ RJ収集エラー: ${discErr.message} — 価格更新は続行します`);
    } finally {
      // Phase 2(価格更新)は discovery ロックを必要としないため、ここで早めに解放する
      lockManager.releaseOwned('discovery', myAllDiscoveryToken);
    }
  }

  // ── Phase 2: 価格更新（全 due 作品を処理）──
  // バグ修正: 99_999 は「実質無制限」のつもりの値だったが、実装上は
  // ハードキャップとして扱われるため、due作品数がこれを超えると
  // 残りが未処理のまま打ち切られていた（カタログ増加で顕在化）。
  // Infinity にすることで、真に due が枯渇するまで処理を続ける。
  //
  // 'turbo' と同じ concurrency/rateLimit ブーストを適用する。
  sseSend('log', '価格更新を開始します...');
  const fetchR = await detailFetcher.runDetailFetch(Infinity, {
    jobName:     'all',
    rateLimit:   config.fetch.turboRateLimit,
    concurrency: Math.max(config.fetch.concurrency ?? 1, config.fetch.turboConcurrency),
    onProgress: ({ processed, priceChanges, total }) => {
      Object.assign(progress, { found: processed, total });
      sseSend('progress', { processed, priceChanges, total });
      if (priceChanges > 0) sseSend('change', `価格変動: ${priceChanges}件`);
    },
  });
  // Phase 2 完了。detail ロックの解放は呼び出し元の共通finallyに任せる。

  // ── Phase 3: セールブースト ──
  const circles = db.getCirclesOnSale();
  db.boostCirclesBulk(circles.map(c => c.maker_id), 100, 7200);

  const summary = `新規:${discR.discovered}件 / 価格更新:${fetchR?.processed ?? 0}件 / 変動:${fetchR?.priceChanges ?? 0}件 / エラー:${fetchR?.errors ?? 0}件`;
  // バグ修正: 停止ボタンによる中断か正常完了かを digest.log から判別できるようにする。
  const stopped = !!global._crawlerAbort?.detail || !!global._crawlerAbort?.discovery;
  const errRate = checkHighErrorRate('all', fetchR);
  const result = { ok: true, discovered: discR.discovered, ...fetchR, stopped, ...errRate, finishedAt: Date.now() };
  sseSend(fetchR?.priceChanges > 0 ? 'change' : 'log', (stopped ? '全て巡回を停止しました — ' : '全て巡回完了 — ') + summary);
  if (fetchR?.priceChanges > 0) notifyPriceChange(fetchR.priceChanges);

  return { result, tokens: { detail: myDetailToken, discovery: myDiscoveryToken } };
};
