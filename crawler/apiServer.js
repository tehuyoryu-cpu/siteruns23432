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
  import: false, comp_listing: false, comp_detail: false,
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

function handleStop(job, res) {
  const abortFlag = _ABORT_FLAG_BY_JOB[job];
  if (!abortFlag) {
    return _json(res, { ok: false, message: (_JOB_LABELS[job] ?? job) + 'は短時間で完了するため停止操作は不要です' });
  }
  const schedKey = _SCHEDULER_RUNNING_KEY_BY_JOB[job];
  const busy = _jobRunning[job] || (schedKey && !!global._crawlerRunning?.[schedKey]);
  if (!busy) {
    return _json(res, { ok: false, message: '実行中の' + (_JOB_LABELS[job] ?? job) + 'はありません' });
  }
  if (!global._crawlerAbort) global._crawlerAbort = {};
  global._crawlerAbort[abortFlag] = true;
  log.info('[api] stop requested for', job, '(abort flag:', abortFlag + ')');
  return _json(res, { ok: true, message: (_JOB_LABELS[job] ?? job) + 'の停止を要求しました' });
}

// ─── ジョブ実行 ──────────────────────────────────────────────────────────────

async function handleRun(job, res) {
  // schedulerと共有フラグを確認（schedulerが実行中なら HTTP API からも起動しない）
  if (!global._crawlerRunning) global._crawlerRunning = {};
  const shared     = global._crawlerRunning;
  const sharedKeys = { discover: 'discovery', fetch: 'detail', turbo: 'detail', comp_listing: 'compListing', comp_detail: 'compDetail' };
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
  const _abortFlagForThisJob = _ABORT_FLAG_BY_JOB[job];
  if (_abortFlagForThisJob) {
    if (!global._crawlerAbort) global._crawlerAbort = {};
    global._crawlerAbort[_abortFlagForThisJob] = false;
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

  _json(res, { ok: true, message: `${job} started` });

  try {
    if (job === 'discover') {
      Object.assign(_progress, { job, page: 0, found: 0, site: 'maniax', startedAt: Math.floor(Date.now() / 1000), done: false });
      const r = await runDiscovery();
      _lastResult[job] = { ok: true, discovered: r?.discovered ?? 0, finishedAt: Date.now() };
      _sseSend('log', `discovery完了 — 新規: ${r?.discovered ?? 0}件`);

    } else if (job === 'fetch') {
      const startedAt = Math.floor(Date.now() / 1000);
      Object.assign(_progress, { job, page: 0, found: 0, total: 0, site: null, startedAt, done: false });
      const r = await detailFetcher.runDetailFetch(300, {
        onProgress: ({ processed, priceChanges, total }) => {
          Object.assign(_progress, { found: processed, total });
          _sseSend('progress', { processed, priceChanges, total });
          if (priceChanges > 0) _sseSend('change', `価格変動: ${priceChanges}件`);
        },
      });
      _lastResult[job] = { ok: true, ...r, finishedAt: Date.now() };
      _sseSend(r?.priceChanges > 0 ? 'change' : 'log',
        `価格更新完了 — 処理:${r?.processed ?? 0}件 変動:${r?.priceChanges ?? 0}件`);
      if (r?.priceChanges > 0 && global._notifyPriceChange) {
        global._notifyPriceChange(r.priceChanges);
      }

    } else if (job === 'saleboost') {
      const circles = db.getCirclesOnSale();
      db.transaction(() => {
        for (const { maker_id } of circles) db.boostCircleWorks(maker_id, 100, 7200);
      });
      db.syncCircleWorksCounts();
      log.info('[api] saleboost done, circles:', circles.length);

    } else if (job === 'all') {
      Object.assign(_progress, { job, page: 0, found: 0, total: 0, site: null, startedAt: Math.floor(Date.now() / 1000), done: false });

      // ── Phase 0: 実行中の価格更新を中断して detail ロックを取得 ──
      if (shared['detail']) {
        if (!global._crawlerAbort) global._crawlerAbort = {};
        global._crawlerAbort.detail = true;
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
      const origRL_all          = config.fetch.rateLimit;
      const origConcurrency_all = config.fetch.concurrency;
      config.fetch.rateLimit    = 200;
      config.fetch.concurrency  = Math.max(origConcurrency_all ?? 1, 6);
      let fetchR;
      try {
        fetchR = await detailFetcher.runDetailFetch(Infinity, {
          onProgress: ({ processed, priceChanges, total }) => {
            Object.assign(_progress, { found: processed, total });
            _sseSend('progress', { processed, priceChanges, total });
            if (priceChanges > 0) _sseSend('change', `価格変動: ${priceChanges}件`);
          },
        });
      } finally {
        config.fetch.rateLimit   = origRL_all;
        config.fetch.concurrency = origConcurrency_all;
      }
      // Phase 2 完了。detail ロックの解放は finally の releaseDetail()（トークン一致チェックあり）に任せる。
      // ここで直接 shared['detail'] = false をしていた旧コードはトークン保護を素通りするバグがあった。

      // ── Phase 3: セールブースト ──
      const circles = db.getCirclesOnSale();
      db.transaction(() => {
        for (const { maker_id } of circles) db.boostCircleWorks(maker_id, 100, 7200);
      });

      const summary = `新規:${discR.discovered}件 / 価格更新:${fetchR?.processed ?? 0}件 / 変動:${fetchR?.priceChanges ?? 0}件 / エラー:${fetchR?.errors ?? 0}件`;
      _lastResult[job] = { ok: true, discovered: discR.discovered, ...fetchR, finishedAt: Date.now() };
      _sseSend(fetchR?.priceChanges > 0 ? 'change' : 'log', `全て巡回完了 — ${summary}`);
      // バックグラウンド通知（価格変動時）
      if (fetchR?.priceChanges > 0 && global._notifyPriceChange) {
        global._notifyPriceChange(fetchR.priceChanges);
      }

    } else if (job === 'turbo') {
      // ぶっ飛ばしモード: rateLimit 最小・全 due 作品を処理
      if (shared['detail']) {
        if (!global._crawlerAbort) global._crawlerAbort = {};
        global._crawlerAbort.detail = true;
        _sseSend('log', '価格更新を中断してぶっ飛ばし開始...');
        const abortStart = Date.now();
        await new Promise(resolve => {
          const t = setInterval(() => {
            if (!shared['detail'] || Date.now() - abortStart > 15_000) {
              clearInterval(t); resolve();
            }
          }, 150);
        });
        global._crawlerAbort.detail = false;
      }
      shared['detail'] = true;
      myDetailToken = Symbol('api-turbo');
      shared._detailOwner = myDetailToken;
      _sseSend('log', '🚀 ぶっ飛ばしモード開始 — 全due作品を高速並列処理します');
      Object.assign(_progress, { job, found: 0, total: 0, startedAt: Math.floor(Date.now() / 1000), done: false });
      // rateLimit縮小だけでなく concurrency(同時並列リクエスト数) も引き上げる。
      // 以前は concurrency 設定が定義されているのに使われておらず、'turbo' でも
      // 実質ほぼ逐次処理のままで体感速度がほとんど変わらないバグがあった。
      const origRL          = config.fetch.rateLimit;
      const origConcurrency = config.fetch.concurrency;
      config.fetch.rateLimit    = 200;
      config.fetch.concurrency  = Math.max(origConcurrency ?? 1, 6);
      try {
        // バグ修正: 99999 は「実質無制限」のつもりの値だったが、実装上は
        // ハードキャップとして扱われるため、due作品数がこれを超えると
        // 残りが未処理のまま打ち切られていた（カタログ増加で顕在化）。
        // Infinity にすることで、真に due が枯渇するまで処理を続ける。
        const r = await detailFetcher.runDetailFetch(Infinity, {
          onProgress: ({ processed, priceChanges, total }) => {
            Object.assign(_progress, { found: processed, total });
            _sseSend('progress', { processed, priceChanges, total });
            if (priceChanges > 0) _sseSend('change', `価格変動: ${priceChanges}件`);
          },
        });
        _lastResult[job] = { ok: true, ...r, finishedAt: Date.now() };
        const msg = `ぶっ飛ばし完了 — 処理:${r?.processed ?? 0}件 変動:${r?.priceChanges ?? 0}件`;
        _sseSend(r?.priceChanges > 0 ? 'change' : 'log', msg);
        if (r?.priceChanges > 0 && global._notifyPriceChange) global._notifyPriceChange(r.priceChanges);
      } finally {
        config.fetch.rateLimit   = origRL;
        config.fetch.concurrency = origConcurrency;
      }

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
      _sseSend(result.totalMissing > 0 ? 'change' : 'log',
        (stopped ? 'サークル欠落診断を停止しました — ' : 'サークル欠落診断完了 — ') + gapSummary +
        (stopped ? '（続きは次回実行時に再開されます）' : ''));
      log.info('[api] circleGapScan done', { ...result, stopped });

    } else if (job === 'comp_listing') {
      // 総集編マーク Phase A: ジャンル515一覧を巡回し、総集編“作品”RJを収集する
      if (!global._crawlerAbort) global._crawlerAbort = {};
      global._crawlerAbort.comp = false;   // 停止ボタンからの中断要求フラグをリセット
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

      if (pushResult?.ok) {
        _lastResult[job] = { ok: true, ...pushResult, exportResult, finishedAt: Date.now() };
        _sseSend('change', `GitHub push完了 — ${pushResult.files}ファイル / commit:${(pushResult.commit ?? '').slice(0, 7)}`);
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
    if (job === 'all' || job === 'turbo') releaseDetail();
    if (job === 'all') releaseDiscovery();
    _progress.done = true;
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


function handleRunStatus() {
  const elapsed = _progress.startedAt
    ? Math.floor(Date.now() / 1000) - _progress.startedAt : 0;
  return {
    ..._jobRunning,
    progress:     { ..._progress, elapsed },
    lastResult:   _lastResult,
    recentErrors: log.getRecentErrors?.().slice(-10) ?? [],
    sseClients:   _sseClients.size,
  };
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

function handleStats() {
  const stats = db.getStats();
  stats.dbPath = _dbPath;
  return stats;
}
function handleSales()         { return db.getSaleWorks(200); }
function handlePriceIssues()   { return { issues: db.getPriceIssues({ limit: 500 }), total: db.getPriceIssuesCount() }; }
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

      const runMatch = pathname.match(/^\/api\/run\/(discover|fetch|saleboost|all|fullscan|fullscan_sale|turbo|endingsoon|circlegap|pushdata|newrelease|comp_listing|comp_detail)$/);
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
        await global._reWarmUpSession();
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
      const apiUrl = `https://www.dlsite.com/${site}/product/info/ajax?${params}&cdn_cache_min=1`;
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
