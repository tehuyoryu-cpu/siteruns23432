'use strict';

/**
 * crawler/db.js
 * SQLite access layer – sql.js (pure WASM, no native binaries).
 *
 * External API is identical to the better-sqlite3 version.
 * Internal implementation uses sql.js with manual file persistence.
 *
 * Persistence strategy:
 *   _save() is called after every mutating operation.
 *   On startup, the DB file is loaded from disk if it exists.
 *
 * Initialisation:
 *   await db.init()   – must be called once before any other function.
 *   db.open()         – returns the live Database instance (throws if not ready).
 */

const initSqlJs = require('sql.js');
const fs         = require('fs');
const path       = require('path');
const config     = require('../config');
const log        = require('./logger');

let _db      = null;   // sql.js Database instance
let _SQL     = null;   // sql.js namespace
const DB_PATH = path.resolve(config.db.path);

// ─── init / open / close ────────────────────────────────────────────────────

/**
 * Async initialisation. Must be awaited once before any DB call.
 * Safe to call multiple times (idempotent).
 */
async function init() {
  if (_db) return;

  // Locate the WASM file correctly both in dev and inside a pkg exe.
  _SQL = await initSqlJs({
    locateFile: file => {
      if (process.pkg) {
        // When running as pkg exe, WASM lives next to the executable.
        return path.join(path.dirname(process.execPath), file);
      }
      return path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', file);
    },
  });

  if (fs.existsSync(DB_PATH)) {
    const buf = fs.readFileSync(DB_PATH);
    _db = new _SQL.Database(buf);
    log.info('[db] loaded', DB_PATH);
  } else {
    _db = new _SQL.Database();
    log.info('[db] created', DB_PATH);
  }

  _applySchema();
  _save();
}

/** Returns the live sql.js Database. Throws if init() was not awaited. */
function open() {
  if (!_db) throw new Error('[db] not initialised – await db.init() first');
  return _db;
}

function close() {
  if (_db) {
    _save();
    _db.close();
    _db = null;
    log.info('[db] closed');
  }
}

// ─── schema ─────────────────────────────────────────────────────────────────

function _applySchema() {
  _db.run(`
    CREATE TABLE IF NOT EXISTS works (
      rj_code               TEXT    PRIMARY KEY,
      title                 TEXT,
      circle                TEXT,
      maker_id              TEXT,
      work_type             TEXT,
      site_id               TEXT    DEFAULT 'maniax',
      release_date          TEXT,
      dl_count              INTEGER DEFAULT 0,
      first_seen            INTEGER NOT NULL,
      last_checked          INTEGER DEFAULT 0,
      check_interval        INTEGER DEFAULT 86400,
      priority              INTEGER DEFAULT 20,
      is_on_sale            INTEGER DEFAULT 0,
      consecutive_no_change INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS price_history (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      rj_code       TEXT    NOT NULL,
      price         INTEGER,
      sale_price    INTEGER,
      point         INTEGER,
      discount_rate INTEGER,
      checked_at    INTEGER NOT NULL,
      FOREIGN KEY (rj_code) REFERENCES works(rj_code)
    );

    CREATE TABLE IF NOT EXISTS circles (
      maker_id          TEXT PRIMARY KEY,
      circle_name       TEXT,
      on_sale           INTEGER DEFAULT 0,
      sale_detected_at  INTEGER,
      works_count       INTEGER DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_ph_rj       ON price_history(rj_code);
    CREATE INDEX IF NOT EXISTS idx_ph_at       ON price_history(checked_at);
    CREATE INDEX IF NOT EXISTS idx_works_maker ON works(maker_id);
  `);
}

// ─── low-level query helpers ─────────────────────────────────────────────────

/**
 * Execute a SELECT and return the first row as a plain object, or null.
 * @param {string} sql
 * @param {Array}  params  positional values matching ? placeholders
 */
function _get(sql, params = []) {
  const stmt = _db.prepare(sql);
  stmt.bind(params);
  const row = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();
  return row;
}

/**
 * Execute a SELECT and return all rows as plain objects.
 */
function _all(sql, params = []) {
  const stmt = _db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

/**
 * Execute an INSERT / UPDATE / DELETE, then persist to disk.
 */
/**
 * 単発ミューテーション（即時保存）。
 * バッチ処理には runInTransaction() を使うこと。
 */
function _run(sql, params = []) {
  const stmt = _db.prepare(sql);
  stmt.bind(params);
  stmt.step();
  stmt.free();
  // _save() は呼ばない: transaction() または明示的 save() で制御
}

/** 複数の _run をひとまとめにして最後に1回だけ保存。 */
function transaction(fn) {
  fn();
  _save();
}

/**
 * 複数ミューテーションをトランザクションでラップし最後に1回だけ保存。
 * @param {Function} fn  db操作を行う同期関数
 */
function runInTransaction(fn) {
  _db.run('BEGIN');
  try {
    fn();
    _db.run('COMMIT');
  } catch (err) {
    _db.run('ROLLBACK');
    throw err;
  }
  _save();   // ← 1回だけ
}

/**
 * トランザクション内用: 保存なしで実行。
 * runInTransaction() のコールバック内でのみ使う。
 */
function _runNoSave(sql, params = []) {
  const stmt = _db.prepare(sql);
  stmt.bind(params);
  stmt.step();
  stmt.free();
}

/** Persist the in-memory DB to disk. Called after every mutation. */
function _save() {
  const data = _db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

// ─── works ──────────────────────────────────────────────────────────────────

function upsertWork(w) {
  _run(`
    INSERT INTO works
      (rj_code, title, circle, maker_id, work_type, site_id,
       release_date, dl_count, first_seen)
    VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(rj_code) DO UPDATE SET
      title        = excluded.title,
      circle       = excluded.circle,
      maker_id     = excluded.maker_id,
      work_type    = excluded.work_type,
      site_id      = excluded.site_id,
      release_date = excluded.release_date,
      dl_count     = COALESCE(excluded.dl_count, works.dl_count)
  `, [
    w.rj_code, w.title, w.circle, w.maker_id, w.work_type,
    w.site_id, w.release_date, w.dl_count ?? 0, unixNow(),
  ]);
}

function markChecked(rjCode, fields) {
  _run(`
    UPDATE works SET
      last_checked          = ?,
      check_interval        = ?,
      priority              = ?,
      is_on_sale            = ?,
      consecutive_no_change = ?
    WHERE rj_code = ?
  `, [
    unixNow(),
    fields.check_interval,
    fields.priority,
    fields.is_on_sale,
    fields.consecutive_no_change,
    rjCode,
  ]);
}

function getDueWorks(limit = 50) {
  const now = unixNow();
  return _all(`
    SELECT * FROM works
    WHERE (last_checked + check_interval) <= ?
    ORDER BY priority DESC, (last_checked + check_interval) ASC
    LIMIT ?
  `, [now, limit]);
}

function getWorkByRj(rjCode) {
  return _get('SELECT * FROM works WHERE rj_code = ?', [rjCode]);
}

function getAllMakerIds() {
  return _all(
    'SELECT DISTINCT maker_id FROM works WHERE maker_id IS NOT NULL'
  ).map(r => r.maker_id);
}

function boostCircleWorks(makerId, priority, checkInterval) {
  _run(`
    UPDATE works
    SET priority = ?, check_interval = ?, is_on_sale = 1
    WHERE maker_id = ?
  `, [priority, checkInterval, makerId]);
}

/** ② セール終了: サークル全作品の優先度と間隔を通常値に戻す */
function resetCircleWorksPriority(makerId, priority, checkInterval) {
  _run(`
    UPDATE works
    SET priority = ?, check_interval = ?, is_on_sale = 0
    WHERE maker_id = ? AND is_on_sale = 1
  `, [priority, checkInterval, makerId]);
}

// ─── price_history ──────────────────────────────────────────────────────────

function getLatestPrice(rjCode) {
  return _get(`
    SELECT * FROM price_history
    WHERE rj_code = ?
    ORDER BY checked_at DESC
    LIMIT 1
  `, [rjCode]);
}

/**
 * Insert a price row only when the price has changed vs the last record.
 * Returns true if a row was inserted.
 */
function savePriceIfChanged(rjCode, priceData) {
  const last = getLatestPrice(rjCode);

  const changed =
    !last ||
    last.price         !== (priceData.price         ?? null) ||
    last.sale_price    !== (priceData.sale_price    ?? null) ||
    last.discount_rate !== (priceData.discount_rate ?? null) ||
    last.point         !== (priceData.point         ?? null);

  if (!changed) return false;

  _run(`
    INSERT INTO price_history
      (rj_code, price, sale_price, point, discount_rate, checked_at)
    VALUES (?,?,?,?,?,?)
  `, [
    rjCode,
    priceData.price         ?? null,
    priceData.sale_price    ?? null,
    priceData.point         ?? null,
    priceData.discount_rate ?? null,
    unixNow(),
  ]);

  return true;
}

function getPriceHistory(rjCode) {
  return _all(
    'SELECT * FROM price_history WHERE rj_code = ? ORDER BY checked_at ASC',
    [rjCode]
  );
}

// ─── circles ────────────────────────────────────────────────────────────────

function upsertCircle(makerId, circleName) {
  _run(`
    INSERT INTO circles (maker_id, circle_name, works_count)
    VALUES (?,?,1)
    ON CONFLICT(maker_id) DO UPDATE SET
      circle_name = excluded.circle_name
  `, [makerId, circleName]);
}

/** works テーブルのmaker_id別件数でcirclesを同期（正確なworks_count） */
function syncCircleWorksCounts() {
  _run(`
    UPDATE circles SET works_count = (
      SELECT COUNT(*) FROM works WHERE works.maker_id = circles.maker_id
    )
  `, []);
  _save();
}

/** ① scheduler用: on_sale=1 のサークル一覧を返す（sql.js対応） */
function getCirclesOnSale() {
  return _all('SELECT maker_id FROM circles WHERE on_sale = 1');
}

function markCircleOnSale(makerId, onSale) {
  _run(`
    UPDATE circles
    SET on_sale          = ?,
        sale_detected_at = CASE WHEN ? = 1 THEN ? ELSE sale_detected_at END
    WHERE maker_id = ?
  `, [onSale ? 1 : 0, onSale ? 1 : 0, unixNow(), makerId]);
}

function getCircle(makerId) {
  return _get('SELECT * FROM circles WHERE maker_id = ?', [makerId]);
}

// ─── stats ──────────────────────────────────────────────────────────────────

function getStats() {
  return {
    totalWorks:    _get('SELECT COUNT(*) AS n FROM works').n,
    onSale:        _get('SELECT COUNT(*) AS n FROM works WHERE is_on_sale = 1').n,
    priceChanges:  _get('SELECT COUNT(*) AS n FROM price_history').n,
    circlesOnSale: _get('SELECT COUNT(*) AS n FROM circles WHERE on_sale = 1').n,
    dueNow: _get(
      'SELECT COUNT(*) AS n FROM works WHERE (last_checked + check_interval) <= ?',
      [unixNow()]
    ).n,
  };
}

// ─── backup ──────────────────────────────────────────────────────────────────

/**
 * Save a timestamped copy of the DB file to ./backups/.
 * Called by the scheduler daily. Keeps last 30 backups.
 */
function backup() {
  if (!_db) return;
  try {
    const dir     = path.resolve(path.dirname(DB_PATH), 'backups');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const stamp   = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const dest    = path.join(dir, `dlsite-${stamp}.db`);
    const data    = _db.export();
    fs.writeFileSync(dest, Buffer.from(data));
    log.info('[db] backup saved', dest);

    // keep only the 30 most recent backups
    const files = fs.readdirSync(dir)
      .filter(f => f.startsWith('dlsite-') && f.endsWith('.db'))
      .sort()
      .reverse();
    for (const old of files.slice(30)) {
      fs.unlinkSync(path.join(dir, old));
      log.debug('[db] old backup removed', old);
    }
  } catch (err) {
    log.error('[db] backup error', err.message);
  }
}

// ─── export (for CSV/JSON API) ───────────────────────────────────────────────

/**
 * Export all price_history rows joined with work metadata.
 * Returns an array of plain objects.
 */
function exportAllHistory() {
  const db = open();
  return _all(`
    SELECT
      w.rj_code, w.title, w.circle, w.maker_id, w.work_type,
      w.release_date,
      p.price, p.sale_price, p.discount_rate, p.point, p.checked_at
    FROM price_history p
    JOIN works w ON p.rj_code = w.rj_code
    ORDER BY p.checked_at ASC
  `);
}

// ─── UI query helpers ─────────────────────────────────────────────────────────

/**
 * Paginated works list with latest price joined.
 * Used by apiServer /api/works
 */
function searchWorks({ q = '', sort = 'priority', onSale = false, page = 1, limit = 50 } = {}) {
  const offset = (Math.max(1, page) - 1) * limit;

  const sortMap = {
    priority: 'w.priority DESC, w.last_checked DESC',
    discount: 'ph.discount_rate DESC',
    price:    'ph.price ASC',
    checked:  'w.last_checked DESC',
    release:  'w.release_date DESC',
  };
  const orderBy = sortMap[sort] ?? sortMap.priority;

  let where  = onSale ? 'AND w.is_on_sale = 1 ' : '';
  const params = [];

  if (q) {
    where += 'AND (LOWER(w.rj_code) LIKE ? OR LOWER(COALESCE(w.title,\'\')) LIKE ? OR LOWER(COALESCE(w.circle,\'\')) LIKE ?) ';
    const like = '%' + q.toLowerCase() + '%';
    params.push(like, like, like);
  }

  // latest_price を WITH句で事前集計し コリレートサブクエリを排除
  const baseSql = `
    WITH latest_price AS (
      SELECT rj_code,
             MAX(checked_at) AS max_at
      FROM price_history GROUP BY rj_code
    )
    FROM works w
    LEFT JOIN latest_price lp ON lp.rj_code = w.rj_code
    LEFT JOIN price_history ph ON ph.rj_code = lp.rj_code AND ph.checked_at = lp.max_at
    WHERE 1=1 ${where}
  `;

  const total  = (_get(`SELECT COUNT(*) AS n ${baseSql}`, params) ?? { n: 0 }).n;
  const works  = _all(
    `SELECT w.*, ph.price, ph.sale_price, ph.discount_rate, ph.checked_at AS ph_checked_at ${baseSql}ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );

  return { works, total, page, pages: Math.ceil(total / limit) };
}

/**
 * Works currently on sale, sorted by discount rate desc.
 */
function getSaleWorks(limit = 200) {
  return _all(`
    WITH latest_ph AS (
      SELECT rj_code, price, sale_price, discount_rate, point, checked_at
      FROM price_history WHERE id IN (SELECT MAX(id) FROM price_history GROUP BY rj_code)
    )
    SELECT w.rj_code, w.title, w.circle, w.maker_id,
           ph.price, ph.sale_price, ph.discount_rate, ph.checked_at
    FROM works w
    JOIN latest_ph ph ON ph.rj_code = w.rj_code
    WHERE w.is_on_sale = 1 AND ph.discount_rate IS NOT NULL
    ORDER BY ph.discount_rate DESC
    LIMIT ?
  `, [limit]);
}



function unixNow() {
  return Math.floor(Date.now() / 1000);
}

/** セール中サークル一覧を返す（scheduler用） */
function getCirclesOnSale() {
  return _all('SELECT maker_id FROM circles WHERE on_sale = 1');
}

/** 全RJコードをSetで返す（discovery高速照合用） */
function getAllRjCodes() {
  return new Set(_all('SELECT rj_code FROM works').map(r => r.rj_code));
}

module.exports = {
  init,
  open,
  close,
  runInTransaction,
  upsertWork,
  markChecked,
  getDueWorks,
  getWorkByRj,
  getAllMakerIds,
  boostCircleWorks,
  resetCircleWorksPriority,
  getLatestPrice,
  savePriceIfChanged,
  getPriceHistory,
  upsertCircle,
  syncCircleWorksCounts,
  getCirclesOnSale,
  markCircleOnSale,
  getCircle,
  getCirclesOnSale,
  getStats,
  backup,
  transaction,
  save: _save,
  exportAllHistory,
  searchWorks,
  getSaleWorks,
  getAllRjCodes,
  unixNow,
};
