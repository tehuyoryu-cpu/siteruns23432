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
 *   POST /api/run/discover         → immediate discovery run
 *   POST /api/run/fetch            → immediate detail fetch run
 *   POST /api/run/saleboost        → immediate sale-boost run
 *   POST /api/run/all              → run all jobs immediately
 *   POST /api/run/fullscan         → FSR full-collection scan
 *   POST /api/run/fullscan_sale    → FSR sale-only scan
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
const { runDiscovery, runFullScan, runEndingSoonScan, runCircleGapScan } = require('./discovery');
const detailFetcher = require('./detailFetcher');

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
    if (/\[(discovery|detail|scheduler|electron)\]/.test(msg)) {
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
  endingsoon: false, circlegap: false,
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
};

// ─── ジョブ実行 ──────────────────────────────────────────────────────────────

async function handleRun(job, res) {
  // schedulerと共有フラグを確認（schedulerが実行中なら HTTP API からも起動しない）
  if (!global._crawlerRunning) global._crawlerRunning = {};
  const shared     = global._crawlerRunning;
  const sharedKeys = { discover: 'discovery', fetch: 'detail', turbo: 'detail' };
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

    } else if (job === 'circlegap') {
      // サークル単位の欠落診断: 既知の全サークルについてDLsite上の全作品ページを
      // 走査し、DBに存在しないRJコードを検出・登録する。
      Object.assign(_progress, { job, page: 0, found: 0, total: 0, site: null, startedAt: Math.floor(Date.now() / 1000), done: false });
      const result = await runCircleGapScan({
        onProgress: ({ checked, total, totalMissing, makerId }) => {
          Object.assign(_progress, { found: checked, totalPages: total, site: makerId });
          _sseSend('progress', { checked, total, totalMissing, makerId });
        },
      });
      _lastResult[job] = { ok: true, ...result, finishedAt: Date.now() };
      Object.assign(_progress, { done: true });
      const gapSummary = `チェック:${result.checked}サークル / 発見した欠落:${result.totalMissing}件` +
        (result.totalMissing > 0 ? ` (${Object.keys(result.missingByCircle).length}サークルで検出)` : '');
      _sseSend(result.totalMissing > 0 ? 'change' : 'log', `サークル欠落診断完了 — ${gapSummary}`);
      log.info('[api] circleGapScan done', result);

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

function handleStats() {
  const stats = db.getStats();
  stats.dbPath = _dbPath;
  return stats;
}
function handleSales()         { return db.getSaleWorks(200); }
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

      const histMatch = pathname.match(/^\/api\/history\/(.+)$/);
      if (histMatch) return _json(res, handleHistory(histMatch[1].toUpperCase()));

      if (pathname === '/api/run/status') return _json(res, handleRunStatus());

      const runMatch = pathname.match(/^\/api\/run\/(discover|fetch|saleboost|all|fullscan|fullscan_sale|turbo|endingsoon|circlegap)$/);
      if (runMatch) {
        if (req.method !== 'POST') { res.writeHead(405); res.end('POST only'); return; }
        handleRun(runMatch[1], res);
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
          const content = fs.readFileSync(log.getLogPath(), 'utf8');
          res.end(content.split('\n').slice(-200).join('\n'));
        } catch (e) {
          res.end('(ログファイルなし: ' + e.message + ')');
        }
        return;
      }

      if (pathname === '/api/errorlog') {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        try {
          const content = fs.readFileSync(log.getErrorLogPath(), 'utf8');
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

  // テスト1: DLsite新着ページ取得（page=1はURLに /page/1 を含まない）
  const testUrl = 'https://www.dlsite.com/maniax/new/=/per_page/30.html';
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
  let knownRjs = [];
  try {
    const rows = db.searchWorks({ q: '', sort: 'priority', page: 1, limit: 3 });
    knownRjs = (rows.works ?? []).map(w => w.rj_code).filter(Boolean);
  } catch (e) {
    log.warn('[diag] failed to get sample works:', e.message);
  }

  if (knownRjs.length) {
    const params = knownRjs.map(c => 'product_id%5B%5D=' + encodeURIComponent(c)).join('&');
    const apiUrl = 'https://www.dlsite.com/maniax/product/info/ajax?' + params + '&cdn_cache_min=1';
    try {
      const t0   = Date.now();
      const res  = await fetchWithRetry(apiUrl);
      const ms   = Date.now() - t0;
      const body = await res.json().catch(() => ({}));
      result.tests.push({
        name:         'Product Info API',
        url:          apiUrl,
        status:       res.status,
        ok:           res.ok && Object.keys(body).length > 0,
        ms,
        returnedKeys: Object.keys(body).length,
        testedCodes:  knownRjs,
      });
    } catch (e) {
      result.tests.push({ name: 'Product Info API', url: apiUrl, ok: false, error: e.message });
    }
  } else {
    result.tests.push({ name: 'Product Info API', ok: null, note: 'DB内に作品なし (discovery未実施)' });
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
