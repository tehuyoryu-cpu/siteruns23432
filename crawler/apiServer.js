'use strict';

/**
 * crawler/apiServer.js
 * Built-in http API server + embedded dashboard HTML.
 * No external dependencies – works inside the pkg exe as-is.
 *
 * Endpoints:
 *   GET /                    → dashboard HTML
 *   GET /api/stats           → overall counters
 *   GET /api/works           → paginated works list  ?page&q&sort&onSale
 *   GET /api/history/:rj     → price history array for charting
 *   GET /api/sales           → works currently on sale (sorted by discount)
 *   GET /api/export/json     → full price_history JSON download
 *   GET /api/export/csv      → full price_history CSV download
 */

const http   = require('http');
const url    = require('url');
const db     = require('./db');
const log    = require('./logger');
const config = require('../config');

// ─── API handlers ────────────────────────────────────────────────────────────

function handleStats() {
  return db.getStats();
}

function handleWorks(query) {
  const page   = Math.max(1, parseInt(query.page  ?? '1', 10));
  const q      = (query.q ?? '').trim();
  const sort   = query.sort ?? 'priority';
  const onSale = query.onSale === '1';
  return db.searchWorks({ q, sort, onSale, page });
}

function handleHistory(rjCode) {
  const history = db.getPriceHistory(rjCode);
  const work    = db.getWorkByRj(rjCode);
  return { work: work ?? null, history };
}

function handleSales() {
  return db.getSaleWorks(200);
}

function handleExportJson() {
  return db.exportAllHistory();
}

function handleExportCsv() {
  const data   = db.exportAllHistory();
  const header = 'rj_code,title,circle,price,sale_price,discount_rate,point,checked_at\n';
  const rows   = data.map(r =>
    [
      r.rj_code,
      _csvEscape(r.title),
      _csvEscape(r.circle),
      r.price         ?? '',
      r.sale_price    ?? '',
      r.discount_rate ?? '',
      r.point         ?? '',
      r.checked_at ? new Date(r.checked_at * 1000).toISOString() : '',
    ].join(',')
  );
  return header + rows.join('\n');
}

// ─── HTTP server ──────────────────────────────────────────────────────────────

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
      // ── dashboard ─────────────────────────────────────────────────────
      if (pathname === '/' || pathname === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(DASHBOARD_HTML);
        return;
      }

      // ── API routes ────────────────────────────────────────────────────
      if (pathname === '/api/stats') {
        return _json(res, handleStats());
      }

      if (pathname === '/api/works') {
        return _json(res, handleWorks(query));
      }

      const histMatch = pathname.match(/^\/api\/history\/(.+)$/);
      if (histMatch) {
        return _json(res, handleHistory(histMatch[1].toUpperCase()));
      }

      if (pathname === '/api/sales') {
        return _json(res, handleSales());
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
        res.end('\uFEFF' + handleExportCsv()); // BOM for Excel
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
  const port = config.ui.port;
  const host = config.ui.host;
  const server = createServer();

  server.listen(port, host, () => {
    log.info(`[api] dashboard → http://${host}:${port}`);
  });

  server.on('error', err => {
    if (err.code === 'EADDRINUSE') {
      log.error(`[api] port ${port} in use – UI disabled`);
    } else {
      log.error('[api] server error', err.message);
    }
  });

  return server;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function _json(res, data) {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function _csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  return s.includes(',') || s.includes('"') || s.includes('\n')
    ? `"${s.replace(/"/g, '""')}"`
    : s;
}

// ─── embedded dashboard HTML ──────────────────────────────────────────────────

const DASHBOARD_HTML = /* html */`<!DOCTYPE html>
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
.sb-dot  { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:4px; }
.sb-dot.green  { background:#008800; }
.sb-dot.red    { background:#cc0000; }
.sb-dot.yellow { background:#cc8800; }

/* スクロールバー */
.works-list::-webkit-scrollbar { width:16px; }
.works-list::-webkit-scrollbar-track { background:#f0f0f0; border-left:1px solid #ccc; }
.works-list::-webkit-scrollbar-thumb { background:linear-gradient(to right,#ccc,#d8d8d8); border:1px solid #aaa; }
.works-list::-webkit-scrollbar-button { height:16px; background:#f0f0f0; border:1px solid #ccc; display:block; }
</style>
</head>
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

<!-- ステータスバー -->
<div class="statusbar">
  <div class="sb-panel"><span class="sb-dot green" id="sbDot"></span>追跡中: <b id="sbTotal">–</b> 作品</div>
  <div class="sb-panel sb-sale">セール中: <b id="sbSale">–</b> 作品</div>
  <div class="sb-panel">価格記録: <b id="sbChanges">–</b> 件</div>
  <div class="sb-panel">確認待ち: <b id="sbDue">–</b> 件</div>
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
})();

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
</script>
</body>
</html>`;


module.exports = { start, createServer };
