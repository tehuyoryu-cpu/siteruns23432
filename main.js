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
 *   node main.js --rj=RJ123456   – fetch one specific RJ code（DB書き込みあり）
 *   node main.js --rj=RJ123456 --dry-run [--site=maniax]
 *                                  – 生API取得→parseProductInfo結果とpriceIssue判定のみ表示。
 *                                    DBへの接続・書き込みは一切行わない（単体RJの動作確認用）
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

/**
 * 機能追加⑤: ドライランモード。DBのinit/close/read/writeを一切行わず、
 * product/info/ajax の生取得 → parser.parseProductInfo() の結果のみを
 * 表示する。単体RJの価格パースロジック確認をDBに触れずに行いたい場合
 * （price/point_rate調査など）に使う。
 */
async function _dryRunRj(rjCode, site) {
  const parser = require('./crawler/parser');
  const config = require('./config');
  const { fetchWithRetry } = require('./crawler/queue');

  const validSites = new Set(config.dlsite.validSiteIds ?? ['maniax', 'girls', 'home', 'bl', 'pro']);
  if (!validSites.has(site)) {
    console.error(`[dry-run] 不明なsite: ${site}（有効: ${[...validSites].join(', ')}）`);
    process.exitCode = 1;
    return;
  }

  const url = `${config.dlsite.baseUrl}/${site}/product/info/ajax?product_id%5B%5D=${encodeURIComponent(rjCode)}`;
  console.log(`[dry-run] fetching ${url}`);

  let res;
  try {
    res = await fetchWithRetry(url, { headers: { Accept: 'application/json, */*' } });
  } catch (e) {
    console.error('[dry-run] fetch error:', e.message);
    process.exitCode = 1;
    return;
  }
  console.log(`[dry-run] HTTP ${res.status}`);

  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch (e) {
    console.error('[dry-run] JSON parse失敗:', e.message);
    console.log(text.slice(0, 1000));
    process.exitCode = 1;
    return;
  }

  console.log('[dry-run] raw response keys:', Object.keys(body));

  const parsed = parser.parseProductInfo(rjCode, body);
  if (!parsed) {
    console.error('[dry-run] parseProductInfo失敗（上記rawレスポンスを確認してください）');
    process.exitCode = 1;
    return;
  }

  console.log('\n=== work ===');
  console.log(JSON.stringify(parsed.work, null, 2));
  console.log('\n=== price ===');
  console.log(JSON.stringify(parsed.price, null, 2));
  console.log('\n=== priceIssue ===');
  console.log(parsed.priceIssue ? JSON.stringify(parsed.priceIssue, null, 2) : '(なし — 定価取得に問題なし)');
  console.log('\n※ドライランのためDBへの接続・書き込みは一切行っていません');
}

async function main() {
  log.info('[main] DLsite price tracker start', { args });

  const mode = args.mode;
  const rj   = args.rj;

  // ドライランはDB初期化より前に分岐させる（db.init()すら呼ばない）
  if (rj && args['dry-run']) {
    const code = String(rj).toUpperCase();
    const site = args.site ? String(args.site) : 'maniax';
    await _dryRunRj(code, site);
    return;
  }

  await db.init();

  if (rj) {
    const code = String(rj).toUpperCase();
    log.info('[main] single fetch', code);
    const changed = await fetchAndStore(code);
    log.info('[main] done', { rj: code, priceChanged: changed });
    _printStats();
    await db.close();
    return;
  }

  if (mode === 'status') {
    _printStats();
    await db.close();
    return;
  }

  if (mode === 'discover') {
    const result = await runDiscovery();
    log.info('[main] discovery result', result);
    _printStats();
    await db.close();
    return;
  }

  if (mode === 'fetch') {
    const result = await runDetailFetch(50);
    log.info('[main] fetch result', result);
    _printStats();
    await db.close();
    return;
  }

  if (mode === 'export-shards') {
    const result = await runExportShards();
    log.info('[main] export-shards result', result);
    if (args.push) {
      const { main: pushDataShards } = require('./scripts/push-data-shards');
      await pushDataShards();
    }
    await db.close();
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

async function _shutdown() {
  log.info('[main] shutting down');
  await db.close();
  process.exit(0);
}

main().catch(async err => {
  log.error('[main] fatal error', err.message, err.stack);
  await db.close();
  process.exit(1);
});
