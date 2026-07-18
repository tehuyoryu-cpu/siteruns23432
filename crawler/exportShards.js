'use strict';

/**
 * crawler/exportShards.js
 *
 * ブラウザ拡張機能(DLsite Score)向けに、GitHub raw / jsDelivr CDN 経由で
 * 配信することを目的とした軽量スコアデータを生成する。
 *
 * 出力構造 (config.shards.dataDir 配下):
 *   manifest.json          — 生成メタ情報
 *   shards/NNNN.json       — サークル単位でハッシュ分散したワークデータ本体
 *   index/NN.json          — RJコード → shard番号 の対応表(RJコードでハッシュ分散)
 *
 * シャーディング方針:
 *   同一サークル(maker_id)は常に同じ shard に入る (fnv1a(maker_id) % dataShards)。
 *   これにより「サークル単位のセール開始/終了」で更新されるファイルが
 *   特定の shard に集中し、diffが小さく保たれる。
 *   maker_id が無い作品は rj_code をキーにフォールバックする。
 *
 *   拡張機能側はRJコードしか持たないため、RJ→shard番号の索引(index/)を
 *   別途引く必要がある。索引はRJコード自体でハッシュ分散し(1本の巨大ファイル化を防ぐ)、
 *   拡張機能側は同じハッシュ関数(fnv1a)をJSで実装して索引shardを特定する。
 *
 * このモジュールはローカルファイル生成のみを行い、GitHubへの push は
 * scripts/push-data-shards.js（別モジュール、トークンが必要）が担当する。
 * トークン管理をこのモジュールに持ち込まないことで、exportShards単体は
 * 常に安全に（副作用なく）実行できる。
 */

const fs     = require('fs');
const path   = require('path');
const config = require('../config');
const log    = require('./logger');
const db     = require('./db');

const DATA_SHARDS = config.shards?.dataShards ?? 1024;
const IDX_SHARDS   = config.shards?.idxShards   ?? 64;
const RECENT_LOG_N = config.shards?.recentLogSize ?? 8;
const OUT_DIR      = path.resolve(
  process.env.DLSITE_DATA_DIR || process.cwd(),
  config.shards?.dataDir ?? './data-export'
);

// ─── ハッシュ関数 (FNV-1a 32bit) ──────────────────────────────────────────────
// 拡張機能側(background.js)でも同一実装をJSで持たせ、索引shard番号を
// クライアント側で計算できるようにする。Node/ブラウザどちらでも依存なしで動く。
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function shardOf(key, n) {
  return fnv1a(String(key)) % n;
}

// ─── メインエクスポート処理 ──────────────────────────────────────────────────

async function runExportShards() {
  const t0 = Date.now();
  log.info('[exportShards] start', { dataShards: DATA_SHARDS, idxShards: IDX_SHARDS, outDir: OUT_DIR });

  const base = _loadBaseWorks();
  if (!base.length) {
    log.warn('[exportShards] no works with price data, skip');
    return { works: 0, dataShards: 0, idxShards: 0 };
  }

  const discountDaysMap = _loadDiscountDays();
  const lowestMap        = _loadLowestPrices();
  const recentLogMap     = _loadRecentLogs();
  const compiledSet      = _loadCompiledRjSet();

  // shard_id -> { rj: entry }
  const dataShards = Array.from({ length: DATA_SHARDS }, () => ({}));
  // idx_shard_id -> { rj: shard_id }
  const idxShards  = Array.from({ length: IDX_SHARDS }, () => ({}));

  for (const w of base) {
    const rj = w.rj_code;

    const entry = { p: w.price };
    if (w.sale_price     != null) entry.s  = w.sale_price;
    if (w.discount_rate  != null) entry.d  = w.discount_rate;
    if (w.is_on_sale)              entry.os = 1;
    if (w.is_point_only)           entry.po = 1;

    const dd = discountDaysMap.get(rj);
    if (dd) entry.dd = dd;

    const lp = lowestMap.get(rj);
    if (lp != null && lp !== w.price) entry.lp = lp;

    const log_ = recentLogMap.get(rj);
    if (log_ && log_.length) entry.lg = log_;

    if (compiledSet.has(rj)) entry.c = 1;

    const shardKey = w.maker_id || rj;
    const shardId  = shardOf(shardKey, DATA_SHARDS);
    dataShards[shardId][rj] = entry;

    const idxId = shardOf(rj, IDX_SHARDS);
    idxShards[idxId][rj] = shardId;
  }

  const written = _writeOutput(dataShards, idxShards, base.length);

  const ms = Date.now() - t0;
  log.info('[exportShards] done', { works: base.length, ...written, ms });
  return { works: base.length, ...written, ms };
}

// ─── DBクエリ群 ──────────────────────────────────────────────────────────────
// 実クエリは db.js 側の専用エクスポート関数に持たせ、ここでは呼ぶだけにする
// (このモジュールがDB内部実装(_all等)に直接依存しないようにするため)。

function _loadBaseWorks() {
  return db.getExportBaseWorks();
}

function _loadDiscountDays() {
  return db.getDiscountDaysMap();
}

function _loadLowestPrices() {
  return db.getLowestPriceMap();
}

/**
 * 直近 RECENT_LOG_N 件の実質価格ログ(新しい順)。
 * トレンド計算(content.js の calcScore と同じ用途)に使う。
 * sql.js の SQLite が window function 未対応のビルドだった場合に備え、
 * 失敗時は空マップにフォールバックする(致命的にしない)。
 */
function _loadRecentLogs() {
  try {
    return db.getRecentPriceLogMap(RECENT_LOG_N);
  } catch (e) {
    log.warn('[exportShards] recentLog query failed (window function unsupported?), skipping', e.message);
    return new Map();
  }
}

/**
 * 総集編に収録されている作品RJのSet（バッジ表示用）。
 * compScan.js が comp_works テーブルに書き込んだ確定分のみを対象とする
 * (comp_pending の未確定推定は含めない)。
 * price未取得(cur_price IS NULL)の作品は base側でそもそもshardに載らないため、
 * その場合はバッジも一時的に表示されない(価格取得後の次回export以降に反映される)。
 */
function _loadCompiledRjSet() {
  try {
    return new Set(db.getAllCompiledRjs());
  } catch (e) {
    log.warn('[exportShards] compiled RJ set query failed, skipping', e.message);
    return new Set();
  }
}

// ─── ファイル出力 ────────────────────────────────────────────────────────────

function _writeOutput(dataShards, idxShards, totalWorks) {
  const shardsDir = path.join(OUT_DIR, 'shards');
  const idxDir    = path.join(OUT_DIR, 'index');
  fs.mkdirSync(shardsDir, { recursive: true });
  fs.mkdirSync(idxDir,    { recursive: true });

  // 既存の出力を一度クリアしてから書き直す(空になったshardの残骸を残さないため)
  for (const dir of [shardsDir, idxDir]) {
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.json')) fs.unlinkSync(path.join(dir, f));
    }
  }

  let writtenShards = 0;
  dataShards.forEach((obj, i) => {
    if (!Object.keys(obj).length) return; // 空shardは書かない
    const name = String(i).padStart(4, '0') + '.json';
    fs.writeFileSync(path.join(shardsDir, name), JSON.stringify(obj));
    writtenShards++;
  });

  let writtenIdx = 0;
  idxShards.forEach((obj, i) => {
    if (!Object.keys(obj).length) return;
    const name = String(i).padStart(2, '0') + '.json';
    fs.writeFileSync(path.join(idxDir, name), JSON.stringify(obj));
    writtenIdx++;
  });

  const manifest = {
    generatedAt: new Date().toISOString(),
    totalWorks,
    dataShards: DATA_SHARDS,
    idxShards:  IDX_SHARDS,
    writtenDataShards: writtenShards,
    writtenIdxShards:  writtenIdx,
    hashAlgo: 'fnv1a-32',
    recentLogSize: RECENT_LOG_N,
    schema: {
      p:  'price (定価)',
      s:  'sale_price (セール価格, null省略)',
      d:  'discount_rate (%, null省略)',
      os: 'is_on_sale (1のときのみ存在)',
      po: 'is_point_only (1のときのみ存在)',
      dd: '直近365日のセール日数 (0のときは省略)',
      lp: '過去最安値 (定価と同額なら省略)',
      lg: '直近価格ログ、新しい順 (空なら省略)',
      c:  '総集編に収録されている場合のみ 1 (comp_works確定分のみ、未収録時は省略)',
    },
  };
  fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));

  return { dataShardFiles: writtenShards, idxShardFiles: writtenIdx };
}

module.exports = { runExportShards, fnv1a, shardOf, DATA_SHARDS, IDX_SHARDS, OUT_DIR };
