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
  stats.dbPath = require('path').resolve(
    process.env.DLSITE_DATA_DIR || process.cwd(),
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
        res.end(_getDashboardHtml());
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
            log.error(`[client:${source ?? 'ui'}]`, message);
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
  const result = {
    timestamp: new Date().toISOString(),
    dbStats: db.getStats(),
    dbPath: require('path').resolve(
      process.env.DLSITE_DATA_DIR || process.cwd(),
      require('../config').db.path
    ),
    logPath: log.getLogPath(),
    isElectron: process.type === 'browser',
    tests: [],
  };

  // テスト1: DLsite新着ページ取得
  const testUrl = 'https://www.dlsite.com/maniax/new/=/per_page/30/page/1.html';
  try {
    const t0  = Date.now();
    const res = await fetchWithRetry(testUrl);
    const ms  = Date.now() - t0;
    const html = await res.text();
    const items = parser.parseWorkListWithPrice(html);
    result.tests.push({
      name: '新着ページ取得',
      url: testUrl,
      status: res.status,
      ok: res.ok,
      ms,
      parsed: items.length,
      htmlLen: html.length,
      sample: items.slice(0, 3).map(i => i.rjCode),
      cfBlock: html.includes('cf-browser-verification') || html.includes('Checking your browser'),
      ageCheck: html.includes('adultcheck') || html.includes('agecheck'),
    });
  } catch (e) {
    result.tests.push({ name: '新着ページ取得', url: testUrl, ok: false, error: e.message });
  }

  // テスト2: Product Info API
  let knownRjs = [];
  try {
    const rows = db.searchWorks({ q: '', sort: 'priority', page: 1, limit: 3 });
    knownRjs = (rows.works ?? []).map(w => w.rj_code).filter(Boolean);
  } catch (e) {
    log.warn('[diag] failed to get sample works:', e.message);
  }

  if (knownRjs.length) {
    const codes  = knownRjs;
    const params = codes.map(c => 'product_id=' + encodeURIComponent(c)).join('&');
    const apiUrl = 'https://www.dlsite.com/maniax/product/info/ajax?' + params + '&cdn_cache_min=1';
    try {
      const t0  = Date.now();
      const res = await fetchWithRetry(apiUrl);
      const ms  = Date.now() - t0;
      const body = await res.json().catch(() => ({}));
      result.tests.push({
        name: 'Product Info API',
        url: apiUrl,
        status: res.status,
        ok: res.ok && Object.keys(body).length > 0,
        ms,
        returnedKeys: Object.keys(body).length,
        testedCodes: codes,
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
