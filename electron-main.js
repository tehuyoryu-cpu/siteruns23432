'use strict';

/**
 * electron-main.js
 * Electron メインプロセス。
 *
 * 制御フロー:
 *   HTTP API (port 7777) ← web UI のボタン
 *   IPC (ipcMain)        ← renderer からの直接呼び出し（HTTP不要）
 *   Tray menu            ← OS ネイティブのトレイ操作
 *   App menu             ← ウィンドウ上部のメニューバー
 */

const {
  app, BrowserWindow, Tray, Menu, nativeImage,
  shell, ipcMain, dialog,
} = require('electron');

// ─── data dir ────────────────────────────────────────────────────────────────
// PORTABLE_EXECUTABLE_DIR がTEMPディレクトリを指す場合があるため検証してから使用する。
// TEMPなら app.getPath('userData') にフォールバックする。
{
  const path = require('path');
  const os   = require('os');

  const tmpDir = os.tmpdir().toLowerCase().replace(/\\/g, '/');
  const isTemp = p => !p || p.toLowerCase().replace(/\\/g, '/').startsWith(tmpDir);

  const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
  const dataDir =
    (process.env.NODE_ENV === 'development'
      ? process.cwd()
      : (!isTemp(portableDir) ? portableDir : null)
    ) ?? app.getPath('userData');

  process.env.DLSITE_DATA_DIR = dataDir;
  console.log('[main] data dir:', dataDir, portableDir ? `(PORTABLE_EXECUTABLE_DIR: ${portableDir})` : '');
}

// ─── backend ──────────────────────────────────────────────────────────────────

let db, apiServer, scheduler, discovery, detailFetcher;


// DLsite をヘッドレスChromiumで開き、CF/年齢確認をクリアして
// セッションCookieを確立する。以後 electron.net.fetch が自動でそのCookieを使う。
async function warmUpSession() {
  return new Promise(resolve => {
    const { BrowserWindow, session } = require('electron');
    const w = new BrowserWindow({
      show: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });

    let resolved = false;
    const done = () => {
      if (resolved) return;
      resolved = true;
      try { w.destroy(); } catch {}
      resolve();
    };

    // ページロード完了ごとに年齢確認ボタンをクリック試行
    w.webContents.on('did-finish-load', async () => {
      try {
        // 年齢確認ボタン（複数のセレクタに対応）
        await w.webContents.executeJavaScript(`
          (function() {
            // CSS セレクタで特定できるボタンを先に試す
            const selectors = [
              'a.btn_yes', 'a[href*="adult=1"]', '.btn_adult',
              'a[href*="age_check"]', 'input[value*="はい"]',
              '.age_check_yes', 'a[href*="adultchecked"]'
            ];
            for (const sel of selectors) {
              try {
                const el = document.querySelector(sel);
                if (el) { el.click(); return true; }
              } catch {}
            }
            // :contains は無効なので全 <a> をテキストで走査
            const keywords = ['はい', '入場する', '18歳以上', 'adult', 'enter', '同意'];
            for (const a of document.querySelectorAll('a, button')) {
              const txt = (a.textContent || '').trim();
              if (keywords.some(k => txt.includes(k))) { a.click(); return true; }
            }
            return false;
          })()
        `);
      } catch {}

      // 2秒後にCookieを確認して完了
      setTimeout(async () => {
        try {
          const cookies = await session.defaultSession.cookies.get(
            { domain: 'dlsite.com' }
          );
          console.log('[warmUp] cookies obtained:', cookies.map(c => c.name).join(', '));
        } catch {}
        done();
      }, 2000);
    });

    w.webContents.once('did-fail-load', done);
    setTimeout(done, 25000); // タイムアウト25秒

    // 成人向けコンテンツページを直接開く（年齢確認をトリガー）
    w.loadURL('https://www.dlsite.com/maniax/');
  });
}
async function startBackend() {
  db            = require('./crawler/db');
  apiServer     = require('./crawler/apiServer');
  scheduler     = require('./crawler/scheduler');
  discovery     = require('./crawler/discovery');
  detailFetcher = require('./crawler/detailFetcher');

  await db.init();

  apiServer.start();
  await new Promise(r => setTimeout(r, 400));

  // 1. 必須 Cookie を事前注入（年齢確認・ロケール）
  try {
    const { session } = require('electron');
    const ses = session.defaultSession;
    const base = { url: 'https://www.dlsite.com', domain: '.dlsite.com', path: '/', httpOnly: false };
    for (const [name, value] of [
      ['locale',        'ja-jp'],
      ['adultchecked',  '1'],
      ['agecheck',      '1'],
    ]) {
      await ses.cookies.set({ ...base, name, value })
        .catch(e => console.warn('[cookie] set failed', name, e.message));
    }
    console.log('[startBackend] cookies pre-injected');
  } catch(e) { console.warn('[cookie] session not ready', e.message); }

  // 2. DLsite を実際に開いてCF/年齢確認をクリア（Cookie が session に蓄積される）
  await warmUpSession();
  console.log('[startBackend] session warmed up, starting scheduler');

  // 3. クローラー起動
  scheduler.start().catch(err =>
    console.error('[electron] scheduler error', err.message)
  );
}

// ─── IPC: renderer → main ──────────────────────────────────────────────────

// 重複実行防止（schedulerと共有）
// キー: state名（scheduler/apiServerと統一） ← job名ではない
const _running = {};

// scheduler.js / apiServer.js が参照できるよう global に公開
global._crawlerRunning = _running;

// job名 → state名 マッピング（apiServer.js の sharedKeys と一致させる）
const _JOB_TO_STATE = {
  discover:     'discovery',
  fetch:        'detail',
  saleboost:    'saleBoost',
  fullscan:     'fullscan',
  fullscan_sale:'fullscan_sale',
  all:          'discovery',
};

function _bindIpc() {
  // ステータス取得
  ipcMain.handle('crawler:status', () => {
    try {
      return { ok: true, stats: db.getStats(), running: { ..._running } };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // 各ジョブ実行
  ipcMain.handle('crawler:run', async (_, job) => {
    const sk = _JOB_TO_STATE[job] ?? job;
    if (_running[sk]) return { ok: false, message: `${job} is already running` };
    _running[sk] = true;

    // レスポンスをすぐ返してバックグラウンドで実行
    setImmediate(async () => {
      try {
        await _execJob(job);
      } catch (err) {
        console.error('[electron] job error', job, err.message);
      } finally {
        _running[sk] = false;
        // 完了をウィンドウに通知
        if (_win && !_win.isDestroyed()) {
          _win.webContents.send('crawler:done', { job, stats: db.getStats() });
        }
      }
    });

    return { ok: true, message: `${job} started` };
  });
}

async function _execJob(job) {
  const log = require('./crawler/logger');
  log.info('[electron] job start', job);
  if (job === 'discover') {
    await discovery.runDiscovery();
  } else if (job === 'fetch') {
    await detailFetcher.runDetailFetch(300);
  } else if (job === 'saleboost') {
    const circles = db.getCirclesOnSale();
    db.transaction(() => {
      for (const { maker_id } of circles) {
        db.boostCircleWorks(maker_id, 100, 7200);
      }
    });
    db.syncCircleWorksCounts();
  } else if (job === 'all') {
    await discovery.runDiscovery();
    await detailFetcher.runDetailFetch(300);
    const circles = db.getCirclesOnSale();
    db.transaction(() => {
      for (const { maker_id } of circles) {
        db.boostCircleWorks(maker_id, 100, 7200);
      }
    });
  } else if (job === 'fullscan') {
    await discovery.runFullScan({ sale: false, maxPages: 0 });
  } else if (job === 'fullscan_sale') {
    await discovery.runFullScan({ sale: true, maxPages: 0 });
  }
}

// ─── window ───────────────────────────────────────────────────────────────────

let _win  = null;
let _tray = null;

function createWindow() {
  _win = new BrowserWindow({
    width:     1280,
    height:    820,
    minWidth:  900,
    minHeight: 600,
    title:     'DLsite Price Tracker',
    backgroundColor: '#f0f2f5',
    show:            false,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration:  false,
      contextIsolation: true,
      preload: require('path').join(__dirname, 'preload.js'),
    },
  });

  // Electron ネイティブメニューバー
  _win.setMenu(_buildAppMenu());

  _win.loadURL('http://127.0.0.1:7777');

  _win.once('ready-to-show', () => _win.show());

  _win.on('close', e => {
    if (!app.isQuiting) {
      e.preventDefault();
      _win.hide();
    }
  });

  _win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

// ─── ネイティブメニューバー ────────────────────────────────────────────────────

function _buildAppMenu() {
  const runItem = (label, job, accel) => ({
    label,
    accelerator: accel,
    click: async () => {
      const sk = _JOB_TO_STATE[job] ?? job;
      if (_running[sk]) {
        dialog.showMessageBox(_win, { message: `${label} は実行中です`, type: 'info' });
        return;
      }
      _running[sk] = true;
      _win?.webContents.send('crawler:started', { job });
      try { await _execJob(job); } finally {
        _running[sk] = false;
        _win?.webContents.send('crawler:done', { job, stats: db.getStats() });
      }
    },
  });

  return Menu.buildFromTemplate([
    {
      label: 'ファイル',
      submenu: [
        {
          label: 'データベースの場所を開く',
          click: () => {
            const p = require('path');
            const dbPath = p.resolve(
              process.env.DLSITE_DATA_DIR || app.getPath('userData'),
              require('./config').db.path
            );
            shell.showItemInFolder(dbPath);
          },
        },
        { type: 'separator' },
        { label: '終了', accelerator: 'Alt+F4', click: () => { app.isQuiting = true; app.quit(); } },
      ],
    },
    {
      label: '巡回',
      submenu: [
        runItem('RJ収集（新着/ランキング/セール）', 'discover',      'Ctrl+1'),
        runItem('価格更新（未取得・期限切れ）',    'fetch',          'Ctrl+2'),
        runItem('セール優先（サークル優先度維持）', 'saleboost',      'Ctrl+3'),
        { type: 'separator' },
        runItem('全て巡回',                        'all',            'Ctrl+Shift+A'),
        { type: 'separator' },
        runItem('全収集（FSR全ページ）',           'fullscan',       'Ctrl+Shift+F'),
        runItem('全セール収集',                    'fullscan_sale',  'Ctrl+Shift+S'),
      ],
    },
    {
      label: '表示',
      submenu: [
        { role: 'reload',     label: '再読み込み' },
        { role: 'toggleDevTools', label: '開発者ツール' },
        { type: 'separator' },
        { role: 'zoomIn',  label: '拡大' },
        { role: 'zoomOut', label: '縮小' },
        { role: 'resetZoom', label: 'ズームリセット' },
      ],
    },
  ]);
}

// ─── トレイ ───────────────────────────────────────────────────────────────────

function createTray() {
  _tray = new Tray(_buildTrayIcon());

  const rebuild = () => _tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: 'DLsite Price Tracker を開く',
      click: () => { if (_win) { _win.show(); _win.focus(); } else createWindow(); },
    },
    { type: 'separator' },
    { label: 'RJ収集',      click: () => _execJobSafe('discover') },
    { label: '価格更新',    click: () => _execJobSafe('fetch') },
    { label: 'セール優先',  click: () => _execJobSafe('saleboost') },
    { label: '全て巡回',    click: () => _execJobSafe('all') },
    { type: 'separator' },
    { label: '全収集（時間がかかります）', click: () => _execJobSafe('fullscan') },
    { type: 'separator' },
    {
      label: 'ブラウザで開く',
      click: () => shell.openExternal('http://127.0.0.1:7777'),
    },
    { type: 'separator' },
    { label: '終了', click: () => { app.isQuiting = true; app.quit(); } },
  ]));

  rebuild();
  _tray.setToolTip('DLsite Price Tracker');
  _tray.on('double-click', () => {
    if (_win) { _win.show(); _win.focus(); }
  });
}

async function _execJobSafe(job) {
  const sk = _JOB_TO_STATE[job] ?? job;
  if (_running[sk]) return;
  _running[sk] = true;
  _win?.webContents.send('crawler:started', { job });
  try { await _execJob(job); } catch (err) {
    console.error('[electron] tray job error', job, err.message);
  } finally {
    _running[sk] = false;
    _win?.webContents.send('crawler:done', { job, stats: db?.getStats() });
  }
}

// ─── app lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  await startBackend();
  _bindIpc();
  createTray();
  createWindow();
});

app.on('window-all-closed', () => { /* トレイに残す */ });
app.on('activate', () => { if (_win) _win.show(); });

// ─── tray icon ────────────────────────────────────────────────────────────────

function _buildTrayIcon() {
  const size = 16, buf = Buffer.alloc(size * size * 4);
  const cx = 7.5, cy = 7.5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      if (Math.hypot(x - cx, y - cy) < 7) {
        buf[i] = 59; buf[i+1] = 130; buf[i+2] = 246; buf[i+3] = 255;
      }
    }
  }
  return nativeImage.createFromBuffer(buf, { width: size, height: size });
}
