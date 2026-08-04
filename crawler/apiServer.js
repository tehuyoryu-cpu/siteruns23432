'use strict';

/**
 * crawler/apiServer.js
 * Built-in HTTP API server + embedded dashboard.
 *
 * Endpoints:
 *   GET  /                         → dashboard HTML
 *   GET  /api/stats                → overall counters
 *   GET  /api/works                → paginated works list  ?page&q&sort&onSale
 *   GET  /api/history/:rj          → price history for one work
 *   GET  /api/sales                → works currently on sale
 *   GET  /api/export/json          → full price_history JSON download
 *   GET  /api/export/csv           → full price_history CSV download
 *   GET  /api/run/status           → job running flags + progress
 *   GET  /api/settings             → github token config status (masked)
 *   POST /api/settings/github-token   → save github token (writes .github-token)
 *   DELETE /api/settings/github-token → remove saved github token
 *   POST /api/run/discover         → immediate discovery run
 *   POST /api/run/fetch            → immediate detail fetch run
 *   POST /api/run/saleboost        → immediate sale-boost run
 *   POST /api/run/all              → run all jobs immediately
 *   POST /api/run/fullscan         → FSR full-collection scan
 *   POST /api/run/fullscan_sale    → FSR sale-only scan
 *   POST /api/run/pushdata         → generate export shards + push to GitHub data branch
 *   GET  /api/log-stream           → SSE real-time log stream
 *   GET  /api/log                  → last 200 lines of log file
 *   GET  /api/debug/api-trace      → recent abnormal DLsite API responses (raw samples)
 *   GET  /api/debug/locks          → current job-lock/abort-signal snapshot
 *   GET  /api/debug/warmup-history → recent warmUpSession() results (periodicity check)
 */

const http   = require('http');
const url    = require('url');
const fs     = require('fs');
const path   = require('path');
const db     = require('./db');
const log    = require('./logger');
const config = require('../config');
const { runDiscovery, runFullScan, runEndingSoonScan, runNewReleaseScan, runCircleGapScan } = require('./discovery');
const detailFetcher = require('./detailFetcher');
const importData = require('./importData');
const compScan = require('./compScan');
const { runExportShards } = require('./exportShards');
const { abortNow, resetAbortFlag, getAllAbortStates } = require('./abortSignals');
const priceIssueMonitor = require('./priceIssueMonitor');
const apiTrace = require('./apiTrace');
// バグ修正(起動不能の真因): 以前はここで push-data-shards.js をモジュール読み込み時に
// 即requireしていた。electron-builderのfilesリストにscripts/**が含まれていなかった
// ため、パッケージ化されたexe(app.asar)内にこのファイルが同梱されず、apiServer.js
// がrequireされる起動シーケンスの時点で「Cannot find module」が投げられ、
// アプリが一切起動できなくなっていた(build-202〜205)。
// 呼び出し時(handleRun('pushdata')内)に遅延requireし、万一ファイルが無くても
// そのジョブだけがエラーになり、アプリ全体は起動できるようにする。

// ─── SSE ────────────────────────────────────────────────────────────────────

const _sseClients = new Set();

function _sseSend(event, data) {
  const msg = `event: ${event}\ndata: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
  for (const res of _sseClients) {
    try { res.write(msg); } catch { _sseClients.delete(res); }
  }
}

// logger の warn/error/info(crawler) を SSE にも流す
setTimeout(() => {
  const _origInfo  = log.info.bind(log);
  const _origWarn  = log.warn.bind(log);
  const _origError = log.error.bind(log);
  // logger.js の formatArgs と同じ整形を使う。
  // 以前は a.join(' ') を直接使っており、オブジェクト引数
  // （例: log.info('[detail] price changed', {...}) ）が
  // ダッシュボードのライブログ上で [object Object] になってしまっていた。
  log.info = (...a) => {
    _origInfo(...a);
    const msg = log.formatArgs(a);
    // crawlerのinfoのみSSEに流す（API/DB等の頻繁なログは除外）
    if (/\[(discovery|detail|scheduler|electron|compScan)\]/.test(msg)) {
      _sseSend('log', msg);
    }
  };
  log.warn  = (...a) => { _origWarn(...a);  _sseSend('warn',  log.formatArgs(a)); };
  log.error = (...a) => { _origError(...a); _sseSend('error', log.formatArgs(a)); };
  // apiServer から SSE 送信関数をグローバルに公開
  // （electron-main._execJob・scheduler がオンデマンドで使用）
  global._sseSend = _sseSend;
}, 0);

// ─── 進捗状態 ────────────────────────────────────────────────────────────────

const _jobRunning = {
  discover: false, fetch: false, saleboost: false,
  fullscan: false, fullscan_sale: false, all: false, turbo: false,
  endingsoon: false, circlegap: false, pushdata: false, newrelease: false,
  import: false, comp_listing: false, comp_detail: false, pushdebug: false,
};
const _lastResult = {};
const _progress = {
  job: null, page: 0, totalPages: null, found: 0,
  site: null, startedAt: null, done: false,
};

// ─── ジョブラベル ────────────────────────────────────────────────────────────
// フロントエンドの _JOB_LABELS と揃えておくことでエラーメッセージを日本語化する
const _JOB_LABELS = {
  discover:      'RJ収集',
  fetch:         '価格更新',
  saleboost:     'セール優先',
  all:           '全て巡回',
  fullscan:      '全収集',
  fullscan_sale: '全セール収集',
  turbo:         'ぶっ飛ばし',
  endingsoon:    '終了間近収集',
  circlegap:     'サークル欠落診断',
  pushdata:      'データPush',
  newrelease:    '新作収集',
  import:        'データインポート',
  comp_listing:  '総集編一覧走査',
  comp_detail:   '総集編詳細解析',
  pushdebug:     'デバッグ情報Push',
};

// ─── 中止（停止）機構 ─────────────────────────────────────────────────────────
// 各ジョブは内部的にすでに abort チェック済み（discovery.js の _discoveryAborted()、
// detailFetcher.js の isAborted()、compScan.js の shouldContinue()）だが、
// これまでユーザーがそれをトリガーする手段（停止ボタン/API）が無かった。
// ジョブ名 → 対応する global._crawlerAbort のキー のマッピングで一本化する。
const _ABORT_FLAG_BY_JOB = {
  discover: 'discovery', fullscan: 'discovery', fullscan_sale: 'discovery',
  endingsoon: 'discovery', circlegap: 'discovery', newrelease: 'discovery',
  fetch: 'detail', all: 'detail', turbo: 'detail',
  comp_listing: 'comp', comp_detail: 'comp',
};
// スケジューラー（cron）起動分の実行中判定に使う global._crawlerRunning のキー。
// これが無いジョブ（fullscan等）はAPI起動でしか実行されないため _jobRunning だけで足りる。
const _SCHEDULER_RUNNING_KEY_BY_JOB = {
  discover: 'discovery', fetch: 'detail', all: 'detail', turbo: 'detail',
  comp_listing: 'compListing', comp_detail: 'compDetail',
};

// ─── turbo/all の高負荷起因エラー率の自動検知 ────────────────────────────────
// バグ修正の経緯: digest.log実データで、通常のfetch(cron, concurrency:3/rateLimit:700ms)
// はほぼerrors:0件なのに対し、turbo/all(ブースト設定)はerrors数千〜3万件台まで積み上がる
// 回が頻発していた('all' errors:30011件、'turbo' errors:7555件等)。サーキットブレーカー・
// 再ウォームは劣化後の誤delisted化を防ぐ後始末でしかなく、劣化の発生自体(turbo自身の
// 並列負荷がセッション劣化/レート制限を誘発している可能性)を可視化できていなかった。
// 完了時にエラー率を計算し、閾値超過時は digest.log に highErrorRate フラグを残して
// 一目で「今回は負荷起因の劣化が疑われる回だった」と分かるようにする。
//
// バグ修正: 以前はここで denom<50・閾値0.15 を独自に再計算しており、
// detailFetcher.js の自動スロットル(_updateAutoThrottleStreak)側にも
// 全く同じ計算が別途あった。片方だけ閾値を変えると「自動抑制が発動する
// 基準」と「digest.logに出るhighErrorRate表示」が食い違うバグになりうる。
// detailFetcher.js が runDetailFetch() の戻り値に errorRate/highErrorRate を
// 既に付与している(一次情報源はそちら)ため、ここでは再計算せずそれを読むだけにする。
function _checkHighErrorRate(job, result) {
  const highErrorRate = result?.highErrorRate ?? false;
  const errorRate     = result?.errorRate ?? null;
  if (highErrorRate) {
    const denom = (result.processed ?? 0) + (result.errors ?? 0);
    log.warn(`[api] ${job}: エラー率が高水準です(${(errorRate * 100).toFixed(1)}% — ${result.errors}/${denom}件)。` +
      'turboConcurrency/turboRateLimit(config.fetch)の負荷設定見直しを検討してください。');
  }
  return { highErrorRate, errorRate };
}

function handleStop(job, res) {
  // バグ修正/機能追加: 'turbo' は detail(価格更新) と discovery(新作収集/終了間近収集)を
  // 同時並行で実行するようになったため、停止操作も両方のabortフラグを立てる必要がある。
  // 単一文字列を返す _ABORT_FLAG_BY_JOB[job] だけでは detail 側しか止まらず、
  // newrelease/endingsoonの走査が停止操作後も動き続けてしまうバグになる。
  const abortFlags = job === 'turbo'
    ? ['detail', 'discovery']
    : [_ABORT_FLAG_BY_JOB[job]].filter(Boolean);
  if (!abortFlags.length) {
    return _json(res, { ok: false, message: (_JOB_LABELS[job] ?? job) + 'は短時間で完了するため停止操作は不要です' });
  }
  const schedKey = _SCHEDULER_RUNNING_KEY_BY_JOB[job];
  const busy = _jobRunning[job] || (schedKey && !!global._crawlerRunning?.[schedKey]);
  if (!busy) {
    return _json(res, { ok: false, message: '実行中の' + (_JOB_LABELS[job] ?? job) + 'はありません' });
  }
  if (!global._crawlerAbort) global._crawlerAbort = {};
  for (const abortFlag of abortFlags) {
    global._crawlerAbort[abortFlag] = true;
    // バグ修正: 真偽値フラグだけではループの合間（次のバッチ/次のfetch開始時）
    // にしかチェックされず、進行中のfetchやリトライ待機（最大60秒超）が
    // 終わるまで停止が反映されなかった。abortSignals経由で該当ジョブ系統の
    // fetch・バックオフ待機を即座に中断させる。
    abortNow(abortFlag);
  }
  log.info('[api] stop requested for', job, '(abort flags:', abortFlags.join(',') + ')');
  return _json(res, { ok: true, message: (_JOB_LABELS[job] ?? job) + 'の停止を要求しました' });
}

// ─── ジョブ実行 ──────────────────────────────────────────────────────────────

async function handleRun(job, res) {
  // schedulerと共有フラグを確認（schedulerが実行中なら HTTP API からも起動しない）
  if (!global._crawlerRunning) global._crawlerRunning = {};
  const shared     = global._crawlerRunning;
  // バグ修正(競合リスク): 'pushdata' はこれまで sharedKeys に含まれておらず、
  // scheduler.js の6時間毎の自動push(_startExportShardsJob)と、この手動push
  // ボタンが排他されないまま同じ data-export/ ディレクトリへ書き込み・同じ
  // GitHub dataブランチへ push できてしまっていた。差分push化(push-data-shards.js)
  // で base_tree に取得直後のリモートtree shaを使うため、2つの実行が競合すると
  // 片方のforce-update refがもう片方の変更を巻き戻す可能性がある。
  // 'pushdata' 自身を共有ロックキーとして登録し、scheduler.js 側にも同じ
  // global._crawlerRunning.pushdata を見させることで排他する。
  const sharedKeys = { discover: 'discovery', fetch: 'detail', turbo: 'detail', comp_listing: 'compListing', comp_detail: 'compDetail', pushdata: 'pushdata' };
  const sharedKey  = sharedKeys[job];
  // detail / discovery ロックの所有者トークン。自分が確保した場合のみ
  // this 関数内の finally で解放する。
  // (横取り/横取られによる「他人のロックを誤って解放してしまう」バグを防ぐ)
  let myDetailToken    = null;
  let myDiscoveryToken = null;

  if (_jobRunning[job]) {
    return _json(res, { ok: false, message: (_JOB_LABELS?.[job] ?? job) + ' はすでに実行中です' });
  }
  // 'all'/'turbo' 以外で共有ロックが取れない場合はブロック
  if (job !== 'all' && job !== 'turbo' && sharedKey && shared[sharedKey]) {
    return _json(res, { ok: false, message: '他の巡回処理が実行中です。完了後にお試しください' });
  }
  // バグ修正: 以前は中止フラグ(global._crawlerAbort.*)を一度trueにした後、
  // 次回このジョブを実行する前にfalseへ戻す処理がどこにも無かった。
  // そのため一度でも停止ボタンを押すと、同じ系統(discovery/detail/comp)の
  // 以降のジョブが起動直後に即座に中断扱いになってしまうバグがあった。
  // 新しい実行を開始するたびに、このジョブが使う中止フラグを確実にリセットする。
  // 機能追加: 'turbo' は detail(価格更新) + discovery(新作収集/終了間近収集) を
  // 並列実行するため、両方のabortフラグを新規実行のたびにリセットする必要がある。
  // 片方だけリセットすると、前回の停止操作が残っていたもう片方の系統が
  // 開始直後から中断扱いになってしまう。
  const _abortFlagsForThisJob = job === 'turbo'
    ? ['detail', 'discovery']
    : [_ABORT_FLAG_BY_JOB[job]].filter(Boolean);
  if (_abortFlagsForThisJob.length) {
    if (!global._crawlerAbort) global._crawlerAbort = {};
    for (const f of _abortFlagsForThisJob) {
      global._crawlerAbort[f] = false;
      // 前回中止時に abort() 済みの AbortController を使い回すと、fetch側の
      // 中断チェックが新規実行の初回リクエストから即座にtrueになってしまうため、
      // 真偽値フラグと同様にこちらも新しい実行のたびにリセットする。
      resetAbortFlag(f);
    }
  }
  _jobRunning[job] = true;
  if (sharedKey) {
    shared[sharedKey] = true;
    if (sharedKey === 'detail') {
      myDetailToken = Symbol('api-' + job);
      shared._detailOwner = myDetailToken;
    } else if (sharedKey === 'discovery') {
      myDiscoveryToken = Symbol('api-' + job);
      shared._discoveryOwner = myDiscoveryToken;
    }
  }
  // 'discover' の discovery ロックはここで事前確保（スケジューラーとの競合防止）。
  // 'all' は discovery を必ずしも自分で実行するとは限らない（他者が実行中なら
  // スキップする）ため、ここでは確保せず Phase 1 内で自分自身が必要な時だけ確保する。
  // detail ロックは try ブロック内で abort 後に確保する（'all'/'turbo'）
  _lastResult[job] = null;
  const _jobStart = Date.now();

  _json(res, { ok: true, message: `${job} started` });

  try {
    if (job === 'discover') {
      Object.assign(_progress, { job, page: 0, found: 0, site: 'maniax', startedAt: Math.floor(Date.now() / 1000), done: false });
      const r = await runDiscovery();
      // バグ修正: 停止ボタンで中断された実行も ok:true のまま digest.log に
      // 記録されており、あとからログを見ても「意図的に停止したのか、
      // 単に完了したのか」が区別できなかった。完了時点の中止フラグを見て
      // stopped を明示する（他のジョブと同じパターン、詳細は下のturbo/fetch参照）。
      const stoppedDiscover = !!global._crawlerAbort?.discovery;
      _lastResult[job] = { ok: true, discovered: r?.discovered ?? 0, stopped: stoppedDiscover, finishedAt: Date.now() };
      _sseSend('log', (stoppedDiscover ? 'RJ収集を停止しました — ' : 'discovery完了 — ') + `新規: ${r?.discovered ?? 0}件`);

    } else if (job === 'fetch') {
      const startedAt = Math.floor(Date.now() / 1000);
      Object.assign(_progress, { job, page: 0, found: 0, total: 0, site: null, startedAt, done: false });
      const r = await detailFetcher.runDetailFetch(300, {
        jobName: 'fetch',
        onProgress: ({ processed, priceChanges, total }) => {
          Object.assign(_progress, { found: processed, total });
          _sseSend('progress', { processed, priceChanges, total });
          if (priceChanges > 0) _sseSend('change', `価格変動: ${priceChanges}件`);
        },
      });
      // バグ修正: 停止ボタンによる中断か、単なる正常完了かを digest.log から
      // 判別できるようにする（同上）。
      const stoppedFetch = !!global._crawlerAbort?.detail;
      _lastResult[job] = { ok: true, ...r, stopped: stoppedFetch, finishedAt: Date.now() };
      _sseSend(r?.priceChanges > 0 ? 'change' : 'log',
        (stoppedFetch ? '価格更新を停止しました — ' : '価格更新完了 — ') + `処理:${r?.processed ?? 0}件 変動:${r?.priceChanges ?? 0}件`);
      if (r?.priceChanges > 0 && global._notifyPriceChange) {
        global._notifyPriceChange(r.priceChanges);
      }

    } else if (job === 'saleboost') {
      const circles = db.getCirclesOnSale();
      // バグ修正: 以前はサークル毎に1文ずつUPDATEを発行し、それら数万件を
      // 1本の巨大なdb.transaction()で包んでいたため、WAL単一ライターロックを
      // 数秒〜数十秒も占有し続け、並行する価格更新の書き込みを止めていた
      // ([db] slow transaction の主因)。json_each()による一括UPDATEに変更。
      db.boostCirclesBulk(circles.map(c => c.maker_id), 100, 7200);
      db.syncCircleWorksCounts();
      log.info('[api] saleboost done, circles:', circles.length);

    } else if (job === 'all') {
      Object.assign(_progress, { job, page: 0, found: 0, total: 0, site: null, startedAt: Math.floor(Date.now() / 1000), done: false });

      // ── Phase 0: 実行中の価格更新を中断して detail ロックを取得 ──
      if (shared['detail']) {
        if (!global._crawlerAbort) global._crawlerAbort = {};
        global._crawlerAbort.detail = true;
        abortNow('detail');   // 進行中のfetch/バックオフ待機も即座に中断する
        _sseSend('log', '価格更新を中断して全て巡回を優先します...');
        log.info('[api] all: aborting running detail fetch...');
        const abortStart = Date.now();
        await new Promise(resolve => {
          const t = setInterval(() => {
            if (!shared['detail'] || Date.now() - abortStart > 15_000) {
              clearInterval(t); resolve();
            }
          }, 150);
        });
        global._crawlerAbort.detail = false;
        resetAbortFlag('detail');
        log.info('[api] all: detail fetch stopped');
      }
      shared['detail'] = true;   // detail ロック確保
      myDetailToken = Symbol('api-all');
      shared._detailOwner = myDetailToken;

      // ── Phase 1: RJ収集（失敗しても Phase2 へ進む）──
      // 以前は handleRun 冒頭で 'all' 自身が discovery ロックを確保してしまっており、
      // このチェックが常に自分自身を指して true になるため、'all' は毎回120秒待った末に
      // 自分の discovery を一度も実行せず「スキップ」していたバグがあった。
      // (check → claim を await を挟まず同期的に行うことでスケジューラーとの競合も防ぐ)
      let discR = { discovered: 0 };
      if (global._crawlerRunning?.discovery) {
        log.info('[api] all: waiting for ongoing discovery...');
        _sseSend('log', 'RJ収集が実行中のため完了を待っています...');
        const waitStart = Date.now();
        await new Promise(resolve => {
          const t = setInterval(() => {
            if (!global._crawlerRunning?.discovery || Date.now() - waitStart > 120_000) {
              clearInterval(t); resolve();
            }
          }, 1000);
        });
        if (global._crawlerRunning?.discovery) {
          _sseSend('log', 'RJ収集の完了待ちがタイムアウトしました。スキップして価格更新へ進みます');
        } else {
          _sseSend('log', 'RJ収集スキップ（他のジョブで実行済み）');
        }
      } else {
        // ここまで await を挟んでいないため、このチェック→確保は他から横取りされない
        if (!global._crawlerRunning) global._crawlerRunning = {};
        const myAllDiscoveryToken = Symbol('api-all-discovery');
        global._crawlerRunning.discovery = true;
        global._crawlerRunning._discoveryOwner = myAllDiscoveryToken;
        myDiscoveryToken = myAllDiscoveryToken;
        try {
          discR = await runDiscovery() ?? discR;
          _sseSend('log', `RJ収集完了 — 新規: ${discR.discovered}件`);
        } catch (discErr) {
          log.error('[api] all: discovery error (continuing to detail fetch)', discErr.message);
          _sseSend('log', `⚠ RJ収集エラー: ${discErr.message} — 価格更新は続行します`);
        } finally {
          // Phase 2(価格更新)は discovery ロックを必要としないため、ここで早めに解放する
          if (global._crawlerRunning?._discoveryOwner === myAllDiscoveryToken) {
            global._crawlerRunning.discovery = false;
            global._crawlerRunning._discoveryOwner = null;
          }
        }
      }

      // ── Phase 2: 価格更新（全 due 作品を処理）──
      // バグ修正: 99_999 は「実質無制限」のつもりの値だったが、実装上は
      // ハードキャップとして扱われるため、due作品数がこれを超えると
      // 残りが未処理のまま打ち切られていた（カタログ増加で顕在化）。
      // Infinity にすることで、真に due が枯渇するまで処理を続ける。
      //
      // 'turbo' と同じ concurrency/rateLimit ブーストを適用する。
      // 以前は 'all' の Phase2 だけ素の設定(concurrency=3, rateLimit=700ms)のまま
      // 実行されており、'turbo' で動作確認済み(concurrency=6, rateLimit=200ms)の
      // 速度が「全て巡回」には反映されていなかった。
      _sseSend('log', '価格更新を開始します...');
      // バグ修正: 以前は config.fetch.rateLimit/concurrency をグローバルに
      // 一時上書きしてから finally で戻していたが、これはモジュール全体で
      // 共有される状態のため、ブースト中に他の処理(scheduler の定期detail等)
      // が同じ config を参照するとレース状態になりうる。runDetailFetch に
      // 直接オーバーライド値を渡し、グローバルは一切変更しない。
      const fetchR = await detailFetcher.runDetailFetch(Infinity, {
        jobName:     'all',
        rateLimit:   config.fetch.turboRateLimit,
        concurrency: Math.max(config.fetch.concurrency ?? 1, config.fetch.turboConcurrency),
        onProgress: ({ processed, priceChanges, total }) => {
          Object.assign(_progress, { found: processed, total });
          _sseSend('progress', { processed, priceChanges, total });
          if (priceChanges > 0) _sseSend('change', `価格変動: ${priceChanges}件`);
        },
      });
      // Phase 2 完了。detail ロックの解放は finally の releaseDetail()（トークン一致チェックあり）に任せる。
      // ここで直接 shared['detail'] = false をしていた旧コードはトークン保護を素通りするバグがあった。

      // ── Phase 3: セールブースト ──
      // バグ修正: saleboostジョブと同じ理由で一括UPDATEに変更
      // ([db] slow transaction の主因、詳細はdb.boostCirclesBulk()コメント参照)。
      const circles = db.getCirclesOnSale();
      db.boostCirclesBulk(circles.map(c => c.maker_id), 100, 7200);

      const summary = `新規:${discR.discovered}件 / 価格更新:${fetchR?.processed ?? 0}件 / 変動:${fetchR?.priceChanges ?? 0}件 / エラー:${fetchR?.errors ?? 0}件`;
      // バグ修正: 停止ボタンによる中断か正常完了かを digest.log から判別できるようにする。
      const stoppedAll = !!global._crawlerAbort?.detail || !!global._crawlerAbort?.discovery;
      const errRateAll = _checkHighErrorRate(job, fetchR);
      _lastResult[job] = { ok: true, discovered: discR.discovered, ...fetchR, stopped: stoppedAll, ...errRateAll, finishedAt: Date.now() };
      _sseSend(fetchR?.priceChanges > 0 ? 'change' : 'log', (stoppedAll ? '全て巡回を停止しました — ' : '全て巡回完了 — ') + summary);
      // バックグラウンド通知（価格変動時）
      if (fetchR?.priceChanges > 0 && global._notifyPriceChange) {
        global._notifyPriceChange(fetchR.priceChanges);
      }

    } else if (job === 'turbo') {
      // ぶっ飛ばしモード: 価格更新(detail)・新作収集(newrelease)・終了間近収集(endingsoon)を
      // 同時並行で実行する。3つは互いに別々のFSR/APIエンドポイントを叩く独立した処理のため、
      // 直列(discover→…→fetch)で回すより1周あたりの所要時間を大きく短縮できる。
      //
      // detail は 'detail' ロック、newrelease/endingsoon は 'discovery' ロックを使う
      // （discover/fullscan等と同じ系統）。turbo開始時にどちらかが既に実行中なら、
      // 既存の detail 中断ロジックと同じパターンでいったん中断してから引き継ぐ。
      const _abortAndTakeLock = async (lockKey, label) => {
        if (shared[lockKey]) {
          if (!global._crawlerAbort) global._crawlerAbort = {};
          global._crawlerAbort[lockKey] = true;
          abortNow(lockKey);   // 進行中のfetch/バックオフ待機も即座に中断する
          _sseSend('log', `${label}を中断してぶっ飛ばしに合流します...`);
          const abortStart = Date.now();
          await new Promise(resolve => {
            const t = setInterval(() => {
              if (!shared[lockKey] || Date.now() - abortStart > 15_000) {
                clearInterval(t); resolve();
              }
            }, 150);
          });
          global._crawlerAbort[lockKey] = false;
          resetAbortFlag(lockKey);
        }
        shared[lockKey] = true;
      };

      await _abortAndTakeLock('detail', '価格更新');
      myDetailToken = Symbol('api-turbo');
      shared._detailOwner = myDetailToken;

      await _abortAndTakeLock('discovery', '収集系ジョブ');
      myDiscoveryToken = Symbol('api-turbo-discovery');
      shared._discoveryOwner = myDiscoveryToken;

      _sseSend('log', '🚀 ぶっ飛ばしモード開始 — 価格更新・新作収集・終了間近収集を並列実行します');
      // subJobs: newrelease/endingsoon の進捗はダッシュボードのメイン進捗バー
      // (found/total)には反映しない（価格更新の件数と混ざって意味不明になるため）。
      // ログパネルへは既存の [discovery] ログ転送(SSE 'log')でそのまま流れる。
      Object.assign(_progress, {
        job, found: 0, total: 0,
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
            Object.assign(_progress, { found: processed, total });
            _sseSend('progress', { processed, priceChanges, total });
            if (priceChanges > 0) _sseSend('change', `価格変動: ${priceChanges}件`);
          },
        }),
        runNewReleaseScan({
          onProgress: ({ site, page, found, total }) => {
            _progress.subJobs.newrelease = { site, page, found: total };
            _sseSend('progress', { job: 'newrelease', site, page, found: total });
          },
        }).catch(e => {
          log.error('[api] turbo: newReleaseScan error (continuing)', e.message);
          _sseSend('warn', `新作収集エラー: ${e.message} — 価格更新・終了間近収集は続行します`);
          return { grandTotal: 0, error: e.message };
        }),
        runEndingSoonScan({
          onProgress: ({ site, page, found, total }) => {
            _progress.subJobs.endingsoon = { site, page, found: total };
            _sseSend('progress', { job: 'endingsoon', site, page, found: total });
          },
        }).catch(e => {
          log.error('[api] turbo: endingSoonScan error (continuing)', e.message);
          _sseSend('warn', `終了間近収集エラー: ${e.message} — 価格更新・新作収集は続行します`);
          return { grandTotal: 0, newCount: 0, boostedCount: 0, error: e.message };
        }),
      ]);

      // バグ修正: 停止ボタンによる中断か正常完了かを digest.log から判別できるようにする。
      const stoppedTurbo = !!global._crawlerAbort?.detail || !!global._crawlerAbort?.discovery;
      const errRateTurbo = _checkHighErrorRate(job, detailR);
      _lastResult[job] = {
        ok: true, ...detailR,
        newRelease: newReleaseR, endingSoon: endingSoonR,
        stopped: stoppedTurbo, ...errRateTurbo, finishedAt: Date.now(),
      };
      const msg =
        (stoppedTurbo ? '🚀 ぶっ飛ばしを停止しました — ' : 'ぶっ飛ばし完了 — ') +
        `価格更新:${detailR?.processed ?? 0}件 変動:${detailR?.priceChanges ?? 0}件` +
        ` / 新作収集:新規${newReleaseR?.grandTotal ?? 0}件` +
        ` / 終了間近:新規${endingSoonR?.newCount ?? 0}件・優先度UP${endingSoonR?.boostedCount ?? 0}件`;
      _sseSend(detailR?.priceChanges > 0 ? 'change' : 'log', msg);
      if (detailR?.priceChanges > 0 && global._notifyPriceChange) global._notifyPriceChange(detailR.priceChanges);

    } else if (job === 'endingsoon') {
      // 割引終了まで24時間以内(soon/1)の作品を優先度最優先で収集する
      Object.assign(_progress, { job, page: 0, found: 0, site: null, startedAt: Math.floor(Date.now() / 1000), done: false });
      const result = await runEndingSoonScan({
        onProgress: ({ site, page, found, total }) => {
          Object.assign(_progress, { site, page, found: total, totalPages: null });
          _sseSend('progress', { site, page, found: total });
        },
      });
      _lastResult[job] = { ok: true, ...result, finishedAt: Date.now() };
      Object.assign(_progress, { done: true });
      _sseSend('log', `終了間近収集完了 — 新規:${result?.newCount ?? 0}件 優先度UP:${result?.boostedCount ?? 0}件`);
      log.info('[api] endingSoonScan done', result);

    } else if (job === 'newrelease') {
      // 過去1年以内に発売された全作品を、割引の有無を問わずFSR全ページ走査で収集する
      // (終了間近収集から割引条件と24時間以内終了条件を外したもの)
      Object.assign(_progress, { job, page: 0, found: 0, site: null, startedAt: Math.floor(Date.now() / 1000), done: false });
      const result = await runNewReleaseScan({
        onProgress: ({ site, page, found, total }) => {
          Object.assign(_progress, { site, page, found: total, totalPages: null });
          _sseSend('progress', { site, page, found: total });
        },
      });
      _lastResult[job] = { ok: true, ...result, finishedAt: Date.now() };
      Object.assign(_progress, { done: true });
      _sseSend('log', `新作収集完了 — 新規:${result?.grandTotal ?? 0}件`);
      log.info('[api] newReleaseScan done', result);

    } else if (job === 'circlegap') {
      // サークル単位の欠落診断: 既知の全サークルについてDLsite上の全作品ページを
      // 走査し、DBに存在しないRJコードを検出・登録する。
      // 未チェック/最も古くチェックされたサークルから優先するため、中止しても
      // 次回実行時は続きから再開される（同じサークルを何度もなぞらない）。
      Object.assign(_progress, { job, page: 0, found: 0, totalPages: 0, site: null, startedAt: Math.floor(Date.now() / 1000), done: false });
      const result = await runCircleGapScan({
        onProgress: ({ checked, total, totalMissing, makerId, page }) => {
          Object.assign(_progress, { found: checked, totalPages: total, site: makerId, page: page ?? 0 });
          _sseSend('progress', { checked, total, totalMissing, makerId, page });
        },
      });
      const stopped = !!global._crawlerAbort?.discovery;
      _lastResult[job] = { ok: true, ...result, stopped, finishedAt: Date.now() };
      Object.assign(_progress, { done: true });
      const gapSummary = `チェック:${result.checked}/${result.totalCircles}サークル` +
        (result.resumedFromPrevious ? '（前回の続きから再開）' : '') +
        ` / 発見した欠落:${result.totalMissing}件` +
        (result.totalMissing > 0 ? ` (${Object.keys(result.missingByCircle).length}サークルで検出)` : '') +
        (result.skippedInvalidSite > 0 ? ` / site_id不明で除外:${result.skippedInvalidSite}サークル` : '');
      const suffix = stopped ? '（続きは次回実行時に再開されます）'
        : result.timedOut ? '（1回の実行あたりの時間上限に到達 — 続きは次回実行時に再開されます）'
        : '';
      _sseSend(result.totalMissing > 0 ? 'change' : 'log',
        (stopped ? 'サークル欠落診断を停止しました — ' : 'サークル欠落診断完了 — ') + gapSummary + suffix);
      log.info('[api] circleGapScan done', { ...result, stopped });

    } else if (job === 'comp_listing') {
      // 総集編マーク Phase A: ジャンル515一覧を巡回し、総集編“作品”RJを収集する
      if (!global._crawlerAbort) global._crawlerAbort = {};
      global._crawlerAbort.comp = false;   // 停止ボタンからの中断要求フラグをリセット
      resetAbortFlag('comp');
      Object.assign(_progress, { job, page: 0, found: 0, site: null, startedAt: Math.floor(Date.now() / 1000), done: false });
      const result = await compScan.runListingScan({
        shouldContinue: () => !global._crawlerAbort?.comp,
        onProgress: ({ page, found, added, totalAdded }) => {
          Object.assign(_progress, { page, found: totalAdded });
          _sseSend('progress', { page, found: totalAdded });
        },
      });
      const stopped = !!global._crawlerAbort?.comp;
      _lastResult[job] = { ok: true, ...result, stopped, finishedAt: Date.now() };
      Object.assign(_progress, { done: true });
      _sseSend('log', stopped
        ? `総集編一覧走査を停止しました — 新規候補:${result.added ?? 0}件（続きから再開可能）`
        : result.alreadyDone
          ? '総集編一覧走査は完了済みです（再走査するには要リセット）'
          : `総集編一覧走査完了 — 新規候補:${result.added ?? 0}件`);
      log.info('[api] compListingScan done', { ...result, stopped });

    } else if (job === 'comp_detail') {
      // 総集編マーク Phase B: 候補の詳細解析（直接抽出→サークル推定）
      if (!global._crawlerAbort) global._crawlerAbort = {};
      global._crawlerAbort.comp = false;   // 停止ボタンからの中断要求フラグをリセット
      resetAbortFlag('comp');
      Object.assign(_progress, { job, page: 0, found: 0, total: 0, site: null, startedAt: Math.floor(Date.now() / 1000), done: false });
      const result = await compScan.runDetailScan({
        limit: 200,
        shouldContinue: () => !global._crawlerAbort?.comp,
        onProgress: ({ processed, total, direct, confirmed, pending }) => {
          Object.assign(_progress, { found: processed, total });
          _sseSend('progress', { processed, total });
        },
      });
      const stopped = !!global._crawlerAbort?.comp;
      _lastResult[job] = { ok: true, ...result, stopped, finishedAt: Date.now() };
      Object.assign(_progress, { done: true });
      _sseSend(result.confirmed > 0 || result.direct > 0 ? 'change' : 'log',
        (stopped ? '総集編詳細解析を停止しました — ' : '総集編詳細解析完了 — ') +
        `処理:${result.processed}件 / 直接抽出:${result.direct}件 / 推定確定:${result.confirmed}件 / 要確認:${result.pending}件 / エラー:${result.errors}件`);
      log.info('[api] compDetailScan done', { ...result, stopped });

    } else if (job === 'pushdata') {
      // 手動pushボタン: 日次04:30スケジューラー(runExportShards → push-data-shards.main())
      // と全く同じパイプラインをオンデマンドで実行する。
      Object.assign(_progress, { job, page: 0, found: 0, site: null, startedAt: Math.floor(Date.now() / 1000), done: false });

      _sseSend('log', '配信データを生成中...');
      const exportResult = await runExportShards();
      _sseSend('log',
        `エクスポート完了 — ${exportResult?.works ?? 0}作品 / shard:${exportResult?.dataShardFiles ?? 0}件 / index:${exportResult?.idxShardFiles ?? 0}件`);
      Object.assign(_progress, { found: exportResult?.works ?? 0 });

      _sseSend('log', 'GitHub dataブランチへpush中...');
      const { main: pushDataShards } = require('../scripts/push-data-shards');
      const pushResult = await pushDataShards({
        onProgress: ({ done, total }) => {
          Object.assign(_progress, { page: done, totalPages: total });
          _sseSend('progress', { page: done, total, phase: 'push' });
        },
      });

      if (pushResult?.ok && pushResult?.skipped && pushResult?.reason === 'no-changes') {
        // 効率化(差分push): 前回pushから内容が一切変わっていない場合、
        // push-data-shards.js はコミット自体を作らずに正常終了する。
        // ok:true だが commit は存在しないため、他の成功時と分岐して案内する。
        _lastResult[job] = { ok: true, ...pushResult, exportResult, finishedAt: Date.now() };
        _sseSend('log', `GitHub push完了 — 変更なし(前回pushと同一のため${pushResult.files}ファイル中0件のみ確認)`);
        log.info('[api] pushdata done (no changes)', { exportResult, pushResult });
      } else if (pushResult?.ok) {
        _lastResult[job] = { ok: true, ...pushResult, exportResult, finishedAt: Date.now() };
        const changedInfo = pushResult.changed != null ? ` (うち変更:${pushResult.changed}件)` : '';
        _sseSend('change', `GitHub push完了 — ${pushResult.files}ファイル${changedInfo} / commit:${(pushResult.commit ?? '').slice(0, 7)}`);
        log.info('[api] pushdata done', { exportResult, pushResult });
      } else {
        // トークン未設定・出力なし等の意図的なスキップは「失敗」ではないが、
        // 手動ボタンから押した以上はユーザーに理由が見えないと意味がないため
        // 明示的に warn として可視化する（従来のスケジューラー任せの
        // log.info()化バグの再発防止）。
        _lastResult[job] = { ok: false, skipped: !!pushResult?.skipped, error: pushResult?.message ?? 'push失敗', exportResult, finishedAt: Date.now() };
        _sseSend('warn', `GitHub pushスキップ/失敗 — ${pushResult?.message ?? '不明なエラー'}`);
        log.warn('[api] pushdata skipped/failed', pushResult);
      }
      Object.assign(_progress, { done: true });

    } else if (job === 'pushdebug') {
      // 手動デバッグPushボタン: ジョブ完了を待たず、いま現在のログ/DB統計を
      // debugブランチへ即時pushする（不具合調査でAI/開発者が即座に参照したい時用）。
      Object.assign(_progress, { job, page: 0, found: 0, site: null, startedAt: Math.floor(Date.now() / 1000), done: false });
      _sseSend('log', 'デバッグ情報(ログ・DB統計)をGitHub debugブランチへpush中...');
      const { pushDebugBundle } = require('../scripts/pushDebugBundle');
      const pushResult = await pushDebugBundle({ job: 'manual' });

      if (pushResult?.ok) {
        _lastResult[job] = { ok: true, ...pushResult, finishedAt: Date.now() };
        _sseSend('change', `デバッグ情報push完了 — ${pushResult.files}ファイル`);
        log.info('[api] pushdebug done', pushResult);
      } else {
        _lastResult[job] = { ok: false, skipped: !!pushResult?.skipped, error: pushResult?.reason ?? pushResult?.error ?? '不明なエラー', finishedAt: Date.now() };
        _sseSend('warn', `デバッグ情報pushスキップ/失敗 — ${pushResult?.reason ?? pushResult?.error ?? '不明なエラー'}`);
        log.warn('[api] pushdebug skipped/failed', pushResult);
      }
      Object.assign(_progress, { done: true });

    } else if (job === 'fullscan' || job === 'fullscan_sale') {
      const sale = job === 'fullscan_sale';
      Object.assign(_progress, { job, page: 0, found: 0, site: null, startedAt: Math.floor(Date.now() / 1000), done: false });
      const result = await runFullScan({
        sale,
        maxPages: 0,
        onProgress: ({ site, page, found: pageFound, total }) => {
          Object.assign(_progress, { site, page, found: total, totalPages: null });
          _sseSend('progress', { site, page, found: total });
        },
      });
      _lastResult[job] = { ok: true, ...result, finishedAt: Date.now() };
      Object.assign(_progress, { done: true });
      log.info('[api] fullScan done', result);
    }
  } catch (err) {
    log.error('[api] run error', job, err.message);
    _lastResult[job] = { ok: false, error: err.message, finishedAt: Date.now() };
  } finally {
    _jobRunning[job] = false;
    const sk = sharedKeys[job];
    // 自分が確保した detail ロックの場合のみ解放する（横取りされていたら何もしない）
    const releaseDetail = () => {
      if (global._crawlerRunning && global._crawlerRunning._detailOwner === myDetailToken) {
        global._crawlerRunning.detail = false;
        global._crawlerRunning._detailOwner = null;
      }
    };
    const releaseDiscovery = () => {
      if (global._crawlerRunning && global._crawlerRunning._discoveryOwner === myDiscoveryToken) {
        global._crawlerRunning.discovery = false;
        global._crawlerRunning._discoveryOwner = null;
      }
    };
    if (sk === 'detail') {
      releaseDetail();
    } else if (sk === 'discovery') {
      releaseDiscovery();
    } else if (sk && global._crawlerRunning) {
      global._crawlerRunning[sk] = false;
    }
    // 'all' は detail ロックを保持したまま Phase2/3 を実行するため最後に解放する。
    // discovery ロックは Phase 1 内で既に解放済みのはずだが、例外発生時の保険として
    // ここでも自分のトークンが残っていれば解放する。
    // 'turbo' は detail(価格更新) と discovery(新作収集/終了間近収集) の両方を
    // Promise.all で並列保持したまま実行するため、両方ともここで解放する。
    if (job === 'all' || job === 'turbo') releaseDetail();
    if (job === 'all' || job === 'turbo') releaseDiscovery();
    _progress.done = true;

    // ジョブ単位のサマリを digest.log / events.jsonl に記録する。
    // _lastResult[job] の形はジョブごとにまちまちなので、finishedAt を除いて
    // そのままフラットに渡す（新しいジョブ種別が増えても自動で対応できる）。
    const r = _lastResult[job];
    const digestFields = { duration: ((Date.now() - _jobStart) / 1000).toFixed(1) + 's' };
    if (r) {
      for (const [k, v] of Object.entries(r)) {
        if (k === 'finishedAt') continue;
        digestFields[k] = v;
      }
    }
    log.digest(job, digestFields);

    // ログ削減: dedupe集約は従来60秒の固定ウィンドウでしかフラッシュされず、
    // 大量due処理(due数千件)では1回のジョブの中で何度もウィンドウが切り替わり、
    // 「集約されたはずの警告」が結局複数の集約行に分かれて出力され続けていた。
    // ジョブ完了時点で確実に1回フラッシュすることで、同一ジョブ実行中に発生した
    // 同種メッセージが可能な限り1つの集約行にまとまるようにする
    // (60秒タイマー自体は長時間ジョブ向けの保険として残す)。
    log.flush();

    // 機能追加④: 価格取得エラー急増検知。detail(価格更新)を伴うジョブの
    // 完了ごとに前回計測値と比較する。
    if (job === 'fetch' || job === 'all' || job === 'turbo') {
      priceIssueMonitor.checkSpike(job);
    }
  }
}

// ─── API ハンドラ ─────────────────────────────────────────────────────────────

// ─── データインポート(CSV/JSON復旧) ───────────────────────────────────────────

function handleImport({ path: filePath, format = 'auto' }, res) {
  if (!filePath || typeof filePath !== 'string') {
    return _json(res, { ok: false, message: 'ファイルパスが指定されていません' });
  }
  if (_jobRunning.import) {
    return _json(res, { ok: false, message: 'インポートは既に実行中です' });
  }
  if (!fs.existsSync(filePath)) {
    return _json(res, { ok: false, message: `ファイルが見つかりません: ${filePath}` });
  }

  _jobRunning.import = true;
  _lastResult.import = null;
  Object.assign(_progress, { job: 'import', page: 0, found: 0, total: 0, site: null, startedAt: Math.floor(Date.now() / 1000), done: false });

  _json(res, { ok: true, message: 'import started' });

  // 同期処理(CSVパース・SQLite書き込み)が長時間ブロックしうるため、
  // イベントループに戻す間を作りつつ setImmediate で開始する。
  setImmediate(() => {
    try {
      const onProgress = ({ processed, total, worksImported, priceRowsImported }) => {
        Object.assign(_progress, { found: processed, total });
        _sseSend('progress', { processed, total });
        _sseSend('log', `インポート中... ${processed}/${total}件（作品:${worksImported} / 価格記録:${priceRowsImported}）`);
      };

      const result = format === 'json' ? importData.importFromJson(filePath, { onProgress })
        : format === 'csv'             ? importData.importFromCsv(filePath, { onProgress })
        :                                 importData.importAuto(filePath, { onProgress });

      _lastResult.import = { ok: true, ...result, finishedAt: Date.now() };
      _sseSend('change', `インポート完了 — 作品:${result.works}件 / 価格記録:${result.priceRows}件` +
        (result.skippedNoRj || result.skippedNoChecked ? ` / スキップ: RJ不明${result.skippedNoRj}件・日時不明${result.skippedNoChecked}件` : ''));
      log.info('[api] import done', result);
    } catch (err) {
      log.error('[api] import error', err.message);
      _lastResult.import = { ok: false, error: err.message, finishedAt: Date.now() };
      _sseSend('error', `インポート失敗: ${err.message}`);
    } finally {
      _jobRunning.import = false;
      _progress.done = true;
    }
  });
}


// ── 機能追加③: リモートHEADとの乖離警告 ────────────────────────────────────────
// このexeがビルドされた時点のcommit sha(build-exe.ymlがビルド直前に
// crawler/buildInfo.jsonへ焼き込む)と、GitHub上の現在のmainブランチHEADを
// 比較する。並行して複数セッション/AIが作業しがちなこのプロジェクトでは
// 「古いビルドのコードを見ながら別の変更を加えてpushしてしまう」事故が
// 起こりうるため、ズレていればダッシュボードに警告を出す。
// 開発時(npm start、buildInfo.json無し)は静かにスキップする。
let _buildInfoCache; // undefined=未読込, null=ファイル無し(開発時)
function _loadBuildInfo() {
  if (_buildInfoCache !== undefined) return _buildInfoCache;
  try {
    const p = require('path').join(__dirname, 'buildInfo.json');
    _buildInfoCache = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    _buildInfoCache = null;
  }
  return _buildInfoCache;
}

const _VERSION_CHECK_CACHE_MS = 10 * 60 * 1000; // GitHub API負荷軽減のため10分キャッシュ
let _versionCheckCache = null, _versionCheckCacheAt = 0;

async function handleVersionCheck() {
  const buildInfo = _loadBuildInfo();
  if (!buildInfo?.sha) {
    return { checked: false, reason: 'buildInfo.json未検出（開発環境、または旧ビルド）' };
  }
  const now = Date.now();
  if (_versionCheckCache && now - _versionCheckCacheAt < _VERSION_CHECK_CACHE_MS) {
    return _versionCheckCache;
  }
  try {
    const owner = config.github?.owner, repo = config.github?.repo;
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/commits/main`, {
      headers: { Accept: 'application/vnd.github.v3+json', 'User-Agent': 'dlsite-price-tracker' },
    });
    if (!res.ok) {
      return { checked: false, reason: `GitHub API HTTP ${res.status}` };
    }
    const data = await res.json();
    const remoteSha = data.sha;
    const result = {
      checked:    true,
      localSha:   buildInfo.sha,
      remoteSha,
      builtAt:    buildInfo.builtAt ?? null,
      runNumber:  buildInfo.runNumber ?? null,
      upToDate:   remoteSha === buildInfo.sha,
      remoteMessage: (data.commit?.message ?? '').split('\n')[0].slice(0, 120),
      remoteDate: data.commit?.committer?.date ?? null,
    };
    _versionCheckCache = result;
    _versionCheckCacheAt = now;
    return result;
  } catch (e) {
    return { checked: false, reason: e.message };
  }
}

function handleRunStatus() {
  const elapsed = _progress.startedAt
    ? Math.floor(Date.now() / 1000) - _progress.startedAt : 0;
  // 機能追加(可視化): global._crawlerRunning / global._crawlerAbort は複数箇所
  // (apiServer.handleRun、scheduler.js の各cronジョブ、electron-main.js)から
  // Symbolトークンで所有権管理されており、過去に「ロック横取り」系のバグが
  // 繰り返し発生していた(all/turboが他ジョブのロックを誤って解放する等)。
  // 発生時に生ログを漁らなくても気づけるよう、現在のロック保有状況・
  // 所有者(Symbol.toString()で識別名のみ、実体は漏らさない)・中断フラグを
  // そのままAPIに出す。DB書き込み等の副作用は一切ない読み取り専用の可視化。
  const shared = global._crawlerRunning ?? {};
  const abort  = global._crawlerAbort ?? {};
  return {
    ..._jobRunning,
    progress:     { ..._progress, elapsed },
    lastResult:   _lastResult,
    recentErrors: log.getRecentErrors?.().slice(-10) ?? [],
    sseClients:   _sseClients.size,
    locks: {
      discovery:              !!shared.discovery,
      detail:                 !!shared.detail,
      saleBoost:              !!shared.saleBoost,
      compListing:            !!shared.compListing,
      compDetail:             !!shared.compDetail,
      schedulerDetailRunning: !!shared.schedulerDetailRunning,
      discoveryOwner:         shared._discoveryOwner ? String(shared._discoveryOwner) : null,
      detailOwner:            shared._detailOwner    ? String(shared._detailOwner)    : null,
    },
    abortFlags: {
      discovery: !!abort.discovery,
      detail:    !!abort.detail,
      comp:      !!abort.comp,
    },
  };
}

// ── 診断: RJコード生APIレスポンス確認（ドライラン、DB書き込みなし） ────────────
// point/point_rate調査のように「実際のDLsite APIフィールド名が推測でしか分からない」
// 状況を減らすため、指定RJコードの product/info/ajax 生JSONをそのまま返す。
// parser.jsのparseProductInfo等は一切通さず、DLsiteが返した生の値をそのまま見せる。
async function handleDiagRawRj(query) {
  const rjRaw = String(query.rj ?? '').trim().toUpperCase();
  if (!/^RJ\d{4,}$/.test(rjRaw)) {
    return { ok: false, message: 'RJコードの形式が不正です（例: RJ01234567）' };
  }
  const site = String(query.site ?? 'maniax').trim();
  const validSites = new Set(config.dlsite.validSiteIds ?? ['maniax', 'girls', 'home', 'bl', 'pro']);
  if (!validSites.has(site)) {
    return { ok: false, message: `不明なsite: ${site}（有効: ${[...validSites].join(', ')}）` };
  }

  const { fetchWithRetry } = require('./queue');
  const url = `https://www.dlsite.com/${site}/product/info/ajax?product_id%5B%5D=${encodeURIComponent(rjRaw)}`;
  const t0 = Date.now();
  try {
    const res  = await fetchWithRetry(url, { headers: { Accept: 'application/json, */*' } });
    const ms   = Date.now() - t0;
    const text = await res.text();
    let body = null, parseError = null;
    try { body = JSON.parse(text); } catch (e) { parseError = e.message; }
    return {
      ok: res.ok,
      url,
      status: res.status,
      ms,
      contentType: res.headers.get('content-type') ?? null,
      parseError,
      rawLength: text.length,
      body: body ?? text.slice(0, 2000),
      // レスポンスキー一覧（要求RJがそのまま返っているか、別バッチが混入していないか一目で分かる）
      returnedKeys: body ? Object.keys(body) : [],
    };
  } catch (e) {
    return { ok: false, message: e.message, url };
  }
}

const _dbPath = require('path').resolve(
  process.env.DLSITE_DATA_DIR || process.cwd(),
  config.db.path
);

// ─── GitHub トークン設定 (data-export push用) ─────────────────────────────────
// scripts/push-data-shards.js の _resolveToken() と全く同じパス解決ロジック。
// 設定画面から保存したトークンをそのままpushスクリプトが読めるようにするため、
// パスは1文字も違わず一致させる必要がある。
const _tokenPath = path.resolve(
  process.env.DLSITE_DATA_DIR || process.cwd(),
  '.github-token'
);

function handleSettingsGet() {
  let configured = false;
  let masked = null;
  try {
    const raw = fs.readFileSync(_tokenPath, 'utf8').trim().split('\n')[0];
    if (raw) {
      configured = true;
      masked = raw.length > 8 ? raw.slice(0, 4) + '…' + raw.slice(-4) : '••••••';
    }
  } catch { /* ファイルなし = 未設定 */ }
  return {
    githubTokenConfigured: configured,
    githubTokenMasked:     masked,
    tokenPath:             _tokenPath,
    dataBranch:            config.github?.dataBranch ?? 'data',
    repo:                  `${config.github?.owner ?? '?'}/${config.github?.repo ?? '?'}`,
  };
}

function handleSettingsSaveToken(body) {
  const token = String(body?.token ?? '').trim();
  if (!token) return { ok: false, message: 'トークンが空です' };
  // ゆるいフォーマットチェック（ghp_/gho_/github_pat_ 等）。一致しなくても保存はする
  // （GitHub側でトークン種別が増減しても弾かないようにするため、警告のみ）。
  const looksValid = /^gh[a-z]*_[A-Za-z0-9_]{20,}$/.test(token) || /^github_pat_[A-Za-z0-9_]{20,}$/.test(token);
  if (!looksValid) log.warn('[api] settings: token format looks unusual, saving anyway');
  try {
    fs.writeFileSync(_tokenPath, token + '\n', { mode: 0o600 });
    log.info('[api] settings: github token saved to', _tokenPath);
    return { ok: true, formatWarning: !looksValid };
  } catch (e) {
    log.error('[api] settings: token save failed', e.message);
    return { ok: false, message: e.message };
  }
}

function handleSettingsDeleteToken() {
  try {
    fs.unlinkSync(_tokenPath);
    log.info('[api] settings: github token deleted');
    return { ok: true };
  } catch (e) {
    if (e.code === 'ENOENT') return { ok: true };
    log.error('[api] settings: token delete failed', e.message);
    return { ok: false, message: e.message };
  }
}

// バグ回避策(メモリの既知の落とし穴): 「直したのに直ってない」の実態が
// 古いビルドのexeを使い続けていたケースだった、という混乱を繰り返し招いていた。
// ダッシュボード側で表示できるよう、package.jsonのversionとこのプロセスの
// 起動時刻を毎回計算せず一度だけ読む。
let _appVersion = null;
try { _appVersion = require('../package.json').version; } catch { /* ignore */ }
const _processStartedAt = new Date().toISOString();

function handleStats() {
  const stats = db.getStats();
  stats.dbPath = _dbPath;
  stats.appVersion = _appVersion;
  stats.processStartedAt = _processStartedAt;
  return stats;
}
function handleSales()         { return db.getSaleWorks(200); }
function handlePriceIssues()   { return { issues: db.getPriceIssues({ limit: 500 }), total: db.getPriceIssuesCount() }; }

// ── デバッグ用スナップショット ──────────────────────────────────────────────
// 異常APIレスポンス(空応答/severely-partial/CDN汚染/非200)の直近サンプルを
// そのまま返す。原因調査時にログの要約情報だけでなく生ヘッダー/本文サンプルを
// 直接見られるようにする(crawler/apiTrace.js参照)。
function handleApiTrace() { return apiTrace.getAll(); }

// warmUpSession()の直近30回分の要約履歴。周期的なセッション切れなのか単発の
// 不調なのかを時系列で判別できるようにする(crawler/warmUpHistory.js参照)。
function handleWarmUpHistory() {
  try {
    return require('./warmUpHistory').getAll();
  } catch (e) {
    return { error: e.message };
  }
}

// ロック/中断フラグの現在値を即座にダンプする。ロック横取り・解放漏れ系の
// 不具合(本プロジェクトで過去に複数回発生)を調査する際、ログの前後関係から
// 推測するのではなく現在の実際の状態を直接確認できるようにする。
function handleDebugLocks() {
  const running = global._crawlerRunning || {};
  return {
    timestamp: new Date().toISOString(),
    jobRunning: { ..._jobRunning },
    crawlerRunning: {
      discovery: !!running.discovery,
      detail: !!running.detail,
      saleBoost: !!running.saleBoost,
      compListing: !!running.compListing,
      compDetail: !!running.compDetail,
      schedulerDetailRunning: !!running.schedulerDetailRunning,
      _detailOwner: running._detailOwner ? String(running._detailOwner) : null,
      _discoveryOwner: running._discoveryOwner ? String(running._discoveryOwner) : null,
    },
    crawlerAbort: { ...(global._crawlerAbort || {}) },
    abortSignals: getAllAbortStates(),
  };
}
function handleCompStats()     { return db.getCompStats(); }
function handleCompPending(query) {
  const status = query.status ?? 'pending';
  const limit  = Math.min(500, parseInt(query.limit ?? '100', 10) || 100);
  return { pending: db.getCompPending({ status, limit }) };
}
function handleCompDecide({ compilationRj, containedRj, decision }) {
  if (!compilationRj || !containedRj) return { ok: false, message: 'compilationRj/containedRjが必要です' };
  if (decision !== 'approved' && decision !== 'rejected') return { ok: false, message: 'decisionはapproved/rejectedのいずれかです' };
  db.decideCompPending(compilationRj, containedRj, decision);
  return { ok: true };
}
function handleExportJson()    { return db.exportAllHistory(); }

function handleWorks(query) {
  const page   = Math.max(1, parseInt(query.page ?? '1', 10));
  const q      = (query.q ?? '').trim();
  const sort   = query.sort ?? 'priority';
  const onSale = query.onSale === '1';
  return db.searchWorks({ q, sort, onSale, page });
}

function handleHistory(rjCode) {
  return { work: db.getWorkByRj(rjCode) ?? null, history: db.getPriceHistory(rjCode) };
}

function handleExportCsv() {
  const data   = db.exportAllHistory();
  const header = 'rj_code,title,circle,price,sale_price,discount_rate,point,checked_at\n';
  const rows   = data.map(r => [
    r.rj_code,
    _csvEscape(r.title),
    _csvEscape(r.circle),
    r.price         ?? '',
    r.sale_price    ?? '',
    r.discount_rate ?? '',
    r.point         ?? '',
    r.checked_at ? new Date(r.checked_at * 1000).toISOString() : '',
  ].join(','));
  return header + rows.join('\n');
}

// ─── HTTP サーバー ────────────────────────────────────────────────────────────

function createServer() {
  const server = http.createServer(async (req, res) => {
    const parsed   = url.parse(req.url ?? '/', true);
    const pathname = parsed.pathname ?? '/';
    const query    = parsed.query ?? {};

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    log.debug('[api]', req.method, pathname);

    try {
      if (pathname === '/' || pathname === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(_getDashboardHtml());
        return;
      }

      if (pathname === '/api/stats')  return _json(res, handleStats());
      if (pathname === '/api/works')  return _json(res, handleWorks(query));
      if (pathname === '/api/sales')  return _json(res, handleSales());
      if (pathname === '/api/price-issues') return _json(res, handlePriceIssues());
      if (pathname === '/api/comp/stats')   return _json(res, handleCompStats());
      if (pathname === '/api/comp/pending') return _json(res, handleCompPending(query));

      if (pathname === '/api/comp/decide' && req.method === 'POST') {
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', () => {
          let parsed = {};
          try { parsed = JSON.parse(body); } catch { /* keep {} */ }
          _json(res, handleCompDecide(parsed));
        });
        return;
      }


      const histMatch = pathname.match(/^\/api\/history\/(.+)$/);
      if (histMatch) return _json(res, handleHistory(histMatch[1].toUpperCase()));

      if (pathname === '/api/run/status') return _json(res, handleRunStatus());

      if (pathname === '/api/diag/raw') return _json(res, await handleDiagRawRj(query));

      if (pathname === '/api/version-check') return _json(res, await handleVersionCheck());

      if (pathname === '/api/settings' && req.method === 'GET') {
        return _json(res, handleSettingsGet());
      }

      if (pathname === '/api/settings/github-token' && req.method === 'POST') {
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', () => {
          let parsed = {};
          try { parsed = JSON.parse(body); } catch { /* keep {} */ }
          _json(res, handleSettingsSaveToken(parsed));
        });
        return;
      }

      if (pathname === '/api/settings/github-token' && req.method === 'DELETE') {
        return _json(res, handleSettingsDeleteToken());
      }

      if (pathname === '/api/import' && req.method === 'POST') {
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', () => {
          let parsed = {};
          try { parsed = JSON.parse(body); } catch { /* keep {} */ }
          handleImport(parsed, res);
        });
        return;
      }

      const runMatch = pathname.match(/^\/api\/run\/(discover|fetch|saleboost|all|fullscan|fullscan_sale|turbo|endingsoon|circlegap|pushdata|newrelease|comp_listing|comp_detail|pushdebug)$/);
      if (runMatch) {
        if (req.method !== 'POST') { res.writeHead(405); res.end('POST only'); return; }
        handleRun(runMatch[1], res);
        return;
      }

      // 実行中のジョブを中止する。各ジョブは shouldContinue()/isAborted() フックが
      // 次のページ/バッチに進む前にこのフラグを確認し、安全なタイミングで打ち切る
      // （listing系はページ位置・due件数が保存済みなので次回続きから再開できる）。
      const stopMatch = pathname.match(/^\/api\/stop\/(discover|fetch|saleboost|all|fullscan|fullscan_sale|turbo|endingsoon|circlegap|pushdata|newrelease|comp_listing|comp_detail)$/);
      if (stopMatch) {
        if (req.method !== 'POST') { res.writeHead(405); res.end('POST only'); return; }
        handleStop(stopMatch[1], res);
        return;
      }

      if (pathname === '/api/log-stream') {
        res.writeHead(200, {
          'Content-Type':      'text/event-stream; charset=utf-8',
          'Cache-Control':     'no-cache',
          'Connection':        'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        res.write('retry: 3000\n\n');
        res.write('event: log\ndata: SSE connected\n\n');
        _sseClients.add(res);
        req.on('close', () => _sseClients.delete(res));
        return;
      }

      if (pathname === '/api/log') {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        try {
          const content = _readTail(log.getLogPath(), 2 * 1024 * 1024);
          res.end(content.split('\n').slice(-200).join('\n'));
        } catch (e) {
          res.end('(ログファイルなし: ' + e.message + ')');
        }
        return;
      }

      if (pathname === '/api/errorlog') {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        try {
          const content = _readTail(log.getErrorLogPath(), 2 * 1024 * 1024);
          res.end(content.split('\n').slice(-300).join('\n'));
        } catch (e) {
          res.end('(エラーログなし: ' + e.message + ')');
        }
        return;
      }

      if (pathname === '/api/digest') {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        try {
          const limit   = Math.min(2000, Math.max(1, parseInt(query.limit ?? '300', 10) || 300));
          const content = _readTail(log.getDigestLogPath(), 2 * 1024 * 1024);
          res.end(content.split('\n').filter(Boolean).slice(-limit).join('\n'));
        } catch (e) {
          res.end('(digestログなし: ' + e.message + ')');
        }
        return;
      }

      if (pathname === '/api/events') return _json(res, handleEvents(query));

      // 進捗パネルなどクライアント側エラーをサーバーのエラーログに記録
      if (pathname === '/api/client-error' && req.method === 'POST') {
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', () => {
          try {
            const { message, source } = JSON.parse(body);
            // SSE経由ではなくファイルに直接書き込む（フィードバックループ防止）
            const line = `${new Date().toISOString()} [ERROR] [client:${source ?? 'ui'}] ${String(message).slice(0, 300)}\n`;
            const errPath = log.getErrorLogPath();
            if (errPath) {
              require('fs').appendFile(errPath, line, () => {});
            }
          } catch {}
          res.writeHead(204); res.end();
        });
        return;
      }

      if (pathname === '/api/export/json') {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Content-Disposition': 'attachment; filename="dlsite-history.json"',
        });
        res.end(JSON.stringify(handleExportJson(), null, 2));
        return;
      }

      if (pathname === '/api/export/csv') {
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8-sig',
          'Content-Disposition': 'attachment; filename="dlsite-history.csv"',
        });
        res.end('\uFEFF' + handleExportCsv());
        return;
      }

      // ── デバッグスナップショット ──────────────────────────────────────────
      if (pathname === '/api/debug/api-trace') return _json(res, handleApiTrace());
      if (pathname === '/api/debug/locks')     return _json(res, handleDebugLocks());
      if (pathname === '/api/debug/warmup-history') return _json(res, handleWarmUpHistory());

      // ── 診断 ──────────────────────────────────────────────────────────────
      if (pathname === '/api/diagnostics') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        const result = await _runDiagnostics();
        res.end(JSON.stringify(result));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));

    } catch (err) {
      log.error('[api] error', pathname, err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });

  return server;
}

function start() {
  const { port, host } = config.ui;
  const server = createServer();
  server.listen(port, host, () => {
    log.info(`[api] dashboard → http://${host}:${port}`);
  });
  server.on('error', err => {
    if (err.code === 'EADDRINUSE') log.error(`[api] port ${port} in use – UI disabled`);
    else log.error('[api] server error', err.message);
  });
  return server;
}

// ─── ヘルパー ─────────────────────────────────────────────────────────────────

function _json(res, data) {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

// ファイル全体を読まず、末尾 maxBytes 分だけを読む。
// logger.js 側でサイズ上限つきローテーションを行っているため通常は不要だが、
// 万一ローテーションが効かなかった場合の二重の安全策として、ここでも
// fs.readFileSync(path,'utf8') によるファイル全体読み込み（V8の文字列長上限
// 0x1fffffe8 ≈ 512MB超で例外になる）を避ける。
function _readTail(filePath, maxBytes = 2 * 1024 * 1024) {
  const stat  = fs.statSync(filePath);
  const start = Math.max(0, stat.size - maxBytes);
  const len   = stat.size - start;
  const fd    = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(len);
    if (len > 0) fs.readSync(fd, buf, 0, len, start);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

// events.jsonl の末尾を読み、level/job/キーワードでフィルタして新しい順に返す。
// ダッシュボードの「イベント検索」機能から使う。1行JSONが壊れている場合は無視する
// （ローテーション境界で末尾が途中で切れているケースなどを想定）。
function handleEvents(query) {
  const level = (query.level ?? '').toLowerCase();
  const job   = query.job ?? '';
  const q     = (query.q ?? '').toLowerCase();
  const limit = Math.min(1000, Math.max(1, parseInt(query.limit ?? '200', 10) || 200));

  let events = [];
  try {
    const content = _readTail(log.getEventsLogPath(), 4 * 1024 * 1024);
    events = content.split('\n').filter(Boolean).map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }

  if (level) events = events.filter(e => e.level === level);
  if (job)   events = events.filter(e => e.job === job);
  if (q)     events = events.filter(e => JSON.stringify(e).toLowerCase().includes(q));

  events.reverse(); // 新しい順
  return events.slice(0, limit);
}

function _csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  return s.includes(',') || s.includes('"') || s.includes('\n')
    ? `"${s.replace(/"/g, '""')}"` : s;
}

async function _runDiagnostics() {
  const { fetchWithRetry } = require('./queue');
  const parser = require('./parser');
  const pathM  = require('path');

  const dbPath  = _dbPath;
  const backDir = pathM.resolve(pathM.dirname(dbPath), 'backups');

  const result = {
    timestamp:  new Date().toISOString(),
    dbStats:    db.getStats(),
    dbPath,
    backupDir:  backDir,
    logPath:    log.getLogPath(),
    errorLogPath: log.getErrorLogPath?.() ?? null,
    isElectron: process.type === 'browser',
    warmUpHistory: handleWarmUpHistory(),
    tests: [],
  };

  // テスト0: 年齢確認Cookieの現状確認
  // バグ修正の経緯: これまで「product/info/ajaxが0件を返す」原因がセッション切れ
  // (年齢確認Cookie未取得)なのか別要因なのかを切り分けるには、dlsite-tracker.log
  // 内の[warmUp]ログを手動で探す必要があり、診断ボタン1つで完結しなかった。
  // ここでCookie保有状況を直接確認し、無ければその場でwarmUp再実行を試みてから
  // 以降のAPIテストに進む(=診断ボタンが「現状確認」だけでなく「その場で自己修復」
  // も兼ねるようにする)。
  try {
    const { session } = require('electron');
    const before = await session.defaultSession.cookies.get({ domain: 'dlsite.com' });
    const hasAgeCookieBefore = before.some(c => /adult|age/i.test(c.name));
    const cookieTest = {
      name: '年齢確認Cookie保有状況',
      ok: hasAgeCookieBefore,
      cookiesBefore: before.map(c => c.name),
    };
    if (!hasAgeCookieBefore && typeof global._reWarmUpSession === 'function') {
      cookieTest.note = 'Cookie未検出のためセッション再確立を試みます...';
      try {
        await global._reWarmUpSession('diagnostic');
        const after = await session.defaultSession.cookies.get({ domain: 'dlsite.com' });
        const hasAgeCookieAfter = after.some(c => /adult|age/i.test(c.name));
        cookieTest.rewarmAttempted = true;
        cookieTest.ok = hasAgeCookieAfter;
        cookieTest.cookiesAfter = after.map(c => c.name);
        cookieTest.note = hasAgeCookieAfter
          ? 'セッション再確立に成功しました'
          : 'セッション再確立を試みましたが、年齢確認Cookieを取得できませんでした（DLsite側のページ構造変更の可能性）';
      } catch (e) {
        cookieTest.rewarmAttempted = true;
        cookieTest.error = 're-warmup failed: ' + e.message;
      }
    }
    result.tests.push(cookieTest);
  } catch (e) {
    result.tests.push({ name: '年齢確認Cookie保有状況', ok: null, error: e.message });
  }

  // テスト0.5: warmUp時に実際に開いたページの中身(タイトル/本文抜粋/リンク文言)
  // バグ修正の経緯: 「年齢確認ゲートのセレクタが古い」のか「地域ブロック等で
  // そもそも別のページが返っている」のかは、実際のページ内容を見ないと
  // 判別できない。electron-main.js の warmUpSession() がサイトごとに
  // global._lastWarmUpDiag へ記録するようになったので、それをそのまま
  // 診断パネルに出す(ログファイルを探しに行かせない)。
  if (global._lastWarmUpDiag?.results) {
    for (const [site, r] of Object.entries(global._lastWarmUpDiag.results)) {
      const d = r.diag;
      const ci = d?.clickedInfo;
      // バグ修正: clicked===false を無条件に失敗(❌)扱いしていたが、
      // これは「クリックできなかった」であって「セッションが壊れている」の
      // 直接証拠ではない。cookieObtained===true (=実際に年齢確認Cookieを
      // 保有している)なら、そもそもゲートが表示されずクリック不要だった
      // だけの正常ケースである可能性が高い(実際に確認待ち0件までクロールが
      // 進み、cookieObtained:trueが確認できた状態でもclicked:falseになる
      // ケースが多数観測された)。cookieObtainedを最優先の判定材料にする。
      const ok = r.cookieObtained === true ? true
               : r.cookieObtained === false ? false
               : (r.clicked === true ? true : (r.clicked === false ? false : null));
      result.tests.push({
        name: `warmUp実行内容 [${site}]`,
        ok,
        note: `対象URL: ${r.targetUrl ?? '(不明)'}${r.rjUsed ? ' (RJ: ' + r.rjUsed + ')' : ''} / clicked=${r.clicked} / cookieObtained=${r.cookieObtained} / reason=${r.reason}`
          + (r.cookieObtained === true && r.clicked === false ? '\n  ※クリック不要でした（既に年齢確認Cookieを保有しているため、ゲート自体が表示されなかったと考えられます）' : '')
          // バグ修正: 地域ブロックページを「ゲート不在(正常)」と誤解しないよう、
          // electron-main.js側で検出したregionBlockedフラグをここでも明示する。
          + (r.regionBlocked ? '\n  ⚠ 地域制限/アクセス不能ページの疑いを検出しています（年齢確認ゲートが無いのではなく、そもそも通常ページが返っていない可能性）' : '')
          + (ci ? `\n  ★実際にクリックした要素: <${ci.tag}> "${ci.text}" (${ci.via}) href=${ci.href ?? '(なし)'}` : '')
          + (d?.title != null ? `\n  ページタイトル: ${d.title}`  : '')
          + (d?.url   != null ? `\n  実際のURL: ${d.url}` : '')
          + (d?.bodyTextSample ? `\n  本文抜粋: ${d.bodyTextSample}` : '')
          + (d?.anchorTextsSample?.length ? `\n  リンク文言: ${d.anchorTextsSample.join(' / ')}` : '')
          + (d?.error ? `\n  取得エラー: ${d.error}` : ''),
      });
    }
  } else {
    result.tests.push({ name: 'warmUp実行内容', ok: null, note: 'まだ記録がありません（上のCookieテストで再ウォームアップが走らなかった場合など）' });
  }

  // テスト0.6: warmUp履歴の傾向分析（result.warmUpHistory = crawler/warmUpHistory.js
  // が保持する生の履歴データに対して、サイトごとの成功率・直近失敗時刻を
  // 集計したサマリを追加する。生データ(result.warmUpHistory)はプログラムから
  // そのまま扱えるが、一覧性のある「今どういう傾向か」はここで一目で分かる
  // ようにする。
  if (result.warmUpHistory?.length) {
    const hist = result.warmUpHistory; // { ts, trigger, allOk, results } の配列
    const perSite = {};
    for (const entry of hist) {
      for (const [site, r] of Object.entries(entry.results ?? {})) {
        const s = (perSite[site] ??= { total: 0, ok: 0, lastFailAt: null, lastRegionBlockAt: null });
        s.total++;
        if (r.cookieObtained) s.ok++;
        else s.lastFailAt = entry.ts;
        if (r.regionBlocked) s.lastRegionBlockAt = entry.ts;
      }
    }
    const lines = Object.entries(perSite).map(([site, s]) =>
      `${site}: ${s.ok}/${s.total}回成功` +
      (s.lastFailAt ? ` / 直近の失敗: ${s.lastFailAt}` : '') +
      (s.lastRegionBlockAt ? ` / ⚠地域ブロック検出: ${s.lastRegionBlockAt}` : '')
    );
    const anyRepeatFail = Object.values(perSite).some(s => s.total >= 3 && s.ok / s.total < 0.5);
    result.tests.push({
      name: `warmUp履歴の傾向（直近${hist.length}回、プロセス起動以降。生データは result.warmUpHistory）`,
      ok: anyRepeatFail ? false : null,
      note: lines.join('\n') +
        (anyRepeatFail ? '\n⚠ 特定サイトで失敗率が高く周期的な傾向があります。DLsite側のページ構造変更を疑ってください。'
                       : ''),
    });
  }

  // テスト1: DLsite新着ページ取得（page=1はURLに /page/1 を含まない）
  // バグ修正: 応答時間27ms・バイト数が実行のたびに完全一致という不自然な
  // 結果が続いていた(962,717 bytes固定)。これは962KBのページが物理的に
  // ありえない速度で返っていることを意味し、electron.net.fetch側のHTTP
  // キャッシュ(または経路上のCDNキャッシュ)が「現在のセッション状態」ではなく
  // 古いレスポンスをそのまま返している可能性が高い。診断の信頼性を担保する
  // ため、キャッシュキーに影響するクエリパラメータでキャッシュバスティングする。
  const testUrl = 'https://www.dlsite.com/maniax/new/=/per_page/30.html?_diag=' + Date.now();
  try {
    const t0   = Date.now();
    const res  = await fetchWithRetry(testUrl);
    const ms   = Date.now() - t0;
    const html = await res.text();
    const items = parser.parseWorkListWithPrice(html);
    result.tests.push({
      name:     '新着ページ取得',
      url:      testUrl,
      status:   res.status,
      ok:       res.ok && items.length > 0,
      ms,
      parsed:   items.length,
      htmlLen:  html.length,
      cfBlock:  html.includes('cf-browser-verification') || html.includes('Checking your browser'),
      ageCheck: html.includes('adultcheck') || html.includes('agecheck'),
    });
  } catch (e) {
    result.tests.push({ name: '新着ページ取得', url: testUrl, ok: false, error: e.message });
  }

  // テスト2: Product Info API（product_id[] 形式）
  // バグ修正: 以前はサンプルRJの実際のsite_idを見ず、URLを 'maniax' に固定していた。
  // product/info/ajax はサイトファミリー(maniax/girls/bl等)ごとにパスが異なるため、
  // サンプルがmaniax以外の作品だと正常に動いていてもAPIキー数0件(=偽陽性)になる。
  // サンプルを実際のsite_idごとにグループ化し、サイトごとに正しいURLでテストする。
  //
  // バグ修正: sort:'priority' の上位12件をそのまま使っていたため、恒久的に
  // 削除/存在しなくなった作品(consecutive_errorsが積み上がっているのに
  // priority=100等のまま張り付いているもの、recordFetchErrorのpriority減衰が
  // 効くまでの間)が毎回同じサンプルとして選ばれ続け、「セッションが壊れている」
  // ように見える偽陽性を引き起こしていた(実際は数件の削除済み作品固有の問題で、
  // 全体のクロールは正常に進行していた)。母集団を広めに取り、
  // consecutive_errors が高い(=繰り返し失敗が確定している)作品を除外してから
  // サンプリングすることで、診断結果が全体の健全性をより正しく反映するようにする。
  let sampleWorks = [];
  try {
    const rows = db.searchWorks({ q: '', sort: 'priority', page: 1, limit: 60 });
    sampleWorks = (rows.works ?? []).filter(w => (w.consecutive_errors ?? 0) < 3).slice(0, 12);
    if (sampleWorks.length === 0) {
      // 全滅(=上位60件が軒並みエラー持ち)の場合は健全性シグナルとしてそのまま使う
      sampleWorks = (rows.works ?? []).slice(0, 12);
    }
  } catch (e) {
    log.warn('[diag] failed to get sample works:', e.message);
  }

  const validSites = new Set(config.dlsite.validSiteIds ?? ['maniax', 'girls', 'home', 'bl', 'pro']);
  const bySite = new Map();   // site_id -> [rj_code, ...]（最大3件/サイト）
  for (const w of sampleWorks) {
    if (!w.rj_code || !validSites.has(w.site_id)) continue;
    const list = bySite.get(w.site_id) ?? [];
    if (list.length < 3) list.push(w.rj_code);
    bySite.set(w.site_id, list);
  }

  if (bySite.size) {
    for (const [site, codes] of bySite) {
      const params = codes.map(c => 'product_id%5B%5D=' + encodeURIComponent(c)).join('&');
      // detailFetcher.js側と同様、CDNキャッシュ許可パラメータは付けない
      const apiUrl = `https://www.dlsite.com/${site}/product/info/ajax?${params}`;
      try {
        const t0   = Date.now();
        // バグ修正: detailFetcher.js の実際に動いている _apiFetch() は
        // `Accept: application/json, */*` ヘッダーを付けてリクエストしているが、
        // この診断ツールはヘッダーなし(queue.jsのデフォルトはHTML向けAccept)で
        // 叩いていたため、DLsite側がAjax APIとして扱わず年齢確認等のHTMLページ
        // (またはそれに類する応答)を返していた可能性が高い。res.json()が失敗して
        // catchで{}になり、HTTPステータスは200のまま「APIキー数0件」という
        // 偽陽性が生じていた。detailFetcher.jsと同じヘッダーを付けて揃える。
        const res  = await fetchWithRetry(apiUrl, {
          headers: { Accept: 'application/json, */*' },
        });
        const ms   = Date.now() - t0;
        const contentType = res.headers.get('content-type') ?? '';
        const body = await res.json().catch(() => ({}));
        result.tests.push({
          name:         `Product Info API [${site}]`,
          url:          apiUrl,
          status:       res.status,
          contentType,
          ok:           res.ok && Object.keys(body).length > 0,
          ms,
          returnedKeys: Object.keys(body).length,
          testedCodes:  codes,
        });
      } catch (e) {
        result.tests.push({ name: `Product Info API [${site}]`, url: apiUrl, ok: false, error: e.message });
      }
    }
  } else {
    result.tests.push({ name: 'Product Info API', ok: null, note: 'DB内に有効なsite_idを持つ作品なし (discovery未実施 or site_id要修正)' });
  }

  return result;
}

// ─── ダッシュボード HTML ───────────────────────────────────────────────────────

let _dashboardHtmlCache = null;

function _getDashboardHtml() {
  if (_dashboardHtmlCache) return _dashboardHtmlCache;
  const candidates = [
    // ポータブルexe: exeの隣のresourcesフォルダ
    process.resourcesPath && require('path').join(process.resourcesPath, 'public', 'index.html'),
    // 開発時
    require('path').join(__dirname, '..', 'server', 'public', 'index.html'),
  ].filter(Boolean);

  for (const p of candidates) {
    try {
      _dashboardHtmlCache = fs.readFileSync(p, 'utf8');
      log.info('[api] dashboard loaded from', p);
      return _dashboardHtmlCache;
    } catch {}
  }
  log.error('[api] index.html not found, tried:', candidates);
  return '<h1>index.html not found</h1>';
}

module.exports = { start, createServer };
