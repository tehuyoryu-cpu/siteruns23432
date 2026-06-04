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
const { runDiscovery }   = require('./discovery');
const { runDetailFetch } = require('./detailFetcher');

const _running = {
  discovery: false,
  detail:    false,
  saleBoost: false,
};

// ─── discovery job ───────────────────────────────────────────────────────────

function _startDiscoveryJob() {
  cron.schedule(config.cron.discovery, async () => {
    if (_running.discovery) { log.warn('[scheduler] discovery still running, skip'); return; }
    _running.discovery = true;
    try   { await runDiscovery(); }
    catch (err) { log.error('[scheduler] discovery error', err.message); }
    finally     { _running.discovery = false; }
  });
  log.info('[scheduler] discovery job scheduled', config.cron.discovery);
}

// ─── detail fetch job ────────────────────────────────────────────────────────

function _startDetailJob() {
  cron.schedule(config.cron.detail, async () => {
    if (_running.detail) { log.warn('[scheduler] detail still running, skip'); return; }
    _running.detail = true;
    try   { await runDetailFetch(30); }
    catch (err) { log.error('[scheduler] detail error', err.message); }
    finally     { _running.detail = false; }
  });
  log.info('[scheduler] detail job scheduled', config.cron.detail);
}

// ─── sale-boost job ──────────────────────────────────────────────────────────

function _startSaleBoostJob() {
  cron.schedule(config.cron.saleBoost, () => {
    if (_running.saleBoost) return;
    _running.saleBoost = true;
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
      _running.saleBoost = false;
    }
  });
  log.info('[scheduler] saleBoost job scheduled', config.cron.saleBoost);
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

// ─── public API ──────────────────────────────────────────────────────────────

async function start() {
  log.info('[scheduler] starting');

  _startDiscoveryJob();
  _startDetailJob();
  _startSaleBoostJob();
  _startBackupJob();

  log.info('[scheduler] running initial passes on startup');

  _running.discovery = true;
  runDiscovery()
    .catch(err => log.error('[scheduler] initial discovery error', err.message))
    .finally(() => { _running.discovery = false; });

  setTimeout(() => {
    _running.detail = true;
    runDetailFetch(50)
      .catch(err => log.error('[scheduler] initial detail error', err.message))
      .finally(() => { _running.detail = false; });
  }, 5000);
}

function stop() {
  log.info('[scheduler] stopping');
}

module.exports = { start, stop };
