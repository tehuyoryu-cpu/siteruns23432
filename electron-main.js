'use strict';

/**
 * electron-main.js
 * Electron main process.
 *
 * 起動フロー:
 *   1. DB init + HTTP APIサーバー起動
 *   2. BrowserWindow でダッシュボードを開く
 *   3. クローラースケジューラー起動
 *   4. システムトレイに常駐
 *
 * ウィンドウを閉じてもトレイに残り、クローラーは継続動作する。
 * トレイアイコン右クリック → 終了 で完全終了。
 */

const { app, BrowserWindow, Tray, Menu, nativeImage, shell } = require('electron');
const path = require('path');

// ─── backend ─────────────────────────────────────────────────────────────────

let _backendReady = false;

async function startBackend() {
  const db        = require('./crawler/db');
  const apiServer = require('./crawler/apiServer');
  const scheduler = require('./crawler/scheduler');

  await db.init();
  apiServer.start();

  // Give the HTTP server 300ms to bind before loading the window
  await new Promise(r => setTimeout(r, 300));
  _backendReady = true;

  // Start crawler in background (non-blocking)
  scheduler.start().catch(err => {
    console.error('[electron] scheduler error', err.message);
  });
}

// ─── window ──────────────────────────────────────────────────────────────────

let _win  = null;
let _tray = null;

function createWindow() {
  _win = new BrowserWindow({
    width:  1280,
    height: 820,
    minWidth:  900,
    minHeight: 600,
    title: 'DLsite Price Tracker',
    backgroundColor: '#f0f2f5',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  _win.loadURL('http://127.0.0.1:7777');

  _win.once('ready-to-show', () => {
    _win.show();
  });

  // ウィンドウを閉じてもトレイに残す（クローラーは継続）
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

function createTray() {
  // 16x16 PNG を nativeImage で作成（アイコンファイル不要）
  const icon = _buildTrayIcon();
  _tray = new Tray(icon);

  const menu = Menu.buildFromTemplate([
    {
      label: 'DLsite Price Tracker を開く',
      click: () => {
        if (_win) { _win.show(); _win.focus(); }
        else createWindow();
      },
    },
    { type: 'separator' },
    {
      label: 'ブラウザで開く',
      click: () => shell.openExternal('http://127.0.0.1:7777'),
    },
    { type: 'separator' },
    {
      label: '終了',
      click: () => {
        app.isQuiting = true;
        app.quit();
      },
    },
  ]);

  _tray.setContextMenu(menu);
  _tray.setToolTip('DLsite Price Tracker');
  _tray.on('double-click', () => {
    if (_win) { _win.show(); _win.focus(); }
  });
}

// ─── app lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  await startBackend();
  createTray();
  createWindow();
});

app.on('window-all-closed', () => {
  // macOS ではDockに残す; Windowsはトレイに残す（何もしない）
});

app.on('activate', () => {
  // macOS: Dockアイコンクリックでウィンドウを再表示
  if (_win) _win.show();
});

// ─── tray icon helper ─────────────────────────────────────────────────────────

function _buildTrayIcon() {
  // 16x16 RGBA バッファを手書きして nativeImage に変換
  const size   = 16;
  const buf    = Buffer.alloc(size * size * 4);
  const cx     = 7.5;
  const cy     = 7.5;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx  = (y * size + x) * 4;
      const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
      if (dist < 7) {
        buf[idx]     = 59;   // R
        buf[idx + 1] = 130;  // G
        buf[idx + 2] = 246;  // B
        buf[idx + 3] = 255;  // A
      }
      // else transparent
    }
  }

  return nativeImage.createFromBuffer(buf, { width: size, height: size });
}
