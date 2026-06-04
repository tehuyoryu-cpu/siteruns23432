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
const { runDiscovery, runFullScan } = require('./discovery');
const detailFetcher = require('./detailFetcher');

// ─── SSE ────────────────────────────────────────────────────────────────────

const _sseClients = new Set();

function _sseSend(event, data) {
  const msg = `event: ${event}\ndata: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
  for (const res of _sseClients) {
    try { res.write(msg); } catch { _sseClients.delete(res); }
  }
}

// logger の warn/error を SSE にも流す
setTimeout(() => {
  log.warn  = (...a) => { log._origWarn?.(...a);  _sseSend('warn',  a.join(' ')); };
  log.error = (...a) => { log._origError?.(...a); _sseSend('error', a.join(' ')); };
}, 0);

// ─── 進捗状態 ────────────────────────────────────────────────────────────────

const _jobRunning = {
  discover: false, fetch: false, saleboost: false,
  fullscan: false, fullscan_sale: false, all: false,
};
const _lastResult = {};
const _progress = {
  job: null, page: 0, totalPages: null, found: 0,
  site: null, startedAt: null, done: false,
};

// ─── ジョブ実行 ──────────────────────────────────────────────────────────────

async function handleRun(job, res) {
  if (_jobRunning[job]) {
    return _json(res, { ok: false, message: `${job} is already running` });
  }
  _jobRunning[job] = true;
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

    } else if (job === 'saleboost') {
      const circles = db.getCirclesOnSale();
      db.transaction(() => {
        for (const { maker_id } of circles) db.boostCircleWorks(maker_id, 100, 7200);
      });
      db.syncCircleWorksCounts();
      log.info('[api] saleboost done, circles:', circles.length);

    } else if (job === 'all') {
      await runDiscovery();
      await detailFetcher.runDetailFetch(300, {
        onProgress: ({ processed, priceChanges, total }) => {
          Object.assign(_progress, { found: processed, total });
          _sseSend('progress', { processed, priceChanges, total });
        },
      });
      const circles = db.getCirclesOnSale();
      db.transaction(() => {
        for (const { maker_id } of circles) db.boostCircleWorks(maker_id, 100, 7200);
      });

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

function handleStats() {
  const stats = db.getStats();
  // DBパスをUIに伝える（場所確認用）
  stats.dbPath = require('path').resolve(
    process.env.DLSITE_DATA_DIR || process.env.PORTABLE_EXECUTABLE_DIR || process.cwd(),
    require('../config').db.path
  );
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
        res.end(DASHBOARD_HTML);
        return;
      }

      if (pathname === '/api/stats')  return _json(res, handleStats());
      if (pathname === '/api/works')  return _json(res, handleWorks(query));
      if (pathname === '/api/sales')  return _json(res, handleSales());

      const histMatch = pathname.match(/^\/api\/history\/(.+)$/);
      if (histMatch) return _json(res, handleHistory(histMatch[1].toUpperCase()));

      if (pathname === '/api/run/status') return _json(res, handleRunStatus());

      const runMatch = pathname.match(/^\/api\/run\/(discover|fetch|saleboost|all|fullscan|fullscan_sale)$/);
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

module.exports = { start, createServer };

// ─── ダッシュボード HTML ───────────────────────────────────────────────────────

const DASHBOARD_HTML = /* html */`<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DLsite Price Tracker</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"></script>
<style>
<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DLsite Price Tracker</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"></script>
<style>
* { margin:0; padding:0; box-sizing:border-box; }

body {
  font-family: "Meiryo","Segoe UI","MS UI Gothic",sans-serif;
  font-size: 12px;
  background: #f0f0f0;
  color: #000;
  height: 100vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  user-select: none;
}

/* ── メニューバー ── */
.menubar {
  background: #f0f0f0;
  border-bottom: 1px solid #999;
  display: flex;
  align-items: stretch;
  padding: 0 2px;
  height: 22px;
  flex-shrink: 0;
}
.menu-item {
  padding: 0 8px;
  display: flex;
  align-items: center;
  cursor: default;
  position: relative;
}
.menu-item:hover { background: #0078d7; color: #fff; }

/* ── ツールバー ── */
.toolbar {
  background: #f0f0f0;
  border-bottom: 1px solid #999;
  display: flex;
  align-items: center;
  padding: 2px 4px;
  gap: 1px;
  height: 30px;
  flex-shrink: 0;
}
.tb-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 2px;
  cursor: default;
  font-family: inherit;
  font-size: 12px;
  color: #000;
  height: 24px;
  white-space: nowrap;
}
.tb-btn:hover  { background:#e5f1fb; border-color:#0078d7; }
.tb-btn:active { background:#cce4f7; border-color:#005499; }
.tb-btn.active { background:#cce4f7; border-color:#005499; }
.tb-btn svg    { width:16px; height:16px; flex-shrink:0; }
.tb-sep { width:1px; background:#999; height:20px; margin:0 3px; }
.tb-btn.running { background:#fff4cc; border-color:#cc8800; color:#884400; cursor:wait; }
.tb-btn.running svg { animation: spin 1s linear infinite; }
@keyframes spin { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }

/* ── ログモーダル ── */
.modal-overlay {
  display:none; position:fixed; inset:0; background:rgba(0,0,0,.5);
  z-index:999; align-items:center; justify-content:center;
}
.modal-overlay.open { display:flex; }
.modal-box {
  background:#fff; width:80vw; max-width:900px; height:70vh;
  border:1px solid #999; border-radius:3px; display:flex; flex-direction:column;
  box-shadow:0 4px 20px rgba(0,0,0,.3);
}
.modal-header {
  background:linear-gradient(to bottom,#0055aa,#0078d7); color:#fff;
  padding:6px 12px; display:flex; align-items:center; gap:8px;
  font-weight:bold; font-size:13px; border-radius:2px 2px 0 0;
}
.modal-close { margin-left:auto; cursor:pointer; font-size:16px; opacity:.8; }
.modal-close:hover { opacity:1; }
.modal-body {
  flex:1; overflow:auto; padding:8px 12px;
  font-family:"Courier New",monospace; font-size:11px;
  white-space:pre; line-height:1.5; color:#333;
  background:#f8f8ff;
}
.log-error { color:#cc0000; }
.log-warn  { color:#cc6600; }
.tb-btn.running { background:#fff4cc; border-color:#cc8800; color:#884400; cursor:wait; }
.tb-btn.running svg { animation: spin 1s linear infinite; }
@keyframes spin { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }

/* ── アドレスバー風フィルタ行 ── */
.filterbar {
  background: #fff;
  border-bottom: 1px solid #ccc;
  display: flex;
  align-items: center;
  padding: 3px 6px;
  gap: 6px;
  height: 26px;
  flex-shrink: 0;
}
.filterbar label { color:#555; white-space:nowrap; font-size:11px; }
.filterbar input, .filterbar select {
  height: 20px;
  border: 1px solid #aaa;
  border-radius: 1px;
  padding: 0 4px;
  font-family: inherit;
  font-size: 12px;
  background: #fff;
  outline: none;
}
.filterbar input { width: 220px; }
.filterbar input:focus { border-color:#0078d7; }
.filterbar select { font-size:11px; }

/* ── 進捗バー ── */
.progress-bar-wrap {
  border-bottom: 1px solid #ccc;
  background: #f8f8f8;
  height: 20px;
  display: flex;
  align-items: center;
  padding: 0 8px;
  gap: 8px;
  flex-shrink: 0;
  overflow: hidden;
  transition: height .2s;
}
.progress-bar-wrap.hidden { height: 0; border: none; padding: 0; }
.progress-track {
  flex: 1;
  height: 10px;
  background: #dde;
  border: 1px solid #aab;
  border-radius: 3px;
  overflow: hidden;
}
.progress-fill {
  height: 100%;
  background: linear-gradient(to right, #0055cc, #0088ff);
  border-radius: 3px;
  transition: width .4s;
  min-width: 4px;
}
.progress-fill.indeterminate {
  width: 30% !important;
  animation: slide 1.2s ease-in-out infinite;
}
@keyframes slide {
  0%   { margin-left: 0;    }
  50%  { margin-left: 70%;  }
  100% { margin-left: 0;    }
}
.progress-label {
  font-size: 10px;
  color: #555;
  white-space: nowrap;
  min-width: 160px;
  text-align: right;
}

/* ── メインエリア ── */
.main-area {
  display: flex;
  flex: 1;
  overflow: hidden;
}

/* ── 左ペイン: リスト ── */
.pane-left {
  width: 360px;
  min-width: 200px;
  display: flex;
  flex-direction: column;
  border-right: 1px solid #999;
  background: #fff;
  flex-shrink: 0;
}

/* カラムヘッダ */
.list-header {
  display: grid;
  grid-template-columns: 90px 1fr 70px 60px;
  background: linear-gradient(to bottom, #f8f8f8, #e8e8e8);
  border-bottom: 1px solid #999;
  height: 20px;
  flex-shrink: 0;
}
.list-col-hdr {
  display: flex;
  align-items: center;
  padding: 0 4px;
  border-right: 1px solid #ccc;
  font-size: 11px;
  color: #333;
  cursor: default;
  white-space: nowrap;
  overflow: hidden;
}
.list-col-hdr:hover { background: #ddeeff; }
.list-col-hdr:last-child { border-right: none; }

/* 作品リスト */
.works-list {
  flex: 1;
  overflow-y: scroll;
  overflow-x: hidden;
}

.work-row {
  display: grid;
  grid-template-columns: 90px 1fr 70px 60px;
  height: 19px;
  border-bottom: 1px solid #e8e8e8;
  cursor: default;
  align-items: center;
}
.work-row:nth-child(even) { background: #f7f7ff; }
.work-row:hover           { background: #e5f1fb; }
.work-row.selected        { background: #0078d7; color: #fff; }
.work-row.selected .rj    { color: #cce4f7; }
.work-row.selected .disc  { background:#ff6060; }

.work-cell {
  padding: 0 4px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  border-right: 1px solid #e0e0e0;
  font-size: 11px;
  line-height: 19px;
}
.work-cell:last-child { border-right: none; }
.rj    { font-family: "Courier New",monospace; font-size:10px; color:#555; }
.price { text-align:right; font-family:"Courier New",monospace; font-size:11px; }
.disc  {
  text-align:center; font-family:"Courier New",monospace; font-size:10px; font-weight:bold;
  color:#fff; background:#cc0000; border-radius:2px; margin:1px 3px; padding:0 2px;
  line-height:16px;
}
.disc.none { background:transparent; color:transparent; }

/* ページネーション */
.pager {
  border-top: 1px solid #ccc;
  padding: 2px 6px;
  display: flex;
  align-items: center;
  gap: 4px;
  background: #f0f0f0;
  height: 22px;
  flex-shrink: 0;
}
.pager-btn {
  width:20px; height:16px;
  background: linear-gradient(to bottom,#fff,#e0e0e0);
  border: 1px solid #aaa; border-radius:2px;
  cursor:default; font-size:10px; text-align:center; line-height:14px;
}
.pager-btn:hover { background:linear-gradient(to bottom,#e5f1fb,#c8ddf0); border-color:#0078d7; }
.pager-info { font-size:11px; color:#555; flex:1; text-align:center; }

/* ── 右ペイン: 詳細 ── */
.pane-right {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: #f0f0f0;
}

/* 詳細ヘッダ */
.detail-header {
  background: linear-gradient(135deg, #0055aa 0%, #0078d7 100%);
  color: #fff;
  padding: 8px 14px;
  flex-shrink: 0;
  border-bottom: 2px solid #004a8f;
}
.detail-empty-header {
  background: linear-gradient(135deg,#888,#aaa);
  color:#fff;
  padding: 8px 14px;
  flex-shrink: 0;
  border-bottom: 2px solid #666;
}
.detail-rj    { font-family:"Courier New",monospace; font-size:10px; opacity:.8; }
.detail-title { font-size:16px; font-weight:bold; margin:2px 0; line-height:1.2; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.detail-sub   { font-size:11px; opacity:.85; }
.detail-prices {
  display:flex; gap:20px; margin-top:6px; align-items:baseline;
}
.dp-label { font-size:10px; opacity:.75; }
.dp-value { font-family:"Courier New",monospace; font-size:16px; font-weight:bold; }
.dp-value.sale { color:#ffcc00; }
.dp-badge {
  background:#cc0000; color:#fff;
  font-family:"Courier New",monospace; font-size:12px; font-weight:bold;
  padding:1px 6px; border-radius:2px; margin-left:6px;
}

/* タブ */
.detail-tabs {
  display: flex;
  background: #e4e4e4;
  border-bottom: 1px solid #999;
  padding-top: 4px;
  padding-left: 4px;
  gap: 0;
  flex-shrink: 0;
}
.tab-btn {
  padding: 3px 12px 3px 12px;
  background: linear-gradient(to bottom,#d8d8d8,#c8c8c8);
  border: 1px solid #999;
  border-bottom: none;
  margin-right: 2px;
  cursor: default;
  font-size: 11px;
  border-radius: 3px 3px 0 0;
  color: #333;
  position: relative;
  top: 1px;
}
.tab-btn.active {
  background: #fff;
  border-bottom: 1px solid #fff;
  color: #000;
  font-weight: bold;
  z-index: 1;
}
.tab-btn:not(.active):hover { background: linear-gradient(to bottom,#e0e8f4,#d0d8e8); }

/* タブコンテンツ */
.tab-content { flex:1; overflow:hidden; display:none; }
.tab-content.active { display:flex; flex-direction:column; }

/* チャートエリア */
.chart-area {
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex: 1;
  overflow: hidden;
}
.chart-panel {
  background: #fff;
  border: 1px solid #ccc;
  border-radius: 2px;
  padding: 6px 8px;
  display: flex;
  flex-direction: column;
  flex: 1;
  overflow: hidden;
}
.chart-panel.small { flex: 0 0 140px; }
.chart-title {
  font-size: 11px;
  font-weight: bold;
  color: #333;
  margin-bottom: 4px;
  border-bottom: 1px solid #eee;
  padding-bottom: 3px;
}
.chart-wrap { flex:1; position:relative; min-height:0; }

/* 履歴テーブル */
.hist-wrap {
  flex: 1;
  overflow-y: auto;
  padding: 6px;
}
.hist-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 11px;
}
.hist-table th {
  background: linear-gradient(to bottom,#f8f8f8,#e8e8e8);
  border: 1px solid #ccc;
  padding: 2px 6px;
  text-align: left;
  position: sticky;
  top: 0;
  white-space: nowrap;
}
.hist-table td {
  border: 1px solid #e0e0e0;
  padding: 1px 6px;
  font-family: "Courier New",monospace;
}
.hist-table tr:nth-child(even) td { background:#f7f7ff; }
.hist-table tr:hover td { background:#e5f1fb; }
.td-sale    { color:#cc0000; font-weight:bold; }
.td-drop    { color:#008800; font-weight:bold; }
.td-rise    { color:#cc6600; }
.td-date    { color:#555; font-size:10px; }
.td-num     { text-align:right; }

/* 空状態 */
.empty-pane {
  flex:1; display:flex; flex-direction:column;
  align-items:center; justify-content:center;
  color:#888; gap:8px;
}
.empty-icon { font-size:48px; opacity:.3; }
.empty-msg  { font-size:13px; }

/* ── ステータスバー ── */
.statusbar {
  border-top: 1px solid #999;
  background: linear-gradient(to bottom,#f0f0f0,#e4e4e4);
  display: flex;
  height: 20px;
  align-items: center;
  flex-shrink: 0;
}
.sb-panel {
  padding: 0 8px;
  border-right: 1px solid #bbb;
  height: 100%;
  display: flex;
  align-items: center;
  font-size: 11px;
  color: #333;
  white-space: nowrap;
}
.sb-panel:last-child { border-right: none; flex:1; }
.sb-sale { color: #cc0000; font-weight:bold; }

/* ── 走査進捗パネル（progress.htmlから） ── */
.scan-panel {
  display: none;
  border-top: 1px solid #ccc;
  background: #fff;
  padding: 10px 14px;
  flex-shrink: 0;
}
.scan-panel.active { display: block; }
.scan-stats {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
  margin-bottom: 10px;
}
.scan-stat {
  background: #f8f8f8;
  border: 1px solid #e8e8e8;
  border-radius: 6px;
  padding: 6px 10px;
}
.scan-stat-label { font-size: 10px; color: #999; margin-bottom: 2px; }
.scan-stat-value { font-size: 18px; font-weight: 700; color: #222; }
.scan-stat-value.blue  { color: #185FA5; }
.scan-stat-value.amber { color: #BA7517; }
.scan-rows { display: flex; flex-direction: column; gap: 5px; margin-bottom: 8px; }
.scan-row { display: flex; align-items: center; gap: 8px; }
.scan-row-label { font-size: 11px; color: #555; width: 90px; flex-shrink: 0; }
.scan-track { flex: 1; height: 7px; background: #efefef; border-radius: 999px; overflow: hidden; }
.scan-fill  { height: 100%; border-radius: 999px; background: #E24B4A;
              transition: width .6s cubic-bezier(.4,0,.2,1), background .4s; }
.scan-fill.mid  { background: #EF9F27; }
.scan-fill.done { background: #639922; }
.scan-pct { font-size: 11px; font-weight: 700; color: #185FA5; width: 32px; text-align: right; flex-shrink:0; }
.scan-log {
  background: #f8f8f8;
  border: 1px solid #e8e8e8;
  border-radius: 6px;
  padding: 5px 8px;
  max-height: 90px;
  overflow-y: auto;
  font-family: "Courier New", monospace;
  font-size: 11px;
}
.scan-log-item { padding: 1px 0; color: #555; }
.scan-log-item.change { background:#e8f4e8; border-left:3px solid #3B6D11; padding:1px 5px; color:#1a4a08; font-weight:500; border-radius:2px; margin:1px 0; }
.scan-log-item.warn   { background:#fef4e4; border-left:3px solid #BA7517; padding:1px 5px; color:#5a3500; border-radius:2px; margin:1px 0; }
.scan-log-item.err    { background:#fde8e8; border-left:3px solid #A32D2D; padding:1px 5px; color:#500; border-radius:2px; margin:1px 0; }
.sb-dot  { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:4px; }
.sb-dot.green  { background:#008800; }
.sb-dot.red    { background:#cc0000; }
.sb-dot.yellow { background:#cc8800; }

/* スクロールバー */
.works-list::-webkit-scrollbar { width:16px; }
.works-list::-webkit-scrollbar-track { background:#f0f0f0; border-left:1px solid #ccc; }
.works-list::-webkit-scrollbar-thumb { background:linear-gradient(to right,#ccc,#d8d8d8); border:1px solid #aaa; }
.works-list::-webkit-scrollbar-button { height:16px; background:#f0f0f0; border:1px solid #ccc; display:block; }

.reader-body::-webkit-scrollbar-thumb:hover { background:#0055aa; }

/* ── ページ読み込み時のフェードイン ── */
body {
  animation: fadeInDown .4s ease both;
}
.toolbar {
  animation: fadeInDown .3s ease both;
}
.menubar {
  animation: fadeInDown .2s ease both;
}
</style>
</style>
</head>
<body>
<body>

<!-- ツールバー -->
<div class="toolbar">
  <button class="tb-btn" onclick="loadWorks(1)" title="更新">
    <svg viewBox="0 0 16 16" fill="none"><path d="M13.5 8A5.5 5.5 0 1 1 8 2.5M13.5 2.5v3.5H10" stroke="#0078d7" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
    更新
  </button>
  <div class="tb-sep"></div>
  <button class="tb-btn" onclick="setTab('all')" id="tbAll" title="全作品">
    <svg viewBox="0 0 16 16"><rect x="1" y="1" width="6" height="6" fill="#0078d7" rx="1"/><rect x="9" y="1" width="6" height="6" fill="#0078d7" rx="1"/><rect x="1" y="9" width="6" height="6" fill="#0078d7" rx="1"/><rect x="9" y="9" width="6" height="6" fill="#0078d7" rx="1"/></svg>
    全作品
  </button>
  <button class="tb-btn" onclick="setTab('sale')" id="tbSale" title="セール中のみ表示">
    <svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.5" fill="#cc0000"/><text x="8" y="11.5" text-anchor="middle" fill="white" font-size="8" font-family="sans-serif" font-weight="bold">S</text></svg>
    セール中
  </button>
  <div class="tb-sep"></div>
  <button class="tb-btn" onclick="exportData('csv')" title="CSVで保存">
    <svg viewBox="0 0 16 16"><rect x="2" y="1" width="10" height="13" rx="1" fill="#fff" stroke="#888"/><path d="M8 1v4h4" fill="none" stroke="#888"/><path d="M4 9h8M4 11h6" stroke="#0078d7" stroke-width="1.5" stroke-linecap="round"/></svg>
    CSVで保存
  </button>
  <button class="tb-btn" onclick="exportData('json')" title="JSONで保存">
    <svg viewBox="0 0 16 16"><rect x="2" y="1" width="10" height="13" rx="1" fill="#fff" stroke="#888"/><path d="M8 1v4h4" fill="none" stroke="#888"/><text x="8" y="12" text-anchor="middle" fill="#cc6600" font-size="6" font-family="monospace" font-weight="bold">{}</text></svg>
    JSONで保存
  </button>
  <div class="tb-sep"></div>
  <button class="tb-btn" id="btnDiscover" onclick="runJob('discover')" title="新着/ランキング/セールを巡回してRJ収集">
    <svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.5" fill="none" stroke="#0078d7" stroke-width="1.5"/><path d="M8 4v4l3 1.5" stroke="#0078d7" stroke-width="1.3" stroke-linecap="round"/></svg>
    RJ収集
  </button>
  <button class="tb-btn" id="btnFetch" onclick="runJob('fetch')" title="未取得・期限切れ作品の価格を更新">
    <svg viewBox="0 0 16 16"><path d="M2 8h12M10 4l4 4-4 4" stroke="#0078d7" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>
    価格更新
  </button>
  <button class="tb-btn" id="btnSaleboost" onclick="runJob('saleboost')" title="セール中サークルの優先度を維持">
    <svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="#cc0000"/><text x="8" y="11.5" text-anchor="middle" fill="white" font-size="8" font-family="sans-serif" font-weight="bold">S</text></svg>
    セール優先
  </button>
  <button class="tb-btn" id="btnAll" onclick="runJob('all')" title="全て巡回" style="font-weight:bold">
    <svg viewBox="0 0 16 16"><path d="M8 1v3M8 12v3M1 8h3M12 8h3" stroke="#006600" stroke-width="1.5" stroke-linecap="round"/><circle cx="8" cy="8" r="3.5" fill="#006600"/></svg>
    全て巡回
  </button>
  <div class="tb-sep"></div>
  <button class="tb-btn" id="btnFullscan" onclick="runJob('fullscan')" title="FSR全ページ走査 — 全作品を網羅収集（時間がかかります）">
    <svg viewBox="0 0 16 16"><rect x="1" y="1" width="14" height="14" rx="2" fill="none" stroke="#660066" stroke-width="1.3"/><path d="M4 8h8M8 4v8" stroke="#660066" stroke-width="1.5" stroke-linecap="round"/></svg>
    全収集
  </button>
  <button class="tb-btn" id="btnFullscanSale" onclick="runJob('fullscan_sale')" title="セール作品を全ページ走査">
    <svg viewBox="0 0 16 16"><rect x="1" y="1" width="14" height="14" rx="2" fill="none" stroke="#cc0000" stroke-width="1.3"/><path d="M4 8h8M8 4v8" stroke="#cc0000" stroke-width="1.5" stroke-linecap="round"/></svg>
    全セール収集
  </button>
  <div class="tb-sep"></div>
  <button class="tb-btn" onclick="showLog()" title="ログを確認">
    <svg viewBox="0 0 16 16"><rect x="1" y="1" width="14" height="13" rx="1" fill="#fff" stroke="#888"/><path d="M3 5h10M3 8h10M3 11h6" stroke="#555" stroke-width="1.2" stroke-linecap="round"/></svg>
    ログ確認
  </button>
</div>

<!-- フィルタバー -->
<div class="filterbar">
  <label>検索:</label>
  <input id="search" type="text" placeholder="RJコード・タイトル・サークル名..." oninput="onSearch()">
  <label>並び順:</label>
  <select id="sortSel" onchange="loadWorks(1)">
    <option value="priority">優先度順</option>
    <option value="discount">割引率順</option>
    <option value="price">価格順</option>
    <option value="release">リリース日順</option>
    <option value="checked">確認日順</option>
  </select>
</div>

<!-- 進捗バー -->
<div class="progress-bar-wrap hidden" id="progressWrap">
  <div class="progress-track">
    <div class="progress-fill indeterminate" id="progressFill"></div>
  </div>
  <div class="progress-label" id="progressLabel">準備中...</div>
</div>

<!-- メインエリア -->
<div class="main-area">

  <!-- 左ペイン: 作品リスト -->
  <div class="pane-left">
    <div class="list-header">
      <div class="list-col-hdr">RJコード</div>
      <div class="list-col-hdr">タイトル</div>
      <div class="list-col-hdr" style="justify-content:flex-end">価格</div>
      <div class="list-col-hdr" style="justify-content:center">割引</div>
    </div>
    <div class="works-list" id="worksList"></div>
    <div class="pager" id="pager"></div>
  </div>

  <!-- 右ペイン: 詳細 -->
  <div class="pane-right" id="paneRight">
    <div class="detail-empty-header">
      <div class="detail-title">DLsite Price Tracker</div>
      <div class="detail-sub">作品を選択すると価格履歴が表示されます</div>
    </div>
    <div class="empty-pane">
      <div class="empty-icon">📊</div>
      <div class="empty-msg">左のリストから作品をクリックしてください</div>
    </div>
  </div>

</div>

<!-- ログモーダル -->
<div class="modal-overlay" id="logModal" onclick="if(event.target===this)closeLog()">
  <div class="modal-box">
    <div class="modal-header">
      📋 ログ — dlsite-tracker.log
      <span class="modal-close" onclick="closeLog()">✕</span>
    </div>
    <div class="modal-body" id="logBody">読み込み中...</div>
  </div>
</div>

<!-- 走査進捗パネル -->
<div class="scan-panel" id="scanPanel">
  <div class="scan-stats">
    <div class="scan-stat">
      <div class="scan-stat-label">走査済み</div>
      <div class="scan-stat-value blue" id="sp-scanned">0</div>
    </div>
    <div class="scan-stat">
      <div class="scan-stat-label">合計 (due)</div>
      <div class="scan-stat-value" id="sp-total">0</div>
    </div>
    <div class="scan-stat">
      <div class="scan-stat-label">価格変動</div>
      <div class="scan-stat-value amber" id="sp-changes">0</div>
    </div>
  </div>
  <div class="scan-rows">
    <div class="scan-row">
      <span class="scan-row-label">価格取得</span>
      <div class="scan-track"><div class="scan-fill" id="sf-price" style="width:0%"></div></div>
      <span class="scan-pct" id="sp-price">0%</span>
    </div>
    <div class="scan-row">
      <span class="scan-row-label">メタデータ</span>
      <div class="scan-track"><div class="scan-fill" id="sf-meta"  style="width:0%"></div></div>
      <span class="scan-pct" id="sp-meta">0%</span>
    </div>
    <div class="scan-row">
      <span class="scan-row-label">割引チェック</span>
      <div class="scan-track"><div class="scan-fill" id="sf-sale"  style="width:0%"></div></div>
      <span class="scan-pct" id="sp-sale">0%</span>
    </div>
  </div>
  <div class="scan-log" id="scanLog"></div>
</div>



<!-- ステータスバー -->
<div class="statusbar">
  <div class="sb-panel"><span class="sb-dot green" id="sbDot"></span>追跡中: <b id="sbTotal">–</b> 作品</div>
  <div class="sb-panel sb-sale">セール中: <b id="sbSale">–</b> 作品</div>
  <div class="sb-panel">価格記録: <b id="sbChanges">–</b> 件</div>
  <div class="sb-panel">確認待ち: <b id="sbDue">–</b> 件</div>
  <div class="sb-panel" id="sbLastUpdate" style="color:#888;font-size:10px"></div>
  <div class="sb-panel" id="sbStatus">準備完了</div>
</div>

<script>
// ── State ──────────────────────────────────────────────────────────────────
let _page = 1, _tab = 'all', _selRj = null;
let _charts = {}, _searchTimer = null;

// ── Boot ───────────────────────────────────────────────────────────────────
(async () => {
  await loadStats();
  await loadWorks(1);
  setInterval(loadStats, 20000);
  // worksリストも60秒ごとに自動更新（スケジューラー結果を反映）
  setInterval(() => loadWorks(_page), 60000);

  // Electron 起動時: IPC でジョブ完了/開始通知を受け取りUIに反映
  if (window.electronAPI) {
    window.electronAPI.onStarted(({ job }) => {
      setStatus((_JOB_LABELS[job] ?? job) + ' 実行中...');
      const btn = _jobBtn(job);
      if (btn) btn.classList.add('running');
    });
    window.electronAPI.onDone(({ job }) => {
      setStatus((_JOB_LABELS[job] ?? job) + ' 完了');
      const btn = _jobBtn(job);
      if (btn) btn.classList.remove('running');
      loadStats();
      loadWorks(_page);
    });
  }
})();

// job名 → ツールバーボタン要素
function _jobBtn(job) {
  const cap = s => s.charAt(0).toUpperCase() + s.replace(/_([a-z])/g, (_, c) => c.toUpperCase()).slice(1);
  return document.getElementById('btn' + cap(job));
}

// ── Stats ──────────────────────────────────────────────────────────────────
async function loadStats() {
  const s = await api('/api/stats');
  if (!s) return;
  setText('sbTotal',   s.totalWorks);
  setText('sbSale',    s.onSale);
  setText('sbChanges', s.priceChanges);
  setText('sbDue',     s.dueNow);
  const dot = document.getElementById('sbDot');
  if (dot) dot.className = 'sb-dot ' + (s.onSale > 0 ? 'red' : 'green');
  // 最終更新時刻
  const luEl = document.getElementById('sbLastUpdate');
  if (luEl) {
    const now = new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    luEl.textContent = '最終更新: ' + now;
    if (s.dbPath) luEl.title = 'DB: ' + s.dbPath;
  }
}

// ── Works list ─────────────────────────────────────────────────────────────
async function loadWorks(page = 1) {
  _page = page;
  const q      = document.getElementById('search').value.trim();
  const sort   = document.getElementById('sortSel').value;
  const onSale = _tab === 'sale' ? '&onSale=1' : '';
  setStatus('読み込み中...');
  const data = await api('/api/works?page=' + page + '&q=' + encodeURIComponent(q) + '&sort=' + sort + onSale);
  if (!data) { setStatus('取得失敗'); return; }

  const el = document.getElementById('worksList');
  if (!data.works.length) {
    el.innerHTML = '<div style="padding:20px;color:#888;text-align:center">作品が見つかりません</div>';
  } else {
    el.innerHTML = data.works.map(w => rowHTML(w)).join('');
  }

  // restore selection highlight
  if (_selRj) {
    const r = el.querySelector('[data-rj="' + _selRj + '"]');
    if (r) r.classList.add('selected');
  }

  renderPager(data.page, data.pages, data.total);
  setStatus(data.total.toLocaleString() + ' 件');
}

function rowHTML(w) {
  const price   = w.price != null ? '¥' + w.price.toLocaleString() : '–';
  const disc    = w.discount_rate != null ? '-' + w.discount_rate + '%' : '';
  const discCls = disc ? 'disc' : 'disc none';
  return '<div class="work-row" data-rj="' + w.rj_code + '" onclick="selectWork(this,\'' + w.rj_code + '\')">'
    + '<div class="work-cell rj">' + esc(w.rj_code) + '</div>'
    + '<div class="work-cell">' + esc(w.title || '–') + '</div>'
    + '<div class="work-cell price">' + price + '</div>'
    + '<div class="work-cell ' + discCls + '">' + esc(disc) + '</div>'
    + '</div>';
}

function renderPager(page, pages, total) {
  const el = document.getElementById('pager');
  if (pages <= 1) { el.innerHTML = '<span class="pager-info">' + total + ' 件</span>'; return; }
  el.innerHTML =
    '<div class="pager-btn" onclick="loadWorks(' + Math.max(1,page-1) + ')">◀</div>' +
    '<span class="pager-info">' + page + ' / ' + pages + ' ページ (' + total + ' 件)</span>' +
    '<div class="pager-btn" onclick="loadWorks(' + Math.min(pages,page+1) + ')">▶</div>';
}

// ── Detail ─────────────────────────────────────────────────────────────────
async function selectWork(el, rj) {
  document.querySelectorAll('.work-row').forEach(r => r.classList.remove('selected'));
  el.classList.add('selected');
  _selRj = rj;
  setStatus(rj + ' を読み込み中...');

  const data = await api('/api/history/' + rj);
  if (!data) { setStatus('取得失敗'); return; }
  renderDetail(data.work, data.history, rj);
  setStatus(rj + ' (' + data.history.length + ' 件の価格記録)');
}

function renderDetail(work, history, rj) {
  const latest = history.length ? history[history.length - 1] : null;
  const title  = work?.title  || rj;
  const circle = work?.circle || '–';
  const isOnSale = work?.is_on_sale;

  const priceStr = latest?.price != null ? '¥' + latest.price.toLocaleString() : '–';
  const saleStr  = latest?.sale_price != null ? '¥' + latest.sale_price.toLocaleString() : '';
  const disc     = latest?.discount_rate != null ? '-' + latest.discount_rate + '%' : '';

  const headerHtml =
    '<div class="detail-header">' +
    '<div class="detail-rj">' + esc(rj) + ' / ' + esc(work?.work_type||'') + ' / ' + esc(work?.release_date||'') + '</div>' +
    '<div class="detail-title">' + esc(title) + '</div>' +
    '<div class="detail-sub">' + esc(circle) + '</div>' +
    '<div class="detail-prices">' +
      '<div><div class="dp-label">定価</div><div class="dp-value">' + priceStr + '</div></div>' +
      (saleStr ? '<div><div class="dp-label">セール価格</div><div class="dp-value sale">' + saleStr + (disc ? '<span class="dp-badge">' + esc(disc) + '</span>' : '') + '</div></div>' : '') +
    '</div>' +
    '</div>';

  const tabsHtml =
    '<div class="detail-tabs">' +
    '<div class="tab-btn active" id="tabChart" onclick="switchTab(\'chart\')">価格グラフ</div>' +
    '<div class="tab-btn" id="tabDisc"  onclick="switchTab(\'disc\')">割引率グラフ</div>' +
    '<div class="tab-btn" id="tabHist"  onclick="switchTab(\'hist\')">履歴一覧</div>' +
    '</div>';

  const chartHtml =
    '<div class="tab-content active" id="tcChart">' +
    '<div class="chart-area">' +
    '<div class="chart-panel"><div class="chart-title">価格推移 (JPY)</div><div class="chart-wrap"><canvas id="cPrice"></canvas></div></div>' +
    '</div></div>';

  const discHtml =
    '<div class="tab-content" id="tcDisc">' +
    '<div class="chart-area">' +
    '<div class="chart-panel"><div class="chart-title">割引率推移 (%)</div><div class="chart-wrap"><canvas id="cDisc"></canvas></div></div>' +
    '</div></div>';

  const histHtml =
    '<div class="tab-content" id="tcHist">' +
    '<div class="hist-wrap">' +
    histTableHTML(history) +
    '</div></div>';

  const pane = document.getElementById('paneRight');
  pane.innerHTML = headerHtml + tabsHtml + chartHtml + discHtml + histHtml;

  destroyCharts();
  renderCharts(history);
}

function switchTab(name) {
  ['chart','disc','hist'].forEach(t => {
    document.getElementById('tc' + cap(t))?.classList.toggle('active', t === name);
    document.getElementById('tab' + cap(t))?.classList.toggle('active', t === name);
  });
  // Charts need resize after becoming visible
  if (name !== 'hist') setTimeout(() => Object.values(_charts).forEach(c => c?.resize()), 50);
}

function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

function histTableHTML(history) {
  if (!history.length) return '<div style="padding:20px;color:#888;text-align:center">価格記録がありません</div>';
  const rows = [...history].reverse().map((h, i, arr) => {
    const prev    = arr[i + 1];
    const dateStr = h.checked_at ? new Date(h.checked_at * 1000).toLocaleString('ja-JP') : '–';
    const price   = h.price      != null ? '¥' + h.price.toLocaleString()      : '–';
    const sale    = h.sale_price  != null ? '¥' + h.sale_price.toLocaleString() : '–';
    const disc    = h.discount_rate != null ? h.discount_rate + '%' : '–';

    let chg = '', chgCls = '';
    if (prev && h.price != null && prev.price != null) {
      const d = h.price - prev.price;
      if (d < 0) { chg = '▼' + Math.abs(d).toLocaleString(); chgCls = 'td-drop'; }
      else if (d > 0) { chg = '▲' + d.toLocaleString(); chgCls = 'td-rise'; }
      else chg = '–';
    }

    return '<tr>'
      + '<td class="td-date">' + esc(dateStr) + '</td>'
      + '<td class="td-num">' + price + '</td>'
      + '<td class="td-num ' + (h.sale_price ? 'td-sale' : '') + '">' + sale + '</td>'
      + '<td class="td-num ' + (h.discount_rate ? 'td-sale' : '') + '">' + disc + '</td>'
      + '<td class="td-num ' + chgCls + '">' + esc(chg) + '</td>'
      + '</tr>';
  }).join('');

  return '<table class="hist-table"><thead><tr><th>日時</th><th>定価</th><th>セール価格</th><th>割引率</th><th>変動</th></tr></thead><tbody>' + rows + '</tbody></table>';
}

// ── Charts ─────────────────────────────────────────────────────────────────
function renderCharts(history) {
  const labels = history.map(h => {
    if (!h.checked_at) return '';
    const d = new Date(h.checked_at * 1000);
    return (d.getMonth()+1) + '/' + d.getDate();
  });
  const prices = history.map(h => h.price);
  const sales  = history.map(h => h.sale_price);
  const discs  = history.map(h => h.discount_rate);

  const gridC = '#e8e8e8', tickC = '#666';
  const baseOpts = {
    responsive:true, maintainAspectRatio:false,
    animation:{duration:200},
    plugins:{ legend:{ labels:{ color:'#333', font:{size:11} } } },
    scales:{
      x:{ grid:{color:gridC}, ticks:{color:tickC, maxTicksLimit:10, font:{size:10}} }
    }
  };

  const pc = document.getElementById('cPrice');
  if (pc) {
    _charts.price = new Chart(pc, {
      type:'line',
      data:{
        labels,
        datasets:[
          { label:'定価', data:prices, borderColor:'#0055aa', backgroundColor:'rgba(0,85,170,.07)',
            fill:true, tension:.3, borderWidth:2, pointRadius:3, pointBackgroundColor:'#0055aa', spanGaps:true },
          { label:'セール価格', data:sales, borderColor:'#cc0000', backgroundColor:'rgba(204,0,0,.06)',
            fill:false, tension:.3, borderWidth:2, pointRadius:3, pointBackgroundColor:'#cc0000', spanGaps:true },
        ]
      },
      options:{
        ...baseOpts,
        scales:{
          ...baseOpts.scales,
          y:{grid:{color:gridC}, ticks:{color:tickC, callback:v=>'¥'+v.toLocaleString()}}
        }
      }
    });
  }

  const dc = document.getElementById('cDisc');
  if (dc) {
    _charts.disc = new Chart(dc, {
      type:'bar',
      data:{
        labels,
        datasets:[{
          label:'割引率 (%)', data:discs, spanGaps:true,
          backgroundColor: discs.map(v => v == null ? 'transparent' : v >= 50 ? 'rgba(204,0,0,.75)' : 'rgba(204,100,0,.65)'),
          borderRadius:2,
        }]
      },
      options:{
        ...baseOpts,
        plugins:{legend:{display:false}},
        scales:{
          ...baseOpts.scales,
          y:{grid:{color:gridC}, ticks:{color:tickC, callback:v=>v+'%'}, min:0, max:100}
        }
      }
    });
  }
}

function destroyCharts() {
  Object.values(_charts).forEach(c => c?.destroy());
  _charts = {};
}

// ── Controls ───────────────────────────────────────────────────────────────
function setTab(t) {
  _tab = t;
  document.getElementById('tbAll')?.classList.toggle('active',  t === 'all');
  document.getElementById('tbSale')?.classList.toggle('active', t === 'sale');
  loadWorks(1);
}

function onSearch() {
  clearTimeout(_searchTimer);
  _searchTimer = setTimeout(() => loadWorks(1), 250);
}

function exportData(fmt) { window.open('/api/export/' + fmt, '_blank'); }

// ── 走査進捗パネル制御 ────────────────────────────────────────────────────────
let _spScanned = 0, _spTotal = 0, _spChanges = 0;
let _sseConn   = null;
const SCAN_LOG_MAX = 40;

function _spSetBar(fillId, pctId, pct) {
  const fill = document.getElementById(fillId);
  const pctEl = document.getElementById(pctId);
  if (!fill || !pctEl) return;
  fill.style.width = pct + '%';
  fill.className = 'scan-fill' + (pct >= 80 ? ' done' : pct >= 40 ? ' mid' : '');
  pctEl.textContent = pct + '%';
}

function _spUpdate() {
  const el = id => document.getElementById(id);
  el('sp-scanned').textContent = _spScanned.toLocaleString();
  el('sp-total').textContent   = _spTotal.toLocaleString();
  el('sp-changes').textContent = _spChanges;
  const pct = _spTotal > 0 ? Math.min(100, Math.round(_spScanned / _spTotal * 100)) : 0;
  _spSetBar('sf-price', 'sp-price', pct);
  _spSetBar('sf-meta',  'sp-meta',  Math.min(Math.round(pct * 0.7), 100));
  _spSetBar('sf-sale',  'sp-sale',  Math.min(Math.round(pct * 0.5), 100));
}

function _spLog(msg, type) {
  const el = document.getElementById('scanLog');
  if (!el) return;
  const now = new Date();
  const ts  = [now.getHours(), now.getMinutes(), now.getSeconds()]
                .map(n => String(n).padStart(2,'0')).join(':');
  const div = document.createElement('div');
  div.className = 'scan-log-item' + (type ? ' ' + type : '');
  div.textContent = '[' + ts + '] ' + msg;
  el.prepend(div);
  while (el.children.length > SCAN_LOG_MAX) el.removeChild(el.lastChild);
}

function _spShow(show) {
  document.getElementById('scanPanel')?.classList.toggle('active', show);
}

function _spStartSSE() {
  if (_sseConn) { _sseConn.close(); _sseConn = null; }
  if (typeof EventSource === 'undefined') { _spStartPolling(); return; }
  _sseConn = new EventSource('/api/log-stream');
  _sseConn.addEventListener('log',    e => _spLog(e.data));
  _sseConn.addEventListener('change', e => { _spLog(e.data, 'change'); });
  _sseConn.addEventListener('warn',   e => _spLog(e.data, 'warn'));
  _sseConn.addEventListener('error',  e => _spLog(e.data, 'err'));
  _sseConn.addEventListener('progress', e => {
    try {
      const d = JSON.parse(e.data);
      if (typeof d.processed === 'number') {
        _spScanned = d.processed;
        _spChanges = d.priceChanges ?? _spChanges;
        if (d.total) _spTotal = d.total;
      } else if (typeof d.found === 'number') {
        _spScanned = d.found;
      }
      _spUpdate();
    } catch {}
  });
  _sseConn.onerror = () => {
    _spLog('接続が切れました。再接続中...', 'warn');
    setTimeout(() => { if (_sseConn) _spStartSSE(); }, 5000);
  };
}

function _spStopSSE() {
  if (_sseConn) { _sseConn.close(); _sseConn = null; }
}

// polling fallback（EventSource が使えない環境）
function _spStartPolling() {
  setInterval(async () => {
    const s = await api('/api/run/status');
    if (!s) return;
    const p = s.progress ?? {};
    if (p.found > _spScanned) {
      _spScanned = p.found;
      _spUpdate();
    }
  }, 2000);
}

// ── ログモーダル ────────────────────────────────────────────────────────────
async function showLog() {
  document.getElementById('logModal').classList.add('open');
  const body = document.getElementById('logBody');
  body.textContent = '読み込み中...';
  try {
    const r = await fetch('/api/log');
    const text = await r.text();
    // 色付け
    body.innerHTML = text.split('\n').map(line => {
      if (line.includes('[ERROR]')) return '<span class="log-error">' + esc(line) + '</span>';
      if (line.includes('[WARN')) return '<span class="log-warn">' + esc(line) + '</span>';
      return esc(line);
    }).join('\n');
    body.scrollTop = body.scrollHeight; // 最新行へスクロール
  } catch(e) { body.textContent = 'エラー: ' + e.message; }
}
function closeLog() { document.getElementById('logModal').classList.remove('open'); }

// ── ジョブ完了後の結果表示 ──────────────────────────────────────────────────
function _showJobResult(job, status) {
  const r = status.lastResult?.[job];
  if (!r) return;
  if (!r.ok) {
    setStatus('⚠ ' + (r.error || 'エラー'));
    return;
  }
  if (job === 'discover')    setStatus('RJ収集完了 — 新規: ' + (r.discovered ?? 0) + ' 件');
  else if (job === 'fetch')  setStatus('価格更新完了 — 処理: ' + (r.processed ?? 0) + ' 件 / 変化: ' + (r.priceChanges ?? 0) + ' 件');
  else if (job === 'all')    setStatus('全て巡回完了');
  else if (job?.startsWith('fullscan')) setStatus('全収集完了 — ' + (status.fullScanProgress?.grandTotal ?? 0) + ' 件');
  else setStatus((_JOB_LABELS[job] ?? job) + ' 完了');
}

// ── ジョブ実行 ────────────────────────────────────────────────────────────
const _JOB_LABELS = {
  discover:      'RJ収集',
  fetch:         '価格更新',
  saleboost:     'セール優先',
  all:           '全て巡回',
  fullscan:      '全収集',
  fullscan_sale: '全セール収集',
};

async function runJob(job) {
  const btn = document.getElementById('btn' + job.charAt(0).toUpperCase() + job.slice(1));
  if (!btn || btn.classList.contains('running')) return;

  btn.classList.add('running');
  btn.title = '実行中...';
  setStatus(_JOB_LABELS[job] + ' 実行中...');

  try {
    const r = await fetch('/api/run/' + job, { method: 'POST' });
    const d = await r.json();
    if (!d.ok) {
      setStatus('⚠ ' + d.message);
      btn.classList.remove('running');
      btn.title = _JOB_LABELS[job];
      return;
    }
    setStatus(_JOB_LABELS[job] + ' 開始 — 完了後に統計が更新されます');

    // 完了を検知するまでポーリング
    await _waitJobDone(job, btn);
  } catch (e) {
    setStatus('エラー: ' + e.message);
    btn.classList.remove('running');
  }
}

async function _waitJobDone(job, btn) {
  const checkKey = job === 'all' ? 'discover' : job;
  let tries = 0;
  showProgress(true);

  // 走査パネルを表示して SSE 接続
  if (job === 'fetch' || job === 'all') {
    const status = await api('/api/stats');
    _spTotal   = status?.dueNow ?? 0;
    _spScanned = 0; _spChanges = 0;
    _spUpdate();
    _spShow(true);
    _spStartSSE();
    _spLog((_JOB_LABELS[job] ?? job) + ' 開始...');
  } else if (job === 'discover' || job.startsWith('fullscan')) {
    _spScanned = 0; _spTotal = 0; _spChanges = 0;
    _spUpdate();
    _spShow(true);
    _spStartSSE();
    _spLog((_JOB_LABELS[job] ?? job) + ' 開始...');
  }

  const id = setInterval(async () => {
    tries++;
    const s = await api('/api/run/status');
    if (!s) return;

    const p = s.progress ?? {};
    updateProgressBar(p, job);

    if (!s[checkKey] || tries > 600) {
      clearInterval(id);
      btn.classList.remove('running');
      btn.title = _JOB_LABELS[job];
      await loadStats();
      await loadWorks(_page);
      showProgress(false);

      // 走査パネルを完了表示にしてから5秒後に閉じる
      if (document.getElementById('scanPanel')?.classList.contains('active')) {
        _spScanned = _spTotal;
        _spUpdate();
        _spLog('完了 — ' + _spChanges + '件の価格変動を検出', _spChanges > 0 ? 'change' : '');
        _spStopSSE();
        setTimeout(() => _spShow(false), 5000);
      }

      if (p.done && (job === 'fullscan' || job === 'fullscan_sale')) {
        setStatus('全収集完了 — 新規: ' + (s.fullScanProgress?.grandTotal ?? p.found ?? 0) + ' 件');
      } else {
        _showJobResult(job, s);
      }
    }
  }, 1500);
}

function showProgress(show) {
  const wrap = document.getElementById('progressWrap');
  if (wrap) wrap.classList.toggle('hidden', !show);
}

function updateProgressBar(p, job) {
  const fill  = document.getElementById('progressFill');
  const label = document.getElementById('progressLabel');
  if (!fill || !label) return;

  const elapsed = p.elapsed ? Math.floor(p.elapsed) + 's' : '';

  if (job === 'fullscan' || job === 'fullscan_sale') {
    fill.classList.add('indeterminate');
    const site  = p.site ? '[' + p.site + ']' : '';
    const page  = p.page ? 'p.' + p.page : '';
    const found = p.found ? p.found + '件' : '';
    label.textContent = [site, page, found, elapsed].filter(Boolean).join(' ');
  } else if (job === 'fetch' || job === 'all') {
    const processed = _spScanned || p.found || 0;
    const total     = _spTotal   || p.total || 0;
    const pct = total > 0 ? Math.min(99, Math.round(processed / total * 100)) : 0;
    fill.classList.remove('indeterminate');
    fill.style.width = (pct || 2) + '%';
    const changes = _spChanges > 0 ? ` 変動:${_spChanges}件` : '';
    label.textContent = `${processed}/${total}件${changes} ${elapsed}`;
  } else {
    fill.classList.add('indeterminate');
    label.textContent = (_JOB_LABELS[job] ?? job) + '中... ' + elapsed;
  }
}

// ── Utils ──────────────────────────────────────────────────────────────────
async function api(path) {
  try {
    const r = await fetch(path);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } catch(e) { console.error('[api]', path, e.message); return null; }
}

function setText(id, v) {
  const el = document.getElementById(id);
  if (el) el.textContent = v != null ? v.toLocaleString() : '–';
}

function setStatus(msg) {
  const el = document.getElementById('sbStatus');
  if (el) el.textContent = msg;
}

function esc(s) {
  if (!s) return '';
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}



// ── リップルエフェクト（ツールバーボタン） ──────────────────────────────────
document.addEventListener('mousedown', e => {
  const btn = e.target.closest('.tb-btn');
  if (!btn) return;
  const rect = btn.getBoundingClientRect();
  const el = document.createElement('span');
  el.className = 'ripple-el';
  el.style.left = (e.clientX - rect.left) + 'px';
  el.style.top  = (e.clientY - rect.top) + 'px';
  btn.appendChild(el);
  el.addEventListener('animationend', () => el.remove());
});
</script>
</body>
</html>`;
