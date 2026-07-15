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
const crypto     = require('crypto');
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
    // sql.js/SQLite does not fully validate the file on open — a corrupted
    // page only throws 'database disk image is malformed' once a query
    // actually touches it. Without this check, the app appears to work
    // fine at startup and only fails unpredictably mid-job later (this is
    // exactly what happened: every job that touched a bad page rolled
    // back instantly, making 'all'/'endingsoon'/etc. look like they
    // "finished immediately" while actually crashing on their first write).
    // Run an explicit integrity check now so we can recover up front.
    if (!_checkIntegrity()) {
      log.error('[db] integrity check FAILED on load — attempting recovery');
      _db.close();
      _db = _recoverFromCorruption(buf);
    }
  } else {
    _db = new _SQL.Database();
    log.info('[db] created', DB_PATH);
  }

  const schemaChanged = _applySchema();
  if (schemaChanged) {
    log.info('[db] schema changed — saving...');
    await _saveNow();
    log.info('[db] save complete');
  }
}

/** Returns the live sql.js Database. Throws if init() was not awaited. */
async function close() {
  if (_db) {
    await _saveNow();
    _db.close();
    _db = null;
    log.info('[db] closed');
  }
}

/** true if PRAGMA integrity_check reports 'ok'. */
function _checkIntegrity() {
  try {
    const row = _db.exec('PRAGMA integrity_check');
    const val = row?.[0]?.values?.[0]?.[0];
    return val === 'ok';
  } catch (e) {
    log.error('[db] integrity_check threw', e.message);
    return false;
  }
}

/**
 * Recovery order when the loaded DB fails integrity_check:
 *   1. Quarantine the corrupt file (rename, never delete — for forensics).
 *   2. Try the newest verified backup (backups/*.db + matching .meta.json,
 *      sha256-checked via verifyBackup()).
 *   3. If no valid backup exists, start a fresh empty DB (data loss, but
 *      keeps the app usable instead of erroring on every job forever).
 */
function _recoverFromCorruption(corruptBuf) {
  const quarantineDir = path.resolve(path.dirname(DB_PATH), 'corrupted');
  try {
    fs.mkdirSync(quarantineDir, { recursive: true });
    const dest = path.join(quarantineDir, `dlsite-corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
    fs.writeFileSync(dest, corruptBuf);
    log.error('[db] corrupt file quarantined at', dest);
  } catch (e) {
    log.error('[db] failed to quarantine corrupt file', e.message);
  }

  const backupDir = path.resolve(path.dirname(DB_PATH), 'backups');
  let candidates = [];
  try {
    candidates = fs.readdirSync(backupDir)
      .filter(f => f.startsWith('dlsite-') && f.endsWith('.db'))
      .map(f => ({ name: f, full: path.join(backupDir, f) }))
      .sort((a, b) => b.name.localeCompare(a.name)); // newest first (timestamp in filename)
  } catch { /* no backups dir */ }

  for (const c of candidates) {
    const v = verifyBackup(c.full);
    if (!v.ok) {
      log.warn('[db] backup failed verification, skipping', c.name, v.reason);
      continue;
    }
    try {
      const buf = fs.readFileSync(c.full);
      const restored = new _SQL.Database(buf);
      const savedDb = _db;
      _db = restored;
      if (_checkIntegrity()) {
        log.error('[db] RECOVERED from backup', c.name, '— data since this backup is LOST, review corrupted/ and backups/ manually');
        return restored;
      }
      _db = savedDb;
      restored.close();
      log.warn('[db] backup also failed integrity_check, trying older one', c.name);
    } catch (e) {
      log.warn('[db] backup restore attempt failed', c.name, e.message);
    }
  }

  log.error('[db] NO usable backup found — starting with a fresh empty database. Manual recovery from corrupted/ may be possible.');
  return new _SQL.Database();
}

// âââ schema âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

function _applySchema() {
  let changed = false;
  console.log('[db] _applySchema: creating tables...');
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
      consecutive_errors    INTEGER DEFAULT 0,
      next_check_at         INTEGER DEFAULT 0
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
    'ALTER TABLE price_history ADD COLUMN is_on_sale    INTEGER DEFAULT 0',
    'ALTER TABLE price_history ADD COLUMN is_point_only INTEGER DEFAULT 0',
    'ALTER TABLE works ADD COLUMN next_check_at INTEGER DEFAULT 0',
    // 最新価格をworksに非正規化（price_history全件スキャンを回避し一覧表示を高速化）
    'ALTER TABLE works ADD COLUMN cur_price        INTEGER',
    'ALTER TABLE works ADD COLUMN cur_sale_price    INTEGER',
    'ALTER TABLE works ADD COLUMN cur_discount_rate INTEGER',
    'ALTER TABLE works ADD COLUMN cur_point         INTEGER',
    'ALTER TABLE works ADD COLUMN cur_is_point_only INTEGER DEFAULT 0',
    'ALTER TABLE works ADD COLUMN price_checked_at  INTEGER',
  ];


  for (const sql of migrations) {
    try {
      _db.run(sql);
      log.info('[db] migrated:', sql.slice(0, 60));
      changed = true;
      // next_check_at は新規カラムなので既存行に一度だけ初期値を入れる
      // (due 作品検索を計算式の全件スキャンからインデックス参照に変えるため)
      if (sql.includes('next_check_at')) {
        _db.run('UPDATE works SET next_check_at = last_checked + check_interval');
        log.info('[db] backfilled next_check_at for existing works');
      }
    }
    catch (_) { /* already exists */ }
  }

  // next_check_at カラムが(新規作成 or 上のALTERで)確実に存在する状態になった後でindexを作る。
  // CREATE TABLE 直後にまとめて作ると、既存DBでは ALTER 前にこの文が実行されてしまい
  // 「no such column: next_check_at」で起動が落ちるバグがあったため、ここに移動した。
  try {
    _db.run('CREATE INDEX IF NOT EXISTS idx_works_next_check ON works(next_check_at)');
    // getDueWorks の ORDER BY priority DESC, next_check_at ASC に対応した複合インデックス。
    // priority 単列は別途インデックスがないため、20万件規模でインメモリソートが発生していた。
    _db.run('CREATE INDEX IF NOT EXISTS idx_works_priority_next ON works(priority DESC, next_check_at ASC)');
  } catch (e) {
    log.error('[db] failed to create idx_works_next_check:', e.message);
  }
  // cur_* カラム(非正規化価格)が存在する状態になった後でソート用indexを作成
  try {
    _db.run('CREATE INDEX IF NOT EXISTS idx_works_cur_discount ON works(cur_discount_rate)');
    _db.run('CREATE INDEX IF NOT EXISTS idx_works_cur_price    ON works(cur_price)');
    _db.run('CREATE INDEX IF NOT EXISTS idx_works_on_sale      ON works(is_on_sale)');
  } catch (e) {
    log.error('[db] failed to create cur_* indexes:', e.message);
  }

  console.log('[db] _applySchema: running migrations...');
  // データマイグレーション: 旧バージョンが書き込んだ無効な site_id を maniax に統一
  // 'aix'/'appx' は廃止済みの DLsite サブドメイン。RJ コードは maniax API で取得可能。
  {
    const VALID = ['maniax', 'girls', 'home', 'bl', 'pro'];
    const ph    = VALID.map(() => '?').join(',');
    const stmt  = _db.prepare(`UPDATE works SET site_id = 'maniax' WHERE site_id NOT IN (${ph})`);
    stmt.bind(VALID);
    stmt.step();
    stmt.free();
    const rows = _db.getRowsModified();
    if (rows > 0) { log.info('[db] fixed invalid site_id -> maniax:', rows, '件'); changed = true; }
  }
  // ゴーストRJコード（末尾000パターン）の掃除
  // 旧discoveryバグでDBに混入したコードをDBから削除して無駄なAPIリクエストを止める
  try {
    const ghostStmt = _db.prepare(`DELETE FROM works WHERE rj_code GLOB 'RJ*000' OR rj_code GLOB 'RJ*0000' OR rj_code = 'RJ000000'`);
    ghostStmt.step();
    ghostStmt.free();
    const ghostRows = _db.getRowsModified();
    if (ghostRows > 0) {
      log.info('[db] removed ghost RJ codes (trailing 000):', ghostRows, '件');
      changed = true;
    }
  } catch (e) {
    console.error('[db] ghost cleanup error:', e.message);
  }

  // ゴーストRJコード（末尾が3桁以上の000、または全ゼロ）を180日退避
  // parser.jsの除外フィルタ追加前にDBに入ったものを一括クリーンアップ。
  // SQLiteはREGEXPを持たないため LIKE で近似マッチングする。
  {
    const FAR_FUTURE = unixNow() + 180 * 86400;
    const ghostSql   = `
      UPDATE works SET
        consecutive_errors = 99,
        check_interval     = ${180 * 86400},
        next_check_at      = ${FAR_FUTURE}
      WHERE (
        rj_code LIKE '%000'   OR rj_code LIKE '%0000'
        OR rj_code LIKE '%00000' OR rj_code LIKE 'RJ000000'
        OR rj_code LIKE 'RJ0000000' OR rj_code LIKE 'RJ00000000'
      ) AND consecutive_errors < 99
    `;
    _db.run(ghostSql);
    const ghostRows = _db.getRowsModified();
    if (ghostRows > 0) log.info('[db] ghost RJ codes quarantined:', ghostRows, '件');
  }

  // cur_price 非正規化カラムのバックフィル（既存DBの cur_price が NULL の作品のみ）
  try {
    const pending = _get(`SELECT COUNT(*) AS n FROM works WHERE cur_price IS NULL AND rj_code IN (SELECT rj_code FROM price_history)`);
    if (pending && pending.n > 0) {
      console.log('[db] backfilling cur_price for', pending.n, 'works...');
      _db.run(`
        UPDATE works SET
          cur_price        = (SELECT price         FROM price_history ph WHERE ph.rj_code = works.rj_code ORDER BY ph.checked_at DESC LIMIT 1),
          cur_sale_price    = (SELECT sale_price    FROM price_history ph WHERE ph.rj_code = works.rj_code ORDER BY ph.checked_at DESC LIMIT 1),
          cur_discount_rate = (SELECT discount_rate FROM price_history ph WHERE ph.rj_code = works.rj_code ORDER BY ph.checked_at DESC LIMIT 1),
          cur_point         = (SELECT point         FROM price_history ph WHERE ph.rj_code = works.rj_code ORDER BY ph.checked_at DESC LIMIT 1),
          cur_is_point_only = (SELECT is_point_only FROM price_history ph WHERE ph.rj_code = works.rj_code ORDER BY ph.checked_at DESC LIMIT 1),
          price_checked_at  = (SELECT checked_at    FROM price_history ph WHERE ph.rj_code = works.rj_code ORDER BY ph.checked_at DESC LIMIT 1)
        WHERE cur_price IS NULL AND rj_code IN (SELECT rj_code FROM price_history)
      `);
      console.log('[db] backfill complete');
      changed = true;
    }
  } catch (e) {
    console.error('[db] backfill error:', e.message);
  }

  console.log('[db] _applySchema: done, changed='+changed);
  return changed;
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
  if (!_db) throw new Error('[db] transaction() called but _db is null (DB not initialized or already closed)');
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
 * transaction() と同じだが _save() を呼ばない。
 * sql.js の保存は export()+writeFileSync で DB 全体を毎回シリアライズし直すため、
 * 大量バッチ処理で毎回呼ぶと件数に比例して遅くなる。呼び出し側で save() の
 * タイミングを間引けるようにするためのバリエーション。
 * （クラッシュ時は直前の明示的な save() 地点まで巻き戻る）
 */
function transactionNoSave(fn) {
  if (!_db) throw new Error('[db] transactionNoSave() called but _db is null (DB not initialized or already closed)');
  _db.run('BEGIN');
  try {
    fn();
    _db.run('COMMIT');
  } catch (err) {
    try { _db.run('ROLLBACK'); } catch (_) {}
    log.error('[db] transactionNoSave rolled back:', err.message);
    throw err;
  }
}

/**
 * è¤æ°ãã¥ã¼ãã¼ã·ã§ã³ããã©ã³ã¶ã¯ã·ã§ã³ã§ã©ãããæå¾ã«1åã ãä¿å­ã
 * @param {Function} fn  dbæä½ãè¡ãåæé¢æ°
 */
function runInTransaction(fn) {
  if (!_db) throw new Error('[db] runInTransaction() called but _db is null (DB not initialized or already closed)');
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


/**
 * Persist the in-memory DB to disk. Debounced, and the actual disk write is
 * asynchronous (non-blocking).
 *
 * 重大バグ修正: 実測ログで export() 自体は35〜120msと高速な一方、
 * save全体としては最大12秒かかるケースがあった。原因は
 * `fs.writeFileSync()` で150MB超のファイルを同期書き込みしていたこと。
 * Node/Electronはシングルスレッドのため、この間はネットワークリクエストや
 * 他のタイマー・巡回処理が完全に停止する。「巡回が途中で止まって見える」
 * 症状の主因はこれだったと考えられる。fs.promises.writeFile による
 * 非同期書き込みに変更し、書き込み中も他の処理をブロックしないようにした。
 * また、書き込み中にクラッシュ/強制終了するとDBファイルが不完全な状態で
 * 上書きされ全損しうるため、一時ファイルに書いてからrenameする方式
 * （renameはファイルシステム上ほぼ原子的）に変更し、安全性も同時に高めた。
 * 加えて、書き込み中に次のsaveが呼ばれても多重に走らないようガードする。
 */
let _saveTimer = null;

// 重大バグ修正(DB破損の主因と推定): 以前は debounced _doSaveAsync()（非同期、
// tmpファイルへの書き込み中）と _saveNow()（同期、close()/終了処理から
// 直接呼ばれる）が同じ DB_PATH+'.tmp' へ独立に書き込みうる構造だった。
// アプリ終了時に「非同期saveがtmpへ書き込み中」のタイミングで _saveNow() の
// 同期書き込みが同じパスに割り込むと、2つの書き込みが同一ファイルへ
// 交差し、どちらのrename()が最後に勝つかも不定になる。結果、サイズや
// ページ構造が破損した .db が本番パスへrenameされうる。これが実際に
// 観測された「database disk image is malformed」（起動直後は正常に見えて、
// 破損したページに触れるまで気づかない）の主因と推定される。
// 全ての書き込みを単一の Promise チェーンで直列化し、常に「前の書き込みが
// 完全に終わってから次を始める」ことを保証する。
let _saveChain = Promise.resolve();

function _save() {
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    _saveChain = _saveChain.then(_writeDbFile).catch(e => log.error('[db] save error:', e.message));
  }, 3000);
}

async function _writeDbFile() {
  const t0   = Date.now();
  const data = _db.export();
  const tExport = Date.now() - t0;
  const tmpPath = DB_PATH + '.tmp';
  await fs.promises.writeFile(tmpPath, Buffer.from(data));
  await fs.promises.rename(tmpPath, DB_PATH);
  const tTotal = Date.now() - t0;
  if (tTotal > 1000) {
    log.warn('[db] save slow:', tTotal + 'ms', `(export ${tExport}ms, size ${(data.length/1024/1024).toFixed(1)}MB)`);
  }
}

/**
 * 即時書き出し（起動時マイグレーション・終了時専用）。
 * 保留中のdebounce保存があればキャンセルして代わりに今すぐ書く一方、
 * 既に進行中の非同期保存があれば必ずそれの完了を待ってから自分の
 * 書き込みを行う（_saveChain で直列化）。async化したため呼び出し側は
 * 必ず await すること（同期呼び出しは上記の破損レースを再発させる）。
 */
async function _saveNow() {
  if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
  const p = _saveChain.then(_writeDbFile);
  _saveChain = p.catch(e => log.error('[db] saveNow error:', e.message));
  await _saveChain;
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
  const now = unixNow();
  _run(`
    UPDATE works SET
      last_checked          = ?,
      check_interval        = ?,
      priority              = ?,
      is_on_sale            = ?,
      consecutive_no_change = ?,
      consecutive_errors    = ?,
      next_check_at         = ?
    WHERE rj_code = ?
  `, [
    now,
    fields.check_interval,
    fields.priority,
    fields.is_on_sale,
    fields.consecutive_no_change ?? 0,
    fields.consecutive_errors    ?? 0,
    now + fields.check_interval,
    rjCode,
  ]);
}

/** A: ãã§ããã¨ã©ã¼è¨é²ãé£ç¶ã¨ã©ã¼æ°ã«å¿ãã¦intervalãå»¶ã°ãã */
function recordFetchError(rjCode) {
  const w = getWorkByRj(rjCode);
  if (!w) return;
  const errs = (w.consecutive_errors ?? 0) + 1;
  // 5回連続エラー→72h, 10回→7日 でほぼ停止
  const interval = errs >= 10 ? 7 * 86400
                 : errs >=  5 ? 3 * 86400
                 : w.check_interval ?? 86400;
  // バグ修正: recordFetchError は check_interval だけを延ばし priority を
  // 一切下げていなかった。recordApiMissing(APIキー自体が存在しない)とは
  // 区別して「一時的なCDN不一致かもしれない」と保守的に扱う設計自体は妥当だが、
  // 一度 priority=100(セール中)等で壊れた作品は、CDN不一致が続く限り
  // 永久にその高優先度のまま ORDER BY priority DESC の先頭に居座り続け、
  // due キューと診断ツールのサンプルを無駄に消費し続けるバグがあった
  // (実際に同じ3件のRJコードが診断のたびに毎回選ばれ続けていたことで発覚)。
  // 15回連続失敗(=中断込みで数日〜1週間分の試行)してもなお解決しない場合は、
  // 「本当に消えた」とまでは断定しない(recordApiMissingのdelistedには落とさない)
  // が、優先度だけは normal まで下げて他の正常な作品の巡回を妨げないようにする。
  const priority = errs >= 15 && w.priority > config.priority.normal
    ? config.priority.normal
    : w.priority;
  const now = unixNow();
  _run(`
    UPDATE works SET
      last_checked        = ?,
      consecutive_errors  = ?,
      check_interval      = ?,
      next_check_at       = ?,
      priority             = ?
    WHERE rj_code = ?
  `, [now, errs, interval, now + interval, priority, rjCode]);
}

/**
 * API に存在しない作品（"key not in API response"）を記録。
 * ネットワークエラーより急速に interval を延ばして due キューから退避させる。
 *  1回目: 7日, 2回目: 30日, 3回目以降: 180日
 *
 * バグ修正: 以前は check_interval だけを延ばし priority を一切下げていなかった。
 * getDueWorks()も診断ツールのサンプル選択も ORDER BY priority DESC のため、
 * 削除/非公開等でAPIが恒常的に空を返す作品が priority=100(セール中扱い等)の
 * まま居座り続け、正常な作品より優先的に選ばれ続ける（本番の巡回帯域を無駄に
 * 消費し、診断ツールも毎回同じ壊れた作品を掴んで誤検知の原因になっていた）。
 * 2回連続で不在が確定した時点で priority を最低ランクまで落とす。
 */
function recordApiMissing(rjCode) {
  const w = getWorkByRj(rjCode);
  if (!w) return;
  const errs = (w.consecutive_errors ?? 0) + 1;
  const interval = errs >= 3 ? 180 * 86400
                 : errs >= 2 ?  30 * 86400
                 :               7 * 86400;
  const priority = errs >= 2 ? config.priority.delisted : w.priority;
  const now = unixNow();
  _run(`
    UPDATE works SET
      last_checked       = ?,
      consecutive_errors = ?,
      check_interval     = ?,
      next_check_at       = ?,
      priority            = ?
    WHERE rj_code = ?
  `, [now, errs, interval, now + interval, priority, rjCode]);
}

function getDueWorks(limit = 50) {
  const now = unixNow();
  // next_check_at にインデックスがあるため、計算式での全件スキャンより高速
  return _all(`
    SELECT * FROM works
    WHERE next_check_at <= ?
    ORDER BY priority DESC, next_check_at ASC
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
 * サークル欠落診断(circleGapScan)用: maker_id -> 最も多くの手持ち作品がある site_id のマップ。
 * 1サークルは通常1サイトのみで活動するが、稀に複数サイトに作品がある場合は
 * 件数が多い方のサイトを巡回対象として採用する（少数派サイトの作品は既存作品として
 * 既にDBにあるので、巡回自体は多数派サイトで問題ない）。
 *
 * 過去に site_id が 'aix'/'appx' 等のDLsite内部分類コードで継続的に破損していた
 * 問題があり(parser.js側で修正済みだが、修正前に書き込まれた既存レコードは
 * そのまま残っている)、そういった無効な site_id しか持たないサークルを対象URLに
 * 使うと存在しないサイトパスへ巡回してしまう。ここで既知の有効なサイトファミリー
 * (config.dlsite.validSiteIds)のみを候補として採用する。
 */
function getMakerSiteMap() {
  const validSites = new Set(config.dlsite.validSiteIds ?? ['maniax', 'girls', 'home', 'bl', 'pro']);
  const rows = _all(`
    SELECT maker_id, site_id, COUNT(*) AS cnt
    FROM works
    WHERE maker_id IS NOT NULL AND site_id IS NOT NULL
    GROUP BY maker_id, site_id
  `);
  const map = new Map();
  for (const { maker_id, site_id, cnt } of rows) {
    if (!validSites.has(site_id)) continue;   // 破損値(aix/appx等)は候補から除外
    const cur = map.get(maker_id);
    if (!cur || cnt > cur.cnt) map.set(maker_id, { site_id, cnt });
  }
  const result = new Map();
  for (const [makerId, { site_id }] of map) result.set(makerId, site_id);
  return result;
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
    SET priority = ?, check_interval = ?, next_check_at = last_checked + ?
    WHERE maker_id = ?
  `, [priority, checkInterval, checkInterval, makerId]);
}

/**
 * 個別作品(RJコード単位)を「割引終了間近」として緊急優先度に上げる。
 * boostCircleWorks はサークル単位だが、こちらは runEndingSoonScan が見つけた
 * 個々の作品をすぐ再チェック対象にするためのもの。next_check_at = now なので
 * 次回の価格更新パスで最優先(priority DESC)かつ即時 due になる。
 */
function boostWorkUrgent(rjCode, priority, checkInterval) {
  const now = unixNow();
  _run(`
    UPDATE works
    SET priority = ?, check_interval = ?, next_check_at = ?
    WHERE rj_code = ?
  `, [priority, checkInterval, now, rjCode]);
}

/** â¡ ã»ã¼ã«çµäº: ãµã¼ã¯ã«å¨ä½åã®åªååº¦ã¨ééãéå¸¸å¤ã«æ»ã */
function resetCircleWorksPriority(makerId, priority, checkInterval) {
  _run(`
    UPDATE works
    SET priority = ?, check_interval = ?, next_check_at = last_checked + ?
    WHERE maker_id = ?
  `, [priority, checkInterval, checkInterval, makerId]);
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
  // price_history への ORDER BY 全件スキャンをやめ、works に非正規化した
  // cur_* カラムと直接比較する（30万件規模でも O(1) lookup）
  const last = _get(
    `SELECT cur_price, cur_sale_price, cur_discount_rate, cur_point, is_on_sale, cur_is_point_only
     FROM works WHERE rj_code = ?`, [rjCode]
  );

  const changed =
    !last || last.cur_price === null ||
    last.cur_price          !== (priceData.price         ?? null) ||
    last.cur_sale_price     !== (priceData.sale_price    ?? null) ||
    last.cur_discount_rate  !== (priceData.discount_rate ?? null) ||
    last.cur_point          !== (priceData.point         ?? null) ||
    last.is_on_sale         !== (priceData.is_on_sale    ?? 0)    ||
    last.cur_is_point_only  !== (priceData.is_point_only ?? 0);

  // changed=false の場合も既存の consecutive_no_change を返す
  // (呼び出し側で getWorkByRj() を重ねて呼ばなくて済むようにする)
  if (!changed) {
    return { changed: false, consecutive_no_change: last?.consecutive_no_change ?? 0 };
  }

  const now = unixNow();
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
    now,
  ]);

  // works の非正規化カラムも同期更新（一覧表示の高速化用キャッシュ）
  _run(`
    UPDATE works SET
      cur_price         = ?,
      cur_sale_price     = ?,
      cur_discount_rate  = ?,
      cur_point          = ?,
      cur_is_point_only  = ?,
      price_checked_at   = ?
    WHERE rj_code = ?
  `, [
    priceData.price         ?? null,
    priceData.sale_price    ?? null,
    priceData.discount_rate ?? null,
    priceData.point         ?? null,
    priceData.is_point_only ?? 0,
    now,
    rjCode,
  ]);

  return { changed: true, consecutive_no_change: 0 };
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
  // 6本の独立クエリを1本のサブクエリに統合してラウンドトリップを削減
  const now = unixNow();
  const row = _get(`
    SELECT
      (SELECT COUNT(*)           FROM works)                                   AS totalWorks,
      (SELECT COUNT(*)           FROM works   WHERE is_on_sale = 1)            AS onSale,
      (SELECT COUNT(*)           FROM price_history)                           AS priceChanges,
      (SELECT COUNT(*)           FROM circles)                                 AS totalCircles,
      (SELECT COUNT(*)           FROM circles WHERE on_sale = 1)               AS circlesOnSale,
      (SELECT COUNT(*)           FROM works   WHERE next_check_at <= ${now})   AS dueNow
  `);
  return row ?? { totalWorks: 0, onSale: 0, priceChanges: 0, totalCircles: 0, circlesOnSale: 0, dueNow: 0 };
}

// âââ backup ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

/**
 * DBの世代管理付きバックアップ。
 *
 * 機能追加: 以前は単純に「直近30世代を残す」だけのフラットな保持だったため、
 * 毎日バックアップしていると1ヶ月前より古い状態には一切戻れなかった。
 * 以下の世代管理に変更する:
 *   - 直近7日分     : 毎日分をすべて保持
 *   - 直近8週間分   : 週1回分だけ保持（7日より古い分）
 *   - 直近12ヶ月分  : 月1回分だけ保持（8週間より古い分）
 *   - それ以上古い分: 削除
 *
 * また、バックアップごとに件数・チェックサム等のメタデータ(.meta.json)を
 * 併せて保存する。復元時にファイルが壊れていないか、どの時点のスナップ
 * ショットかを確認しやすくするため。
 */
function backup() {
  if (!_db) return;
  try {
    const dir = path.resolve(path.dirname(DB_PATH), 'backups');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const now     = new Date();
    const stamp   = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const dest    = path.join(dir, `dlsite-${stamp}.db`);
    const metaDest = path.join(dir, `dlsite-${stamp}.meta.json`);

    const data = _db.export();
    const buf  = Buffer.from(data);

    // クラッシュ時に不完全なファイルで上書きされないよう、一時ファイル→rename
    const tmpPath = dest + '.tmp';
    fs.writeFileSync(tmpPath, buf);
    fs.renameSync(tmpPath, dest);

    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    const counts = {
      works:        (_get('SELECT COUNT(*) AS n FROM works') ?? { n: 0 }).n,
      priceHistory: (_get('SELECT COUNT(*) AS n FROM price_history') ?? { n: 0 }).n,
      circles:      (_get('SELECT COUNT(*) AS n FROM circles') ?? { n: 0 }).n,
    };
    let appVersion = null;
    try { appVersion = require('../package.json').version; } catch { /* ignore */ }

    const meta = {
      timestamp:  now.toISOString(),
      dbFile:     path.basename(dest),
      sizeBytes:  buf.length,
      sha256,
      counts,
      appVersion,
    };
    fs.writeFileSync(metaDest, JSON.stringify(meta, null, 2));

    log.info('[db] backup saved', dest, `(${(buf.length/1024/1024).toFixed(1)}MB, works=${counts.works})`);

    _pruneBackups(dir);
  } catch (err) {
    log.error('[db] backup error', err.message);
  }
}

/** バックアップファイル名 'dlsite-YYYY-MM-DDTHH-mm-ss.db' から日時を復元する。 */
function _parseBackupDate(filename) {
  const m = filename.match(/^dlsite-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})\.db$/);
  if (!m) return null;
  // 'YYYY-MM-DDTHH-mm-ss' → 'YYYY-MM-DDTHH:mm:ss' に戻してからパース
  const iso = m[1].replace(/T(\d{2})-(\d{2})-(\d{2})$/, 'T$1:$2:$3');
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

/** 日次/週次/月次の世代管理でバックアップを間引く。 */
function _pruneBackups(dir) {
  const DAY  = 86400000;
  const WEEK = DAY * 7;
  const now  = Date.now();

  const files = fs.readdirSync(dir)
    .filter(f => f.startsWith('dlsite-') && f.endsWith('.db'))
    .map(f => ({ name: f, date: _parseBackupDate(f) }))
    .filter(f => f.date)
    .sort((a, b) => a.date - b.date); // 古い順

  const keep = new Set();
  const seenWeek  = new Set();
  const seenMonth = new Set();

  for (const f of files) {
    const age = now - f.date.getTime();
    if (age <= 7 * DAY) {
      keep.add(f.name); // 直近7日はすべて保持
    } else if (age <= 8 * WEEK) {
      // ISO週相当のざっくりしたキー（年 + 経過週数）で週1回だけ保持
      const weekKey = `${f.date.getUTCFullYear()}-${Math.floor(f.date.getTime() / WEEK)}`;
      if (!seenWeek.has(weekKey)) { seenWeek.add(weekKey); keep.add(f.name); }
    } else if (age <= 365 * DAY) {
      const monthKey = `${f.date.getUTCFullYear()}-${f.date.getUTCMonth()}`;
      if (!seenMonth.has(monthKey)) { seenMonth.add(monthKey); keep.add(f.name); }
    }
    // 365日超は keep に入らない = 削除対象
  }

  for (const f of files) {
    if (keep.has(f.name)) continue;
    try {
      fs.unlinkSync(path.join(dir, f.name));
      const metaPath = path.join(dir, f.name.replace(/\.db$/, '.meta.json'));
      if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
      log.debug('[db] old backup removed', f.name);
    } catch (e) {
      log.warn('[db] backup prune failed', f.name, e.message);
    }
  }
}

/**
 * バックアップファイルが破損していないか検証する。
 * 対応する .meta.json のsha256とファイル実体のハッシュを比較する。
 * @returns {{ok: boolean, reason?: string, meta?: object}}
 */
function verifyBackup(dbBackupPath) {
  try {
    const metaPath = dbBackupPath.replace(/\.db$/, '.meta.json');
    if (!fs.existsSync(metaPath)) {
      return { ok: false, reason: 'メタデータファイルが見つかりません（旧世代のバックアップの可能性）' };
    }
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const buf  = fs.readFileSync(dbBackupPath);
    const actualSha256 = crypto.createHash('sha256').update(buf).digest('hex');
    if (actualSha256 !== meta.sha256) {
      return { ok: false, reason: 'チェックサム不一致（ファイルが破損している可能性）', meta };
    }
    return { ok: true, meta };
  } catch (e) {
    return { ok: false, reason: e.message };
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

  // works に非正規化済みの cur_* カラムを直接参照
  const sortMap = {
    priority: 'w.priority DESC, w.last_checked DESC',
    discount: 'COALESCE(w.cur_discount_rate, 0) DESC',
    price:    'w.cur_price ASC',
    checked:  'w.last_checked DESC',
    release:  'w.release_date DESC',
  };
  const orderBy = sortMap[sort] ?? sortMap.priority;

  let where  = onSale ? 'AND w.is_on_sale = 1 ' : '';
  const params = [];

  if (q) {
    where += "AND (LOWER(w.rj_code) LIKE ? OR LOWER(COALESCE(w.title,'')) LIKE ? OR LOWER(COALESCE(w.circle,'')) LIKE ?) ";
    const like = '%' + q.toLowerCase() + '%';
    params.push(like, like, like);
  }

  const baseFrom = `FROM works w WHERE 1=1 ${where}`;

  const total = (_get(`SELECT COUNT(*) AS n ${baseFrom}`, params) ?? { n: 0 }).n;

  const works = _all(
    `SELECT w.*,
       w.cur_price AS price, w.cur_sale_price AS sale_price,
       w.cur_discount_rate AS discount_rate, w.cur_is_point_only AS is_point_only,
       w.price_checked_at AS ph_checked_at
     ${baseFrom} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );

  return { works, total, page, pages: Math.ceil(total / limit) };
}

/**
 * Works currently on sale, sorted by discount rate desc.
 */
function getSaleWorks(limit = 200) {
  return _all(`
    SELECT w.*,
      w.cur_price AS price, w.cur_sale_price AS sale_price,
      w.cur_discount_rate AS discount_rate, w.cur_is_point_only AS is_point_only,
      w.price_checked_at AS checked_at
    FROM works w
    WHERE w.is_on_sale = 1
    ORDER BY COALESCE(w.cur_discount_rate, 0) DESC, w.cur_price ASC
    LIMIT ?
  `, [limit]);
}




// ─── export snapshot (exportShards.js 向け) ──────────────────────────────────
// ブラウザ拡張機能配信用の軽量JSONを生成するために必要な集計クエリをまとめる。
// _all/_get は本ファイル内のプライベートヘルパーのため、外部モジュールからは
// これらの専用エクスポート経由でのみDBを参照させる(カプセル化を保つ)。

/** cur_price が設定されている(=価格取得済みの)全ワークの基本情報 */
function getExportBaseWorks() {
  return _all(`
    SELECT rj_code, maker_id,
           cur_price AS price, cur_sale_price AS sale_price,
           cur_discount_rate AS discount_rate,
           is_on_sale, cur_is_point_only AS is_point_only
    FROM works
    WHERE cur_price IS NOT NULL
  `);
}

/** 直近365日以内で is_on_sale=1 だった「日数」(同日重複は1回のみ) を rj_code 別に */
function getDiscountDaysMap() {
  const oneYearAgo = unixNow() - 365 * 86400;
  const rows = _all(`
    SELECT rj_code, COUNT(DISTINCT date(checked_at, 'unixepoch')) AS days
    FROM price_history
    WHERE is_on_sale = 1 AND checked_at >= ?
    GROUP BY rj_code
  `, [oneYearAgo]);
  return new Map(rows.map(r => [r.rj_code, r.days]));
}

/** 全期間での実質最安値(セール価格優先、なければ定価) を rj_code 別に */
function getLowestPriceMap() {
  const rows = _all(`
    SELECT rj_code, MIN(COALESCE(sale_price, price)) AS lowest
    FROM price_history
    WHERE COALESCE(sale_price, price) > 0
    GROUP BY rj_code
  `);
  return new Map(rows.map(r => [r.rj_code, r.lowest]));
}

/**
 * 直近 limit 件の実質価格ログ(新しい順)を rj_code 別に。
 * sql.js の SQLite ビルドが window function 非対応の場合は例外を投げるので、
 * 呼び出し側(exportShards.js)でフォールバック処理すること。
 */
function getRecentPriceLogMap(limit = 8) {
  const rows = _all(`
    WITH ranked AS (
      SELECT rj_code, price, sale_price, checked_at,
             ROW_NUMBER() OVER (PARTITION BY rj_code ORDER BY checked_at DESC) AS rn
      FROM price_history
    )
    SELECT rj_code, price, sale_price, rn
    FROM ranked
    WHERE rn <= ?
    ORDER BY rj_code, rn ASC
  `, [limit]);

  const map = new Map();
  for (const r of rows) {
    const val = r.sale_price ?? r.price;
    if (val == null) continue;
    if (!map.has(r.rj_code)) map.set(r.rj_code, []);
    map.get(r.rj_code).push(val);
  }
  return map;
}

function unixNow() {
  return Math.floor(Date.now() / 1000);
}

/**
 * CDN/プロキシのキャッシュ汚染により誤って priority=delisted まで落とされた
 * 疑いのある作品を検出・復旧する（1回限りのDBメンテナンス用）。
 *
 * recordApiMissing() は consecutive_errors が2に達した時点で priority を
 * config.priority.delisted まで落とす。誤検出(CDN汚染)によるものは通常
 * 2〜3回程度でこの状態に達しているはずで、本当に長期間削除され続けている
 * 作品はこれよりずっと多い consecutive_errors を持つ傾向がある
 * (recordApiMissing は毎回 interval を延ばすため、真の delisted 作品は
 * 巡回のたびに errs が積み上がっていく)。
 * そのため consecutive_errors が低い(=最近delistedになったばかりの)作品だけを
 * 対象にすることで、長期間確認済みの本当のdelisted作品を誤って復旧しない
 * ようにする。
 *
 * 復旧された作品が本当に削除済みだった場合でも、次回チェック時には
 * detailFetcher.js 側で強化済みの汚染判定によって正しく再度delistedに
 * なるため、安全に実行できる。
 */
function countSuspectedDelisted(minErrors = 2, maxErrors = 3) {
  const row = _get(`
    SELECT COUNT(*) AS n FROM works
    WHERE priority = ? AND consecutive_errors BETWEEN ? AND ?
  `, [config.priority.delisted, minErrors, maxErrors]);
  return row?.n ?? 0;
}

function recoverSuspectedDelisted(minErrors = 2, maxErrors = 3) {
  const now = unixNow();
  _run(`
    UPDATE works SET
      priority            = ?,
      consecutive_errors  = 0,
      check_interval       = ?,
      next_check_at         = ?
    WHERE priority = ? AND consecutive_errors BETWEEN ? AND ?
  `, [
    config.priority.normal,
    config.checkInterval.normal,
    now,
    config.priority.delisted,
    minErrors,
    maxErrors,
  ]);
  const affected = _db.getRowsModified();
  if (affected > 0) {
    log.info('[db] recoverSuspectedDelisted:', affected, '件を通常優先度に復旧', { minErrors, maxErrors });
    _save();
  }
  return affected;
}

/** å¨RJã³ã¼ããSetã§è¿ãï¼discoveryé«éç§åç¨ï¼ */
// rj_code の全件取得は discovery が6時間毎に呼ぶため、インメモリキャッシュで高速化する。
// upsertWork が呼ばれたときにキャッシュを無効化する（次回 getAllRjCodes() 時に再構築）。
let _rjCodesCache = null;
function _invalidateRjCache() { _rjCodesCache = null; }
function getAllRjCodes() {
  if (!_rjCodesCache) {
    _rjCodesCache = new Set(_all('SELECT rj_code FROM works').map(r => r.rj_code));
  }
  return _rjCodesCache;
}

/**
 * ウォームアップ用: 指定サイトファミリー内で実在する作品RJコードを1件返す。
 * DLsiteの年齢確認ゲートはサイトルートではなく商品詳細ページでのみ表示される
 * ため、warmUpSession()が実際にクリック可能な年齢確認ページへ到達するには
 * サイトごとの実在RJコードが必要。DBが空(初回起動)の場合はnullを返し、
 * 呼び出し側はサイトルートへのフォールバックで対応する。
 */
function getSampleRjForSite(siteId) {
  const row = _get(
    'SELECT rj_code FROM works WHERE site_id = ? ORDER BY last_checked DESC LIMIT 1',
    [siteId]
  );
  return row?.rj_code ?? null;
}

module.exports = {
  init,
  close,
  runInTransaction,
  upsertWork,
  markChecked,
  recordFetchError,
  recordApiMissing,
  getDueWorks,
  getWorkByRj,
  getAllMakerIds,
  getMakerSiteMap,
  getCirclesForDiscovery,
  boostCircleWorks,
  boostWorkUrgent,
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
  verifyBackup,
  transaction,
  transactionNoSave,
  save: _save,
  exportAllHistory,
  searchWorks,
  getSaleWorks,
  getAllRjCodes,
  unixNow,
  getExportBaseWorks,
  getDiscountDaysMap,
  getLowestPriceMap,
  getRecentPriceLogMap,
  countSuspectedDelisted,
  recoverSuspectedDelisted,
  getSampleRjForSite,
};
