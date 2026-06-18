'use strict';

/**
 * crawler/db.js
 * SQLite access layer â sql.js (pure WASM, no native binaries).
 *
 * External API is identical to the better-sqlite3 version.
 * Internal implementation uses sql.js with manual file persistence.
 *
 * Persistence strategy:
 *   _save() is called after every mutating operation.
 *   On startup, the DB file is loaded from disk if it exists.
 *
 * Initialisation:
 *   await db.init()   â must be called once before any other function.
 *   db.open()         â returns the live Database instance (throws if not ready).
 */

const initSqlJs = require('sql.js');
const fs         = require('fs');
const path       = require('path');
const config     = require('../config');
const log        = require('./logger');

let _db      = null;   // sql.js Database instance
let _SQL     = null;   // sql.js namespace
// electron-builder portable exe ã§ã¯ PORTABLE_EXECUTABLE_DIR ã exe ã®ãã£ã¬ã¯ããªãæã
const _exeDir = process.env.DLSITE_DATA_DIR
  || process.env.PORTABLE_EXECUTABLE_DIR
  || process.cwd();
const DB_PATH = path.resolve(_exeDir, config.db.path);

// âââ init / open / close ââââââââââââââââââââââââââââââââââââââââââââââââââââ

/**
 * Async initialisation. Must be awaited once before any DB call.
 * Safe to call multiple times (idempotent).
 */
async function init() {
  if (_db) return;

  // Locate the WASM file correctly both in dev and inside a pkg exe.
  _SQL = await initSqlJs({
    locateFile: file => {
      // 1. electron-builder ã§ããã±ã¼ã¸ãããå ´åï¼æ¬çªexeï¼
      //    extraResources ã§ {resources}/sql-wasm.wasm ã«éç½®ããã
      if (process.resourcesPath) {
        return path.join(process.resourcesPath, file);
      }
      // 2. pkg ã§ããã±ã¼ã¸ãããå ´å
      if (process.pkg) {
        return path.join(path.dirname(process.execPath), file);
      }
      // 3. éçºç°å¢
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
function close() {
  if (_db) {
    _save();
    _db.close();
    _db = null;
    log.info('[db] closed');
  }
}

// âââ schema âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

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
      consecutive_no_change INTEGER DEFAULT 0,
      consecutive_errors    INTEGER DEFAULT 0
    );

    -- forward-only migration: æ¢å­ãã¼ãã«ã¸ã®ã«ã©ã è¿½å 
    CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY);

    CREATE TABLE IF NOT EXISTS price_history (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      rj_code       TEXT    NOT NULL,
      price         INTEGER,
      sale_price    INTEGER,
      point         INTEGER,
      discount_rate INTEGER,
      is_on_sale    INTEGER DEFAULT 0,
      is_point_only INTEGER DEFAULT 0,
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

  // æ¢å­DBã¸ã®å®å¨ãªã«ã©ã è¿½å  (IF NOT EXISTS ã¯ä½¿ããªãã®ã§try/catch)
  const migrations = [
    'ALTER TABLE works ADD COLUMN consecutive_errors INTEGER DEFAULT 0',
  ];
  for (const sql of migrations) {
    try { _db.run(sql); log.info('[db] migrated:', sql.slice(0, 60)); }
    catch (_) { /* already exists */ }
  }
}

// âââ low-level query helpers âââââââââââââââââââââââââââââââââââââââââââââââââ

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
 * åçºãã¥ã¼ãã¼ã·ã§ã³ï¼å³æä¿å­ï¼ã
 * ãããå¦çã«ã¯ runInTransaction() ãä½¿ããã¨ã
 */
function _run(sql, params = []) {
  const stmt = _db.prepare(sql);
  stmt.bind(params);
  stmt.step();
  stmt.free();
  // _save() ã¯å¼ã°ãªã: transaction() ã¾ãã¯æç¤ºç save() ã§å¶å¾¡
}

/** è¤æ°ã® _run ãã²ã¨ã¾ã¨ãã«ãã¦æå¾ã«1åã ãä¿å­ã */
function transaction(fn) {
  _db.run('BEGIN');
  try {
    fn();
    _db.run('COMMIT');
    _save();
  } catch (err) {
    try { _db.run('ROLLBACK'); } catch (_) {}
    log.error('[db] transaction rolled back:', err.message);
    throw err;
  }
}

/**
 * è¤æ°ãã¥ã¼ãã¼ã·ã§ã³ããã©ã³ã¶ã¯ã·ã§ã³ã§ã©ãããæå¾ã«1åã ãä¿å­ã
 * @param {Function} fn  dbæä½ãè¡ãåæé¢æ°
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
  _save();   // â 1åã ã
}


/** Persist the in-memory DB to disk. Called after every mutation. */
function _save() {
  try {
    const data = _db.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
  } catch (err) {
    log.error('[db] _save failed', err.message, 'path:', DB_PATH);
  }
}

// âââ works ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

function upsertWork(w) {
  _run(`
    INSERT INTO works
      (rj_code, title, circle, maker_id, work_type, site_id,
       release_date, dl_count, first_seen)
    VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(rj_code) DO UPDATE SET
      title        = COALESCE(excluded.title,        works.title),
      circle       = COALESCE(excluded.circle,       works.circle),
      maker_id     = COALESCE(excluded.maker_id,     works.maker_id),
      work_type    = COALESCE(excluded.work_type,    works.work_type),
      site_id      = COALESCE(excluded.site_id,      works.site_id),
      release_date = COALESCE(excluded.release_date, works.release_date),
      dl_count     = COALESCE(excluded.dl_count,     works.dl_count)
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
      consecutive_no_change = ?,
      consecutive_errors    = ?
    WHERE rj_code = ?
  `, [
    unixNow(),
    fields.check_interval,
    fields.priority,
    fields.is_on_sale,
    fields.consecutive_no_change ?? 0,
    fields.consecutive_errors    ?? 0,
    rjCode,
  ]);
}

/** A: ãã§ããã¨ã©ã¼è¨é²ãé£ç¶ã¨ã©ã¼æ°ã«å¿ãã¦intervalãå»¶ã°ãã */
function recordFetchError(rjCode) {
  const w = getWorkByRj(rjCode);
  if (!w) return;
  const errs = (w.consecutive_errors ?? 0) + 1;
  // 5åé£ç¶ã¨ã©ã¼â72h, 10åâ7æ¥ ã§ã»ã¼åæ­¢
  const interval = errs >= 10 ? 7 * 86400
                 : errs >=  5 ? 3 * 86400
                 : w.check_interval ?? 86400;
  _run(`
    UPDATE works SET
      last_checked       = ?,
      consecutive_errors = ?,
      check_interval     = ?
    WHERE rj_code = ?
  `, [unixNow(), errs, interval, rjCode]);
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

/**
 * サークル巡回用: セール中を優先、残りは最近チェックされていないサークルを選ぶ
 * → 全サークルをローテーションする
 */
function getCirclesForDiscovery(limit = 30) {
  const rows = _all(`
    SELECT w.maker_id,
           MAX(c.on_sale)       AS on_sale,
           MIN(w.last_checked)  AS earliest_checked
    FROM works w
    LEFT JOIN circles c ON c.maker_id = w.maker_id
    WHERE w.maker_id IS NOT NULL
    GROUP BY w.maker_id
    ORDER BY on_sale DESC, earliest_checked ASC
    LIMIT ?
  `, [limit]);
  return rows.map(r => r.maker_id);
}

function boostCircleWorks(makerId, priority, checkInterval) {
  _run(`
    UPDATE works
    SET priority = ?, check_interval = ?
    WHERE maker_id = ?
  `, [priority, checkInterval, makerId]);
}

/** â¡ ã»ã¼ã«çµäº: ãµã¼ã¯ã«å¨ä½åã®åªååº¦ã¨ééãéå¸¸å¤ã«æ»ã */
function resetCircleWorksPriority(makerId, priority, checkInterval) {
  _run(`
    UPDATE works
    SET priority = ?, check_interval = ?
    WHERE maker_id = ?
  `, [priority, checkInterval, makerId]);
}

// âââ price_history ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

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
    last.point         !== (priceData.point         ?? null) ||
    last.is_on_sale    !== (priceData.is_on_sale    ?? 0)    ||
    last.is_point_only !== (priceData.is_point_only ?? 0);

  if (!changed) return false;

  _run(`
    INSERT INTO price_history
      (rj_code, price, sale_price, point, discount_rate, is_on_sale, is_point_only, checked_at)
    VALUES (?,?,?,?,?,?,?,?)
  `, [
    rjCode,
    priceData.price         ?? null,
    priceData.sale_price    ?? null,
    priceData.point         ?? null,
    priceData.discount_rate ?? null,
    priceData.is_on_sale    ?? 0,
    priceData.is_point_only ?? 0,
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

// âââ circles ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

function upsertCircle(makerId, circleName) {
  _run(`
    INSERT INTO circles (maker_id, circle_name, works_count)
    VALUES (?,?,1)
    ON CONFLICT(maker_id) DO UPDATE SET
      circle_name = excluded.circle_name
  `, [makerId, circleName]);
}

/** works ãã¼ãã«ã®maker_idå¥ä»¶æ°ã§circlesãåæï¼æ­£ç¢ºãªworks_countï¼ */
function syncCircleWorksCounts() {
  _run(`
    UPDATE circles SET works_count = (
      SELECT COUNT(*) FROM works WHERE works.maker_id = circles.maker_id
    )
  `, []);
  _save();
}

/** â  schedulerç¨: on_sale=1 ã®ãµã¼ã¯ã«ä¸è¦§ãè¿ãï¼sql.jså¯¾å¿ï¼ */
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

// âââ stats ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

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

// âââ backup ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

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

// âââ export (for CSV/JSON API) âââââââââââââââââââââââââââââââââââââââââââââââ

/**
 * Export all price_history rows joined with work metadata.
 * Returns an array of plain objects.
 */
function exportAllHistory() {
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

// âââ UI query helpers âââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

/**
 * Paginated works list with latest price joined.
 * Used by apiServer /api/works
 */
function searchWorks({ q = '', sort = 'priority', onSale = false, page = 1, limit = 50 } = {}) {
  const offset = (Math.max(1, page) - 1) * limit;

  const sortMap = {
    priority: 'w.priority DESC, w.last_checked DESC',
    discount: 'COALESCE(ph.discount_rate, 0) DESC',
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

  // latest_price ã WITHå¥ã§äºåéè¨ã ã³ãªã¬ã¼ããµãã¯ã¨ãªãæé¤
  const cte = `
    WITH latest_price AS (
      SELECT rj_code, MAX(id) AS max_id
      FROM price_history GROUP BY rj_code
    )
  `;
  const joins = `
    FROM works w
    LEFT JOIN latest_price lp ON lp.rj_code = w.rj_code
    LEFT JOIN price_history ph ON ph.id = lp.max_id
    WHERE 1=1 ${where}
  `;

  const total = (_get(
    `${cte} SELECT COUNT(*) AS n ${joins}`,
    params
  ) ?? { n: 0 }).n;

  const works = _all(
    `${cte} SELECT w.*, ph.price, ph.sale_price, ph.discount_rate, ph.is_point_only, ph.checked_at AS ph_checked_at ${joins} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
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
      SELECT rj_code, price, sale_price, discount_rate, point, is_point_only, checked_at
      FROM price_history WHERE id IN (SELECT MAX(id) FROM price_history GROUP BY rj_code)
    )
    SELECT w.rj_code, w.title, w.circle, w.maker_id,
           ph.price, ph.sale_price, ph.discount_rate, ph.is_point_only, ph.checked_at
    FROM works w
    JOIN latest_ph ph ON ph.rj_code = w.rj_code
    WHERE w.is_on_sale = 1
    ORDER BY COALESCE(ph.discount_rate, 0) DESC, ph.price ASC
    LIMIT ?
  `, [limit]);
}



function unixNow() {
  return Math.floor(Date.now() / 1000);
}

/** å¨RJã³ã¼ããSetã§è¿ãï¼discoveryé«éç§åç¨ï¼ */
function getAllRjCodes() {
  return new Set(_all('SELECT rj_code FROM works').map(r => r.rj_code));
}

module.exports = {
  init,
  close,
  runInTransaction,
  upsertWork,
  markChecked,
  recordFetchError,
  getDueWorks,
  getWorkByRj,
  getAllMakerIds,
  getCirclesForDiscovery,
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
