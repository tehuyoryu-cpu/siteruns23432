'use strict';

/**
 * crawler/scheduler.js
 * Orchestrates discovery + detail fetch using node-cron.
 *
 * Schedule:
 *   Every 6h  – discovery pass (find new RJ codes)
 *   Every 20m – detail pass (flush due-work queue)
 *   Every 10m – sale-boost pass (re-prioritise works in on-sale circles)
 *   Daily 03:00 – DB backup
 */

const cron   = require('node-cron');
const config = require('../config');
const db     = require('./db');
const log    = require('./logger');
const { runDiscovery, runFullScan } = require('./discovery');
const { runDetailFetch } = require('./detailFetcher');
const { runExportShards } = require('./exportShards');

// ─── discovery job ───────────────────────────────────────────────────────────

function _startDiscoveryJob() {
  cron.schedule(config.cron.discovery, async () => {
    if (!global._crawlerRunning) global._crawlerRunning = {};
    if (global._crawlerRunning.discovery) {
      log.warn('[scheduler] discovery still running, skip'); return;
    }
    // detail ロックと同様、所有者トークンを付与する。
    // 'all' ジョブが discovery ロックを横取りした場合に、ここの finally が
    // 横取りした側のロックを誤って解放してしまうバグを防ぐ。
    const myToken = Symbol('scheduler-discovery');
    global._crawlerRunning.discovery = true;
    global._crawlerRunning._discoveryOwner = myToken;
    try   { await runDiscovery(); }
    catch (err) { log.error('[scheduler] discovery error', err.message); }
    finally {
      if (global._crawlerRunning && global._crawlerRunning._discoveryOwner === myToken) {
        global._crawlerRunning.discovery = false;
        global._crawlerRunning._discoveryOwner = null;
      }
    }
  });
  log.info('[scheduler] discovery job scheduled', config.cron.discovery);
}

// ─── detail fetch job ────────────────────────────────────────────────────────

function _startDetailJob() {
  cron.schedule(config.cron.detail, async () => {
    if (!global._crawlerRunning) global._crawlerRunning = {};
    if (global._crawlerRunning.detail) {
      log.warn('[scheduler] detail still running, skip'); return;
    }
    // ロックに所有者トークンを付与する。
    // 'all'/'turbo' ジョブがこのロックを横取りした場合、ここで設定した
    // トークンと一致しなくなるため、finally で誤って解放してしまう
    // （= 横取りした側のロックを壊す）バグを防ぐ。
    const myToken = Symbol('scheduler-detail');
    global._crawlerRunning.detail                 = true;
    global._crawlerRunning._detailOwner           = myToken;
    global._crawlerRunning.schedulerDetailRunning = true;   // all-job の abort-wait が監視するフラグ
    try   {
      await runDetailFetch(500, {
        onProgress: ({ processed, priceChanges, total }) => {
          if (global._sseSend) global._sseSend('progress', { processed, priceChanges, total });
        },
      });
    }
    catch (err) { log.error('[scheduler] detail error', err.message); }
    finally {
      global._crawlerRunning.schedulerDetailRunning = false;
      // 自分が確保したロックの場合のみ解放する（横取りされていたら何もしない）
      if (global._crawlerRunning && global._crawlerRunning._detailOwner === myToken) {
        global._crawlerRunning.detail = false;
        global._crawlerRunning._detailOwner = null;
      }
    }
  });
  log.info('[scheduler] detail job scheduled', config.cron.detail);
}

// ─── sale-boost job ──────────────────────────────────────────────────────────

function _startSaleBoostJob() {
  cron.schedule(config.cron.saleBoost, () => {
    if (!global._crawlerRunning) global._crawlerRunning = {};
    if (global._crawlerRunning.saleBoost) return;
    global._crawlerRunning.saleBoost = true;
    try {
      const onSaleCircles = db.getCirclesOnSale();
      db.transaction(() => {
        for (const { maker_id } of onSaleCircles) {
          db.boostCircleWorks(
            maker_id,
            config.priority.circleOnSale,
            config.checkInterval.onSale
          );
        }
      });
      if (onSaleCircles.length > 0) {
        log.debug('[scheduler] re-boosted', onSaleCircles.length, 'circles');
      }
    } catch (err) {
      log.error('[scheduler] saleBoost error', err.message);
    } finally {
      if (global._crawlerRunning) global._crawlerRunning.saleBoost = false;
    }
  });
  log.info('[scheduler] saleBoost job scheduled', config.cron.saleBoost);
}

// ─── セッション定期再ウォームアップジョブ ─────────────────────────────────────
// バグ修正: warmUpSession()は起動時に1回だけ実行され、以降は
// detailFetcher.js の空応答サーキットブレーカー(5回連続空応答)が
// 発火したときだけ再実行される「事後対応」しか無かった。
// アプリを長時間起動しっぱなしにするとDLsite側の年齢確認Cookieが
// サイレントに失効することがあり、その場合は次に巡回ジョブが走るまで
// 誰も気づけず、診断ツールで手動確認して初めて発覚する(実際の事例:
// product/info/ajax が HTTP 200 + 空オブジェクトを返し続けていた)。
// 巡回の成否に関係なく、6時間ごとに無条件でセッションを再確立する
// 予防的ジョブを追加する。
function _startSessionRewarmJob() {
  cron.schedule('15 */6 * * *', async () => {
    if (typeof global._reWarmUpSession !== 'function') {
      log.warn('[scheduler] sessionRewarm skipped (no re-warmup hook, non-Electron context?)');
      return;
    }
    log.info('[scheduler] sessionRewarm start (periodic, preventive)');
    try {
      await global._reWarmUpSession();
      log.info('[scheduler] sessionRewarm done');
    } catch (err) {
      log.error('[scheduler] sessionRewarm error', err.message);
    }
  });
  log.info('[scheduler] sessionRewarm job scheduled (every 6h at :15)');
}

// ─── daily backup job ────────────────────────────────────────────────────────

function _startBackupJob() {
  cron.schedule('0 3 * * *', () => {
    try {
      db.backup();
      db.syncCircleWorksCounts();
    } catch (err) { log.error('[scheduler] backup error', err.message); }
  });
  log.info('[scheduler] backup job scheduled (daily 03:00)');
}

// ─── 拡張機能向けシャードエクスポートジョブ ───────────────────────────────────
// ブラウザ拡張(DLsite Score)へGitHub raw/jsDelivr経由で配信するスコアデータを
// 1日1回生成する。ローカルファイル生成のみ(pushはトークンが設定されている
// 場合のみ scripts/push-data-shards.js が行う。未設定なら安全にスキップされる)。
function _startExportShardsJob() {
  cron.schedule('30 4 * * *', async () => {
    try {
      const result = await runExportShards();
      log.info('[scheduler] exportShards done', result);
      try {
        const { main: pushDataShards } = require('../scripts/push-data-shards');
        await pushDataShards();
      } catch (pushErr) {
        log.error('[scheduler] push-data-shards error', pushErr.message);
      }
    } catch (err) {
      log.error('[scheduler] exportShards error', err.message);
    }
  });
  log.info('[scheduler] exportShards job scheduled (daily 04:30)');
}

// ─── 前月分フルスキャンジョブ ─────────────────────────────────────────────────
// 毎月2日 04:00 に前月リリース分の FSR 全ページをスキャンする。
// 通常の discovery は「今月分」だけを対象にしているため、月をまたいで
// アプリを起動していなかった場合に前月末リリースの作品が取りこぼされる
// 問題を防ぐ。
function _startPrevMonthScanJob() {
  cron.schedule('0 4 2 * *', async () => {
    if (!global._crawlerRunning) global._crawlerRunning = {};
    if (global._crawlerRunning.discovery) {
      log.warn('[scheduler] prevMonthScan skipped (discovery running)'); return;
    }
    const myToken = Symbol('scheduler-prev-month-scan');
    global._crawlerRunning.discovery = true;
    global._crawlerRunning._discoveryOwner = myToken;
    log.info('[scheduler] prevMonthScan start — scanning last month FSR');
    try {
      // 前月1日を計算
      const now  = new Date();
      const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const dateStr = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}-01`;
      const result = await runFullScan({
        sale: false, maxPages: 0,
        dateOverride: dateStr,   // discovery.js 側で参照（未実装の場合は無視される）
        onProgress: ({ site, page, found }) => {
          log.debug('[scheduler] prevMonthScan', { site, page, found });
        },
      });
      log.info('[scheduler] prevMonthScan done', result);
    } catch (err) {
      log.error('[scheduler] prevMonthScan error', err.message);
    } finally {
      if (global._crawlerRunning && global._crawlerRunning._discoveryOwner === myToken) {
        global._crawlerRunning.discovery = false;
        global._crawlerRunning._discoveryOwner = null;
      }
    }
  });
  log.info('[scheduler] prevMonthScan job scheduled (monthly 2nd 04:00)');
}

// ─── public API ──────────────────────────────────────────────────────────────

async function start() {
  log.info('[scheduler] starting');

  _startDiscoveryJob();
  _startDetailJob();
  _startSaleBoostJob();
  _startBackupJob();
  _startPrevMonthScanJob();
  _startExportShardsJob();
  _startSessionRewarmJob();

  log.info('[scheduler] running initial passes on startup');

  if (!global._crawlerRunning) global._crawlerRunning = {};

  // 重大バグ修正: 以前はここで既存ロックの有無を確認せず無条件に
  // global._crawlerRunning.discovery を上書きしていた。そのため、
  // アプリ起動直後にユーザーがUI等から手動でdiscoveryを開始していた場合、
  // ここの初回パスがそのロックを横取りして2つ目の runDiscovery() を
  // 並行起動してしまい、同じFSRページを二重に取得するバグがあった
  // （cronジョブ・apiServer.jsのhandleRunは元々このチェックを行っていた）。
  if (global._crawlerRunning.discovery) {
    log.warn('[scheduler] initial discovery skipped (already running)');
  } else {
    const myInitToken = Symbol('scheduler-initial-discovery');
    global._crawlerRunning.discovery = true;
    global._crawlerRunning._discoveryOwner = myInitToken;
    runDiscovery()
      .catch(err => log.error('[scheduler] initial discovery error', err.message))
      .finally(() => {
        if (global._crawlerRunning && global._crawlerRunning._discoveryOwner === myInitToken) {
          global._crawlerRunning.discovery = false;
          global._crawlerRunning._discoveryOwner = null;
        }
      });
  }

  setTimeout(() => {
    if (!global._crawlerRunning) global._crawlerRunning = {};
    if (global._crawlerRunning.detail) {
      log.warn('[scheduler] initial detail run skipped (already running)');
      return;
    }
    const myToken = Symbol('scheduler-initial-detail');
    global._crawlerRunning.detail                 = true;
    global._crawlerRunning._detailOwner           = myToken;
    global._crawlerRunning.schedulerDetailRunning = true;
    runDetailFetch(500, {
      onProgress: ({ processed, priceChanges, total }) => {
        if (global._sseSend) global._sseSend('progress', { processed, priceChanges, total });
      },
    })
      .catch(err => log.error('[scheduler] initial detail error', err.message))
      .finally(() => {
        global._crawlerRunning.schedulerDetailRunning = false;
        if (global._crawlerRunning && global._crawlerRunning._detailOwner === myToken) {
          global._crawlerRunning.detail = false;
          global._crawlerRunning._detailOwner = null;
        }
      });
  }, 5000);
}

function stop() {
  log.info('[scheduler] stopping');
}

module.exports = { start, stop };
