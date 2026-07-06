'use strict';

/**
 * main.js
 * Entry point.
 *
 * Usage:
 *   node main.js                  – daemon mode (scheduler + UI)
 *   node main.js --mode=ui        – UI only (no crawler)
 *   node main.js --mode=discover  – one-shot discovery run
 *   node main.js --mode=fetch     – one-shot detail fetch run
 *   node main.js --mode=status    – print DB stats and exit
 *   node main.js --rj=RJ123456   – fetch one specific RJ code
 */

const log       = require('./crawler/logger');
const db        = require('./crawler/db');
const scheduler = require('./crawler/scheduler');
const { start: startApiServer } = require('./crawler/apiServer');
const { runDiscovery }           = require('./crawler/discovery');
const { runDetailFetch, fetchAndStore } = require('./crawler/detailFetcher');
const { runExportShards }        = require('./crawler/exportShards');

const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  })
);

async function main() {
  log.info('[main] DLsite price tracker start', { args });

  await db.init();

  const mode = args.mode;
  const rj   = args.rj;

  if (rj) {
    const code = String(rj).toUpperCase();
    log.info('[main] single fetch', code);
    const changed = await fetchAndStore(code);
    log.info('[main] done', { rj: code, priceChanged: changed });
    _printStats();
    db.close();
    return;
  }

  if (mode === 'status') {
    _printStats();
    db.close();
    return;
  }

  if (mode === 'discover') {
    const result = await runDiscovery();
    log.info('[main] discovery result', result);
    _printStats();
    db.close();
    return;
  }

  if (mode === 'fetch') {
    const result = await runDetailFetch(50);
    log.info('[main] fetch result', result);
    _printStats();
    db.close();
    return;
  }

  if (mode === 'export-shards') {
    const result = await runExportShards();
    log.info('[main] export-shards result', result);
    if (args.push) {
      const { main: pushDataShards } = require('./scripts/push-data-shards');
      await pushDataShards();
    }
    db.close();
    return;
  }

  if (mode === 'ui') {
    startApiServer();
    log.info('[main] UI-only mode. Press Ctrl+C to stop.');
    process.on('SIGINT',  _shutdown);
    process.on('SIGTERM', _shutdown);
    return;
  }

  // daemon mode
  startApiServer();
  await scheduler.start();
  log.info('[main] daemon running – press Ctrl+C to stop');
  process.on('SIGINT',  _shutdown);
  process.on('SIGTERM', _shutdown);
}

function _printStats() {
  const stats = db.getStats();
  console.log('\n── DB Stats ──');
  console.log('  Total works tracked :', stats.totalWorks);
  console.log('  Currently on sale   :', stats.onSale);
  console.log('  Price change records:', stats.priceChanges);
  console.log('  Circles on sale     :', stats.circlesOnSale);
  console.log('  Due for check now   :', stats.dueNow);
  console.log('──────────────\n');
}

function _shutdown() {
  log.info('[main] shutting down');
  db.close();
  process.exit(0);
}

main().catch(err => {
  log.error('[main] fatal error', err.message, err.stack);
  db.close();
  process.exit(1);
});
