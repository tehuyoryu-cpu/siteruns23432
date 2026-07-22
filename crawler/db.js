'use strict';

/**
 * crawler/db.js
 * SQLite access layer — better-sqlite3 (native binding, synchronous, direct file I/O).
 *
 * 移行の背景 (sql.js → better-sqlite3):
 *   sql.js は DB 全体をメモリ上のバイト列として保持し、変更のたびに
 *   `_db.export()` で全体を再シリアライズして丸ごと書き直す方式だった。
 *   これが DB サイズ(350MB超)に比例して重くなり、`[db] save slow` の
 *   直接の原因だった(export自体は数十〜数百msだが、export+writeFileの
 *   合計が数秒〜十数秒かかるケースがあった)。
 *   better-sqlite3 はネイティブSQLiteに対して直接・同期的に読み書きするため、
 *   「変更のたびに全体をシリアライズし直す」という構造的コストがそもそも
 *   存在しない。WALモードにより単一トランザクションの書き込みは
 *   ページ単位の追記で完結する。
 *
 * これに伴う設計変更:
 *   - _save()/_saveNow() は事実上不要になった（各トランザクション/文の
 *     実行と同時にディスクへ反映される）。ただし他モジュールから
 *     db.save() を呼んでいる箇所が複数あるため、互換性のために
 *     no-op として残す。
 *   - transaction()/transactionNoSave()/runInTransaction() は
 *     better-sqlite3 のネイティブ `_db.transaction(fn)` を使うよう統一した。
 *     これは SAVEPOINT によるネスト対応を標準サポートするため、
 *     旧コードにあった「ネストするとBEGIN二重発行でエラーになる」という
 *     制約（recordPriceIssue 等のコメント参照）が解消されている。
 *   - backup() は better-sqlite3 のオンラインバックアップAPI
 *     (`_db.backup(destPath)`) を使う。DB全体をJSバッファへロードしてから
 *     書き出す旧実装と異なり、SQLite本体が安全にページ単位でコピーする。
 *
 * Initialisation:
 *   await db.init()   — must be called once before any other function.
 *                        (better-sqlite3 自体は同期APIだが、呼び出し側の
 *                        `await db.init()` との互換性のため async のまま維持)
 */

const Database = require('better-sqlite3');
const fs        = require('fs');
const path      = require('path');
const crypto    = require('crypto');
const config    = require('../config');
const log       = require('./logger');

let _db = null;   // better-sqlite3 Database instance
// electron-builder portable exe では PORTABLE_EXECUTABLE_DIR が exe のディレクトリを指す
const _exeDir = process.env.DLSITE_DATA_DIR
  || process.env.PORTABLE_EXECUTABLE_DIR
  || process.cwd();
const DB_PATH = path.resolve(_exeDir, config.db.path);

// ─── init / open / close ─────────────────────────────────────────────────────

/**
 * Initialisation. Must be awaited once before any DB call.
 * Safe to call multiple times (idempotent).
 * (better-sqlite3 は同期APIだが、呼び出し側の既存の `await db.init()` を
 *  変更せずに済むよう async function のまま維持している)
 *
 * バグ修正（起動が遅い）: 以前はここで PRAGMA integrity_check を毎回同期実行し、
 * DBファイル全体を読み切ってから起動を完了させていた。実測では 140MB のDBで
 * コールドキャッシュ時 3.9秒、quick_check に変えても 2.8秒(ボトルネックは
 * pragmaの種類ではなくファイル全体を読む量そのもの)。本番DB(354.9MB)では
 * 起動のたびに10秒近くブロックしていた計算になる。electron-main.js は
 * createWindow() をこの db.init() の完了後まで待つため、ウィンドウ表示自体が
 * 遅延していた。これは今回の(sql.js→better-sqlite3)移行で新規に追加した
 * チェックで、旧sql.js版には存在しなかった。
 * 「ファイルを開いた時点では全体を検証しない」というbetter-sqlite3/SQLiteの
 * 特性自体は正しいが、対策として全件事前スキャンする代わりに、実際にクエリが
 * 壊れたページへアクセスして SQLITE_CORRUPT 系のエラーが起きた瞬間に検知する
 * リアクティブ方式に変更した(_get/_all/_run 参照)。ファイルが開けないレベルの
 * 破損は従来通り起動時に検知・復旧する。
 */
async function init() {
  if (_db) return;

  const existed = fs.existsSync(DB_PATH);

  try {
    _db = new Database(DB_PATH);
  } catch (e) {
    log.error('[db] failed to open database file', e.message, '— attempting recovery');
    _db = _recoverFromCorruption();
  }

  // バグ修正: better-sqlite3が同梱するSQLiteは foreign_keys プラグマの
  // デフォルトが ON だった(sql.js版は暗黙的にOFFだったため、これまで一度も
  // 表面化していなかった)。price_history に張られた
  // FOREIGN KEY (rj_code) REFERENCES works(rj_code) が実際に効くようになった結果、
  // ゴーストRJコード削除(DELETE FROM works ...)が、対応するprice_history行が
  // 残っている場合に "FOREIGN KEY constraint failed" で失敗するようになっていた。
  // ON DELETE CASCADE は元のスキーマに無く、既存の巨大なprice_historyテーブルを
  // それを付けて作り直すのは現実的でないため、旧sql.js版と同じ「FK制約を
  // 強制しない」挙動に明示的に揃えることで対処する(price_historyに親のいない
  // 行が残る可能性はあるが、これは元々の挙動と同じであり新規のリスクではない)。
  _db.pragma('foreign_keys = OFF');

  // WAL: 読み取りと書き込みが競合しにくく、コミットも高速。
  // synchronous=NORMAL は WAL との組み合わせで推奨される設定
  // （アプリクラッシュに対しては安全、OSクラッシュ/停電時のみ僅かにリスクあり。
  //  巡回アプリの用途では十分な安全性とパフォーマンスのバランス）。
  _db.pragma('journal_mode = WAL');
  _db.pragma('synchronous = NORMAL');

  if (existed) {
    log.info('[db] loaded', DB_PATH);
  } else {
    log.info('[db] created', DB_PATH);
  }

  const schemaChanged = _applySchema();
  if (schemaChanged) {
    log.info('[db] schema changed/migrated');
  }
}

/** DBをクローズする。呼び出し側の `await db.close()` との互換性のため async のまま維持。 */
async function close() {
  if (_db) {
    try { _db.pragma('wal_checkpoint(TRUNCATE)'); } catch (e) { log.warn('[db] checkpoint on close failed', e.message); }
    _db.close();
    _db = null;
    log.info('[db] closed');
  }
}

/**
 * true if PRAGMA integrity_check reports 'ok'.
 * 重い処理（DBサイズに比例、354.9MB規模で数秒〜10秒程度）のため、
 * 起動時には自動実行しない。手動メンテナンス操作（将来的なダッシュボードの
 * 「DB整合性チェック」ボタン等）や、破損が疑われた際の調査用に公開している。
 */
function checkIntegrity() {
  try {
    return _db.pragma('integrity_check', { simple: true }) === 'ok';
  } catch (e) {
    log.error('[db] integrity_check threw', e.message);
    return false;
  }
}

/**
 * Recovery order when the DB file fails to open or fails integrity_check:
 *   1. Quarantine the corrupt file (copy aside, never delete — for forensics).
 *   2. Try the newest verified backup (backups/*.db + matching .meta.json,
 *      sha256-checked via verifyBackup()).
 *   3. If no valid backup exists, start a fresh empty DB (data loss, but
 *      keeps the app usable instead of erroring on every job forever).
 */
function _recoverFromCorruption() {
  const quarantineDir = path.resolve(path.dirname(DB_PATH), 'corrupted');
  try {
    fs.mkdirSync(quarantineDir, { recursive: true });
    const dest = path.join(quarantineDir, `dlsite-corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
    if (fs.existsSync(DB_PATH)) {
      fs.copyFileSync(DB_PATH, dest);
      log.error('[db] corrupt file quarantined at', dest);
    }
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

  const tmpTest = DB_PATH + '.recovery-test';
  for (const c of candidates) {
    const v = verifyBackup(c.full);
    if (!v.ok) {
      log.warn('[db] backup failed verification, skipping', c.name, v.reason);
      continue;
    }
    try {
      fs.copyFileSync(c.full, tmpTest);
      const testDb = new Database(tmpTest);
      const ok = testDb.pragma('integrity_check', { simple: true }) === 'ok';
      testDb.close();
      if (ok) {
        fs.copyFileSync(tmpTest, DB_PATH);
        try { fs.unlinkSync(DB_PATH + '-wal'); } catch { /* ignore */ }
        try { fs.unlinkSync(DB_PATH + '-shm'); } catch { /* ignore */ }
        fs.unlinkSync(tmpTest);
        log.error('[db] RECOVERED from backup', c.name, '— data since this backup is LOST, review corrupted/ and backups/ manually');
        return new Database(DB_PATH);
      }
      fs.unlinkSync(tmpTest);
      log.warn('[db] backup also failed integrity_check, trying older one', c.name);
    } catch (e) {
      log.warn('[db] backup restore attempt failed', c.name, e.message);
      try { fs.unlinkSync(tmpTest); } catch { /* ignore */ }
    }
  }

  log.error('[db] NO usable backup found — starting with a fresh empty database. Manual recovery from corrupted/ may be possible.');
  try { fs.unlinkSync(DB_PATH); } catch { /* ignore */ }
  try { fs.unlinkSync(DB_PATH + '-wal'); } catch { /* ignore */ }
  try { fs.unlinkSync(DB_PATH + '-shm'); } catch { /* ignore */ }
  return new Database(DB_PATH);
}

// ─── schema ──────────────────────────────────────────────────────────────────

function _fixLegacyCompTables() {
  // 旧バージョンで comp_works/comp_pending が異なるカラム構成のまま作成されていた場合、
  // CREATE TABLE IF NOT EXISTS はテーブルが既に存在するため無視され、直後の
  // CREATE INDEX ... ON comp_works(contained_rj) が「no such column: contained_rj」で
  // 例外を投げ、アプリ全体が起動不能になる不具合があった。
  // これらのテーブルは compscan で再生成可能なキャッシュデータのため、
  // 必須カラムが無い旧スキーマを検出した場合は安全にDROPしてから通常のスキーマ適用に進む。
  for (const table of ['comp_works', 'comp_pending']) {
    try {
      const rows = _db.prepare(`PRAGMA table_info(${table})`).all();
      if (!rows.length) continue; // テーブル未作成なら何もしない
      const colNames = rows.map(r => r.name);
      if (!colNames.includes('contained_rj')) {
        log.warn('[db] legacy schema detected, dropping and recreating', table);
        _db.exec(`DROP TABLE IF EXISTS ${table}`);
      }
    } catch (e) {
      log.warn('[db] legacy schema check failed', table, e.message);
    }
  }
}

function _applySchema() {
  let changed = false;
  _fixLegacyCompTables();
  console.log('[db] _applySchema: creating tables...');
  _db.exec(`
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

    -- forward-only migration: 既存テーブルへのカラム追加
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

    -- 総集編マーク機能（拡張機能から移植）
    -- comp_candidates: FSRジャンル515(総集編)一覧で見つかった「総集編“作品”」RJ。
    --   詳細ページ解析(収録作品抽出)の処理待ちキューを兼ねる(processed_at IS NULL = due)。
    CREATE TABLE IF NOT EXISTS comp_candidates (
      rj_code       TEXT PRIMARY KEY,
      discovered_at INTEGER NOT NULL,
      processed_at  INTEGER,
      status        TEXT DEFAULT 'new'
    );

    -- comp_works: 確定した「総集編RJ → 収録作品RJ」の対応。
    --   source='direct'    詳細ページの作品内容欄から直接抽出（高信頼度）
    --   source='estimated' 同サークル作品からのスコアリング推定（要review後に確定したもの含む）
    CREATE TABLE IF NOT EXISTS comp_works (
      compilation_rj TEXT NOT NULL,
      contained_rj   TEXT NOT NULL,
      source         TEXT NOT NULL DEFAULT 'direct',
      score          INTEGER,
      found_at       INTEGER NOT NULL,
      PRIMARY KEY (compilation_rj, contained_rj)
    );

    -- comp_pending: 推定スコアが閾値未満で自動確定できなかった候補（要人手確認）
    CREATE TABLE IF NOT EXISTS comp_pending (
      compilation_rj TEXT NOT NULL,
      contained_rj   TEXT NOT NULL,
      score          INTEGER NOT NULL,
      reasons        TEXT,
      status         TEXT NOT NULL DEFAULT 'pending',
      found_at       INTEGER NOT NULL,
      decided_at     INTEGER,
      PRIMARY KEY (compilation_rj, contained_rj)
    );

    -- comp_scan_progress: ジャンル515一覧走査のページ位置（単一行、再開用）
    CREATE TABLE IF NOT EXISTS comp_scan_progress (
      id           INTEGER PRIMARY KEY CHECK (id = 1),
      listing_page INTEGER DEFAULT 1,
      listing_done INTEGER DEFAULT 0,
      updated_at   INTEGER
    );

    -- price_issues: 定価が信頼できる形で取得できなかった作品を記録（デバッグ用）
    --   issue_type: 'ambiguous'（priceWorkはあるが割引側の手がかりが無い）
    --              'price_work_missing'（price_work欠損、記録価格が割引後価格の可能性）
    --              'no_price_field'（利用可能な価格フィールドが一切無い）
    CREATE TABLE IF NOT EXISTS price_issues (
      rj_code     TEXT PRIMARY KEY,
      issue_type  TEXT NOT NULL,
      raw_fields  TEXT,
      first_seen  INTEGER NOT NULL,
      last_seen   INTEGER NOT NULL,
      occurrences INTEGER DEFAULT 1
    );

    CREATE INDEX IF NOT EXISTS idx_ph_rj       ON price_history(rj_code);
    CREATE INDEX IF NOT EXISTS idx_ph_at       ON price_history(checked_at);
    CREATE INDEX IF NOT EXISTS idx_works_maker ON works(maker_id);
    CREATE INDEX IF NOT EXISTS idx_comp_candidates_due ON comp_candidates(processed_at);
    CREATE INDEX IF NOT EXISTS idx_comp_works_contained ON comp_works(contained_rj);
    CREATE INDEX IF NOT EXISTS idx_comp_pending_status  ON comp_pending(status);
    CREATE INDEX IF NOT EXISTS idx_price_issues_type    ON price_issues(issue_type);
  `);

  // 既存DBへの安全なカラム追加 (IF NOT EXISTS は使えないので try/catch)
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
    // サークル欠落診断(circleGapScan)の再開・ローテーション用。
    // 「このサークルを最後にcircleGapScanでチェックした時刻」を記録し、
    // 次回実行時は未チェック/最も古くチェックされたサークルから優先的に
    // 対象にする（既存の getDueWorks の next_check_at と同じ考え方）。
    'ALTER TABLE circles ADD COLUMN last_gap_checked INTEGER DEFAULT 0',
    // バグ修正: 総集編詳細ページの取得が一時的なネットワーク不調で失敗しただけでも
    // 即座に processed_at を確定させてしまい、getDueCompCandidates は
    // processed_at IS NULL のみを対象にするため、その総集編が二度と再解析
    // されなくなる不具合があった。fail_count で失敗回数を数え、一定回数
    // (compScan.js側で判定)に達するまでは processed_at を確定させず
    // due のまま残して次回スキャンで再試行できるようにする。
    'ALTER TABLE comp_candidates ADD COLUMN fail_count INTEGER DEFAULT 0',
  ];

  for (const sql of migrations) {
    try {
      _db.exec(sql);
      log.info('[db] migrated:', sql.slice(0, 60));
      changed = true;
      // next_check_at は新規カラムなので既存行に一度だけ初期値を入れる
      // (due 作品検索を計算式の全件スキャンからインデックス参照に変えるため)
      if (sql.includes('next_check_at')) {
        _db.exec('UPDATE works SET next_check_at = last_checked + check_interval');
        log.info('[db] backfilled next_check_at for existing works');
      }
    }
    catch (_) { /* already exists */ }
  }

  // next_check_at カラムが(新規作成 or 上のALTERで)確実に存在する状態になった後でindexを作る。
  // CREATE TABLE 直後にまとめて作ると、既存DBでは ALTER 前にこの文が実行されてしまい
  // 「no such column: next_check_at」で起動が落ちるバグがあったため、ここに移動した。
  try {
    _db.exec('CREATE INDEX IF NOT EXISTS idx_works_next_check ON works(next_check_at)');
    // getDueWorks の ORDER BY priority DESC, next_check_at ASC に対応した複合インデックス。
    // priority 単列は別途インデックスがないため、20万件規模でインメモリソートが発生していた。
    _db.exec('CREATE INDEX IF NOT EXISTS idx_works_priority_next ON works(priority DESC, next_check_at ASC)');
  } catch (e) {
    log.error('[db] failed to create idx_works_next_check:', e.message);
  }
  // cur_* カラム(非正規化価格)が存在する状態になった後でソート用indexを作成
  try {
    _db.exec('CREATE INDEX IF NOT EXISTS idx_works_cur_discount ON works(cur_discount_rate)');
    _db.exec('CREATE INDEX IF NOT EXISTS idx_works_cur_price    ON works(cur_price)');
    _db.exec('CREATE INDEX IF NOT EXISTS idx_works_on_sale      ON works(is_on_sale)');
    // circleGapScanの再開・ローテーション用（last_gap_checked ASCでの並び替えを高速化）
    _db.exec('CREATE INDEX IF NOT EXISTS idx_circles_gap_checked ON circles(last_gap_checked)');
  } catch (e) {
    log.error('[db] failed to create cur_* indexes:', e.message);
  }

  console.log('[db] _applySchema: running migrations...');
  // データマイグレーション: 旧バージョンが書き込んだ無効な site_id を maniax に統一
  // 'aix'/'appx' は廃止済みの DLsite サブドメイン。RJ コードは maniax API で取得可能。
  {
    const VALID = ['maniax', 'girls', 'home', 'bl', 'pro'];
    const ph    = VALID.map(() => '?').join(',');
    const result = _db.prepare(`UPDATE works SET site_id = 'maniax' WHERE site_id NOT IN (${ph})`).run(...VALID);
    if (result.changes > 0) { log.info('[db] fixed invalid site_id -> maniax:', result.changes, '件'); changed = true; }
  }
  // ゴーストRJコード（末尾000パターン）の掃除
  // 旧discoveryバグでDBに混入したコードをDBから削除して無駄なAPIリクエストを止める
  try {
    const ghostResult = _db.prepare(
      `DELETE FROM works WHERE rj_code GLOB 'RJ*000' OR rj_code GLOB 'RJ*0000' OR rj_code = 'RJ000000'`
    ).run();
    if (ghostResult.changes > 0) {
      log.info('[db] removed ghost RJ codes (trailing 000):', ghostResult.changes, '件');
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
    const ghostResult = _db.prepare(ghostSql).run();
    if (ghostResult.changes > 0) log.info('[db] ghost RJ codes quarantined:', ghostResult.changes, '件');
  }

  // バグ修正: comp_candidates（総集編候補キュー）にも同じ末尾000ゴーストパターンが
  // 混入しており、compScanが毎回404を出し続けて無駄なリクエストを送っていた。
  // works テーブルの清掃はこちらには効かない（別テーブルのため）ので、
  // 同じ条件でここも清掃する。processed_at IS NULL（＝due中）のものだけを対象にし、
  // 既に処理済みの履歴レコードは触らない。
  try {
    const compGhostResult = _db.prepare(`
      DELETE FROM comp_candidates
      WHERE processed_at IS NULL AND (
        rj_code LIKE '%000'   OR rj_code LIKE '%0000'
        OR rj_code LIKE '%00000' OR rj_code LIKE 'RJ000000'
        OR rj_code LIKE 'RJ0000000' OR rj_code LIKE 'RJ00000000'
      )
    `).run();
    if (compGhostResult.changes > 0) {
      log.info('[db] removed ghost RJ codes from comp_candidates:', compGhostResult.changes, '件');
      changed = true;
    }
  } catch (e) {
    console.error('[db] comp_candidates ghost cleanup error:', e.message);
  }

  // cur_price 非正規化カラムのバックフィル（既存DBの cur_price が NULL の作品のみ）
  try {
    const pending = _get(`SELECT COUNT(*) AS n FROM works WHERE cur_price IS NULL AND rj_code IN (SELECT rj_code FROM price_history)`);
    if (pending && pending.n > 0) {
      console.log('[db] backfilling cur_price for', pending.n, 'works...');
      _db.exec(`
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

  // price_history に (rj_code, checked_at) の UNIQUE INDEX を追加する。
  // importHistoryRows() の INSERT OR IGNORE による冪等インポートに必要
  // （同じCSV/JSONを再インポートしても重複行が増えないようにするため）。
  // 既存DBに重複(rj_code, checked_at)が残っていると CREATE UNIQUE INDEX が
  // 失敗するため、先に重複行を間引く（各組につき最小idの1行のみ残す）。
  try {
    const dupCheck = _get(`
      SELECT COUNT(*) AS n FROM (
        SELECT rj_code, checked_at FROM price_history
        GROUP BY rj_code, checked_at HAVING COUNT(*) > 1
      )
    `);
    if (dupCheck && dupCheck.n > 0) {
      console.log('[db] price_history 重複行を間引き中...', dupCheck.n, '組');
      _db.exec(`
        DELETE FROM price_history
        WHERE id NOT IN (SELECT MIN(id) FROM price_history GROUP BY rj_code, checked_at)
      `);
      changed = true;
    }
    _db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_ph_rj_checked_unique ON price_history(rj_code, checked_at)');
  } catch (e) {
    console.error('[db] price_history unique index migration error:', e.message);
  }

  console.log('[db] _applySchema: done, changed=' + changed);
  return changed;
}

// ─── low-level query helpers ──────────────────────────────────────────────────

// 起動時の全件integrity_check(重い)を廃止した代わりのリアクティブな安全網。
// 実際にクエリが壊れたページへアクセスしてSQLITE_CORRUPT系のエラーが
// 発生した場合にのみ検知し、ログに大きく出す。1プロセスの生存期間中に
// 何度も同じ警告を出さないよう一度きりのフラグで抑制する。
let _corruptionWarned = false;
function _isCorruptionError(e) {
  return e?.code === 'SQLITE_CORRUPT' || /database disk image is malformed|file is not a database/i.test(e?.message ?? '');
}
function _reportCorruption(e, sql) {
  if (_corruptionWarned) return;
  _corruptionWarned = true;
  log.error('[db] ⚠ データベース破損の疑いを検出しました:', e.message,
    'SQL:', String(sql).slice(0, 120));
  log.error('[db] アプリを再起動してください。再起動時にファイルが開けない場合は',
    'backups/ フォルダから自動復旧を試みます。開ける場合でも、早めに db.backup() で',
    '現在の状態をバックアップしてから調査することを推奨します。');
}

/**
 * Execute a SELECT and return the first row as a plain object, or null.
 * @param {string} sql
 * @param {Array}  params  positional values matching ? placeholders
 */
function _get(sql, params = []) {
  try {
    return _db.prepare(sql).get(...params) ?? null;
  } catch (e) {
    if (_isCorruptionError(e)) _reportCorruption(e, sql);
    throw e;
  }
}

/**
 * Execute a SELECT and return all rows as plain objects.
 */
function _all(sql, params = []) {
  try {
    return _db.prepare(sql).all(...params);
  } catch (e) {
    if (_isCorruptionError(e)) _reportCorruption(e, sql);
    throw e;
  }
}

/**
 * Execute an INSERT / UPDATE / DELETE.
 * better-sqlite3 は同期・直接書き込みのため、sql.js版と異なり
 * 呼び出しごとの明示的な永続化(_save())は不要（トランザクション/文の
 * 実行と同時にディスクへ反映される）。戻り値の `.changes` で
 * 影響を受けた行数を参照できる。
 * @returns {{changes: number, lastInsertRowid: number|bigint}}
 */
function _run(sql, params = []) {
  try {
    return _db.prepare(sql).run(...params);
  } catch (e) {
    if (_isCorruptionError(e)) _reportCorruption(e, sql);
    throw e;
  }
}

/**
 * 複数の _run をひとまとめにトランザクションで実行する。
 * better-sqlite3 のネイティブ `_db.transaction(fn)` を使用。
 * SAVEPOINT によるネストにも標準対応しているため、他のトランザクション内から
 * 呼ばれても安全（旧sql.js実装ではBEGIN二重発行でエラーになっていた制約が解消）。
 */
function transaction(fn) {
  if (!_db) throw new Error('[db] transaction() called but _db is null (DB not initialized or already closed)');
  try {
    _db.transaction(fn)();
  } catch (err) {
    log.error('[db] transaction rolled back:', err.message);
    throw err;
  }
}

/**
 * transaction() と同名で残しているが、better-sqlite3化により内部的には
 * 完全に同一の実装になっている（sql.js版にあった「_save()を呼ばない」という
 * 区別自体が、_save()がno-op化されたことで意味を持たなくなったため）。
 * 呼び出し側コードを変更せずに済むよう、関数としては残す。
 */
function transactionNoSave(fn) {
  if (!_db) throw new Error('[db] transactionNoSave() called but _db is null (DB not initialized or already closed)');
  try {
    _db.transaction(fn)();
  } catch (err) {
    log.error('[db] transactionNoSave rolled back:', err.message);
    throw err;
  }
}

/** transaction() と同一実装（呼び出し側互換のため関数名を維持）。 */
function runInTransaction(fn) {
  if (!_db) throw new Error('[db] runInTransaction() called but _db is null (DB not initialized or already closed)');
  _db.transaction(fn)();
}

/**
 * 互換用no-op。
 * sql.js時代は debounce付きの全体export+writeFileが必要だったが、
 * better-sqlite3は各文/トランザクションの実行と同時に直接ディスクへ
 * 反映するため、明示的なsave操作は不要になった。
 * 他モジュール(detailFetcher.js等)から呼ばれている箇所を変更せずに
 * 済むよう、関数自体は残している。
 */
function _save() { /* no-op: better-sqlite3 persists synchronously */ }

// ─── works ────────────────────────────────────────────────────────────────────

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

/** A: フェッチエラー記録、連続エラー数に応じてintervalを延ばす */
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

/**
 * circleGapScan の再開・ローテーション用: maker_id → 最後にチェックした時刻 のマップ。
 * circles テーブルに行が無い(=一度もdetail取得でupsertCircleされていない)
 * maker_idはマップに含まれない。呼び出し側は未登場のmaker_idを
 * 「未チェック(0扱い)」として扱うこと。
 */
function getCircleGapCheckedMap() {
  const rows = _all('SELECT maker_id, last_gap_checked FROM circles');
  return new Map(rows.map(r => [r.maker_id, r.last_gap_checked ?? 0]));
}

/**
 * circleGapScan がこのサークルの走査を完了したことを記録する。
 * circles テーブルに行が無い場合は作成する(INSERT ON CONFLICT)ため、
 * まだ一度もupsertCircleされていないサークルでも正しく記録できる
 * （circle_name等の他カラムは後続のdetail取得upsertCircleで補完される）。
 */
function markCircleGapChecked(makerId) {
  _run(`
    INSERT INTO circles (maker_id, last_gap_checked)
    VALUES (?, ?)
    ON CONFLICT(maker_id) DO UPDATE SET last_gap_checked = excluded.last_gap_checked
  `, [makerId, unixNow()]);
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

/** サークル巡回終了: サークル全体の優先度と間隔を通常値に戻す */
function resetCircleWorksPriority(makerId, priority, checkInterval) {
  _run(`
    UPDATE works
    SET priority = ?, check_interval = ?, next_check_at = last_checked + ?
    WHERE maker_id = ?
  `, [priority, checkInterval, checkInterval, makerId]);
}

// ─── price_history ─────────────────────────────────────────────────────────────

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
 * Returns { changed, consecutive_no_change }.
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

/**
 * CSV/JSONからの一括復旧インポート用（importData.jsから呼ばれる）。
 * importData.js側はファイル読み込み・パースのみを担当し、DB書き込みは
 * 全てここに委譲する。
 *
 * savePriceIfChanged()等の通常経路との違い:
 *   - prepared statementをループ全体で1回だけ用意し、使い回す
 *     （_run()は呼び出しごとにprepare()し直すため、数万行規模の
 *     インポートでは無視できないオーバーヘッドになる）。
 *   - price_history へは INSERT OR IGNORE を使う。(rj_code, checked_at) の
 *     UNIQUE INDEX（_applySchemaで追加済み）により、同じファイルを再度
 *     インポートしても重複行が増えない（冪等）。
 *   - 行ごとのSELECT diffは行わない（インポートは基本的に新規データの
 *     一括投入であり、差分検知は通常巡回の役割のため）。
 *
 * ジェネレータ関数: CHUNK件のRJコードを処理するたびに進捗をyieldする。
 * チャンクごとに better-sqlite3 のネイティブトランザクションで実行する
 * （途中で例外が起きても、そのチャンクだけロールバックされ、
 *  それ以前にyield済みの進捗はそのままディスクに残っている）。
 *
 * @param {Array<{rj_code,title,circle,maker_id,work_type,release_date,price,sale_price,discount_rate,point,checked_at}>} records
 * @param {{chunkSize?: number}} opts
 */
function* importHistoryRows(records, { chunkSize = 200 } = {}) {
  const byRj = new Map();
  let skippedNoRj = 0, skippedNoChecked = 0;

  for (const r of records) {
    if (!r.rj_code) { skippedNoRj++; continue; }
    const rj = String(r.rj_code).toUpperCase().trim();
    if (!/^RJ\d{4,}$/.test(rj)) { skippedNoRj++; continue; }
    if (!byRj.has(rj)) byRj.set(rj, []);
    byRj.get(rj).push(r);
  }
  for (const list of byRj.values()) {
    list.sort((a, b) => (a.checked_at ?? 0) - (b.checked_at ?? 0));
  }

  const rjCodes = [...byRj.keys()];
  const total = rjCodes.length;
  let worksImported = 0, priceRowsImported = 0, processed = 0;

  if (!total) {
    yield { processed: 0, total: 0, worksImported: 0, priceRowsImported: 0, skippedNoRj, skippedNoChecked };
    return;
  }

  const now = unixNow();

  const workStmt = _db.prepare(`
    INSERT INTO works
      (rj_code, title, circle, maker_id, work_type, site_id, release_date, dl_count, first_seen)
    VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(rj_code) DO UPDATE SET
      title        = COALESCE(excluded.title,        works.title),
      circle       = COALESCE(excluded.circle,       works.circle),
      maker_id     = COALESCE(excluded.maker_id,     works.maker_id),
      work_type    = COALESCE(excluded.work_type,    works.work_type),
      site_id      = COALESCE(excluded.site_id,      works.site_id),
      release_date = COALESCE(excluded.release_date, works.release_date)
  `);
  const priceStmt = _db.prepare(`
    INSERT OR IGNORE INTO price_history
      (rj_code, price, sale_price, point, discount_rate, is_on_sale, is_point_only, checked_at)
    VALUES (?,?,?,?,?,?,?,?)
  `);
  const curStmt = _db.prepare(`
    UPDATE works SET
      cur_price = ?, cur_sale_price = ?, cur_discount_rate = ?, cur_point = ?,
      cur_is_point_only = ?, price_checked_at = ?
    WHERE rj_code = ?
  `);
  // markChecked + boostWorkUrgent相当を1文に統合(next_check_at=nowで即due化)
  const scheduleStmt = _db.prepare(`
    UPDATE works SET
      last_checked = ?, check_interval = ?, priority = ?, is_on_sale = ?,
      consecutive_no_change = 0, consecutive_errors = 0, next_check_at = ?
    WHERE rj_code = ?
  `);

  const runChunk = _db.transaction((chunk) => {
    for (const rj of chunk) {
      const list   = byRj.get(rj);
      const latest = [...list].reverse().find(r => r.title) ?? list[list.length - 1];

      workStmt.run(
        rj, latest.title ?? null, latest.circle ?? null, latest.maker_id ?? null,
        latest.work_type ?? null, 'maniax', latest.release_date ?? null, 0, now,
      );
      worksImported++;

      let lastOnSale = 0, lastRow = null;
      for (const row of list) {
        if (row.checked_at == null) { skippedNoChecked++; continue; }
        const isOnSale = ((row.discount_rate ?? 0) > 0 || row.sale_price != null) ? 1 : 0;
        const info = priceStmt.run(
          rj, row.price ?? null, row.sale_price ?? null, row.point ?? null,
          row.discount_rate ?? null, isOnSale, 0, row.checked_at,
        );
        if (info.changes > 0) priceRowsImported++; // OR IGNOREで実際に挿入された行のみ
        lastOnSale = isOnSale;
        lastRow = row;
      }

      if (lastRow) {
        curStmt.run(
          lastRow.price ?? null, lastRow.sale_price ?? null, lastRow.discount_rate ?? null,
          lastRow.point ?? null, 0, lastRow.checked_at, rj,
        );
      }

      const priority = lastOnSale ? config.priority.onSale : config.priority.normal;
      scheduleStmt.run(now, config.checkInterval.normal, priority, lastOnSale, now, rj);
    }
  });

  for (let i = 0; i < rjCodes.length; i += chunkSize) {
    const chunk = rjCodes.slice(i, i + chunkSize);
    try {
      runChunk(chunk);
    } catch (err) {
      log.error('[db] importHistoryRows chunk rolled back:', err.message);
      throw err;
    }
    processed += chunk.length;
    yield { processed, total, worksImported, priceRowsImported, skippedNoRj, skippedNoChecked };
  }
}

function getPriceHistory(rjCode) {
  return _all(
    'SELECT * FROM price_history WHERE rj_code = ? ORDER BY checked_at ASC',
    [rjCode]
  );
}

// ─── circles ─────────────────────────────────────────────────────────────────

function upsertCircle(makerId, circleName) {
  _run(`
    INSERT INTO circles (maker_id, circle_name, works_count)
    VALUES (?,?,1)
    ON CONFLICT(maker_id) DO UPDATE SET
      circle_name = excluded.circle_name
  `, [makerId, circleName]);
}

/** works テーブルのmaker_id件数でcirclesを同期（正確なworks_count） */
function syncCircleWorksCounts() {
  _run(`
    UPDATE circles SET works_count = (
      SELECT COUNT(*) FROM works WHERE works.maker_id = circles.maker_id
    )
  `, []);
}

/** scheduler用: on_sale=1 のサークル一覧を返す */
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

// ─── 総集編マーク（comp_*） ────────────────────────────────────────────────────

/** ジャンル515一覧で見つかった「総集編“作品”」RJを候補キューへ追加(既存はスキップ) */
function addCompCandidates(rjCodes) {
  const now = unixNow();
  let added = 0;
  runInTransaction(() => {
    for (const rj of rjCodes) {
      const before = _get('SELECT 1 AS x FROM comp_candidates WHERE rj_code = ?', [rj]);
      if (before) continue;
      _run(`INSERT INTO comp_candidates (rj_code, discovered_at) VALUES (?, ?)`, [rj, now]);
      added++;
    }
  });
  return added;
}

/**
 * 詳細解析がまだの候補(processed_at IS NULL)を取得。古い順(FIFO)で公平に処理する。
 * 末尾000のゴーストRJコードは除外する（parser.js側で新規混入は止めたが、
 * 過去分の取りこぼしや将来の別経路からの混入に備えた防御的フィルタ）。
 */
function getDueCompCandidates(limit = 50) {
  return _all(
    `SELECT rj_code FROM comp_candidates
     WHERE processed_at IS NULL
       AND rj_code NOT LIKE '%000'
     ORDER BY discovered_at ASC LIMIT ?`,
    [limit]
  ).map(r => r.rj_code);
}

function markCompCandidateProcessed(rjCode, status = 'done') {
  runInTransaction(() => {
    _run(`UPDATE comp_candidates SET processed_at = ?, status = ? WHERE rj_code = ?`, [unixNow(), status, rjCode]);
  });
}

/**
 * 詳細ページ取得/解析が失敗した際に呼ぶ。404等の「確定的に消えた」ケースとは
 * 異なり、ネットワーク不調や一時的なDLsite側の不調である可能性があるため、
 * fail_count が maxAttempts に達するまでは processed_at を確定させず due の
 * まま残す(＝次回のcompScan実行で自然に再試行される)。達した時点でのみ
 * 諦めて processed_at を確定させる。
 */
function recordCompCandidateFetchFail(rjCode, status = 'fetch-failed', maxAttempts = 5) {
  runInTransaction(() => {
    const row      = _get('SELECT fail_count FROM comp_candidates WHERE rj_code = ?', [rjCode]);
    const attempts = (row?.fail_count ?? 0) + 1;
    if (attempts >= maxAttempts) {
      _run(`UPDATE comp_candidates SET processed_at = ?, status = ?, fail_count = ? WHERE rj_code = ?`,
        [unixNow(), status, attempts, rjCode]);
    } else {
      _run(`UPDATE comp_candidates SET fail_count = ? WHERE rj_code = ?`, [attempts, rjCode]);
    }
  });
}

/** 高信頼度（作品内容欄からの直接抽出）の収録関係を確定登録する */
function addCompWorksDirect(compilationRj, containedRjs) {
  if (!containedRjs.length) return 0;
  const now = unixNow();
  runInTransaction(() => {
    for (const rj of containedRjs) {
      _run(`
        INSERT INTO comp_works (compilation_rj, contained_rj, source, score, found_at)
        VALUES (?, ?, 'direct', NULL, ?)
        ON CONFLICT(compilation_rj, contained_rj) DO NOTHING
      `, [compilationRj, rj, now]);
    }
  });
  return containedRjs.length;
}

/** サークル同定推定で閾値以上のものは自動確定、未満は要確認キューへ */
function addCompCandidateScored(compilationRj, scoredList, threshold) {
  const now = unixNow();
  let confirmed = 0, pending = 0;
  runInTransaction(() => {
    for (const { rj, score, reasons } of scoredList) {
      if (score >= threshold) {
        _run(`
          INSERT INTO comp_works (compilation_rj, contained_rj, source, score, found_at)
          VALUES (?, ?, 'estimated', ?, ?)
          ON CONFLICT(compilation_rj, contained_rj) DO UPDATE SET score = excluded.score
        `, [compilationRj, rj, score, now]);
        confirmed++;
      } else {
        _run(`
          INSERT INTO comp_pending (compilation_rj, contained_rj, score, reasons, status, found_at)
          VALUES (?, ?, ?, ?, 'pending', ?)
          ON CONFLICT(compilation_rj, contained_rj) DO UPDATE SET score = excluded.score, reasons = excluded.reasons
        `, [compilationRj, rj, score, JSON.stringify(reasons ?? []), now]);
        pending++;
      }
    }
  });
  return { confirmed, pending };
}

function getCompPending({ status = 'pending', limit = 100, offset = 0 } = {}) {
  return _all(`
    SELECT p.*, cw.title AS compilation_title, ww.title AS contained_title
    FROM comp_pending p
    LEFT JOIN works cw ON cw.rj_code = p.compilation_rj
    LEFT JOIN works ww ON ww.rj_code = p.contained_rj
    WHERE p.status = ?
    ORDER BY p.found_at DESC
    LIMIT ? OFFSET ?
  `, [status, limit, offset]);
}

/** 要確認候補の承認/却下。承認時は comp_works(source='estimated')へ昇格する */
function decideCompPending(compilationRj, containedRj, decision) {
  const now = unixNow();
  runInTransaction(() => {
    if (decision === 'approved') {
      const row = _get('SELECT * FROM comp_pending WHERE compilation_rj = ? AND contained_rj = ?', [compilationRj, containedRj]);
      if (row) {
        _run(`
          INSERT INTO comp_works (compilation_rj, contained_rj, source, score, found_at)
          VALUES (?, ?, 'estimated', ?, ?)
          ON CONFLICT(compilation_rj, contained_rj) DO UPDATE SET score = excluded.score
        `, [compilationRj, containedRj, row.score, now]);
      }
    }
    _run(`
      UPDATE comp_pending SET status = ?, decided_at = ?
      WHERE compilation_rj = ? AND contained_rj = ?
    `, [decision, now, compilationRj, containedRj]);
  });
}

function getCompScanProgress() {
  return _get('SELECT * FROM comp_scan_progress WHERE id = 1')
    ?? { id: 1, listing_page: 1, listing_done: 0, updated_at: null };
}

function setCompScanProgress(patch) {
  const cur  = getCompScanProgress();
  const next = { ...cur, ...patch };
  runInTransaction(() => {
    _run(`
      INSERT INTO comp_scan_progress (id, listing_page, listing_done, updated_at)
      VALUES (1, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        listing_page = excluded.listing_page,
        listing_done = excluded.listing_done,
        updated_at   = excluded.updated_at
    `, [next.listing_page, next.listing_done ? 1 : 0, unixNow()]);
  });
}

/** 拡張機能互換のフラットなRJリスト（バッジ表示用途にそのまま使える） */
function getAllCompiledRjs() {
  return _all('SELECT DISTINCT contained_rj AS rj FROM comp_works').map(r => r.rj);
}

function getCompStats() {
  const row = _get(`
    SELECT
      (SELECT COUNT(*) FROM comp_candidates)                            AS candidates,
      (SELECT COUNT(*) FROM comp_candidates WHERE processed_at IS NULL) AS candidatesDue,
      (SELECT COUNT(DISTINCT compilation_rj) FROM comp_works)           AS compilationsConfirmed,
      (SELECT COUNT(DISTINCT contained_rj) FROM comp_works)             AS worksMarked,
      (SELECT COUNT(*) FROM comp_pending WHERE status = 'pending')      AS pendingReview
  `);
  return row ?? { candidates: 0, candidatesDue: 0, compilationsConfirmed: 0, worksMarked: 0, pendingReview: 0 };
}

// ─── price_issues（定価取得エラー追跡） ────────────────────────────────────────

/** 定価が信頼できる形で取得できなかった作品を記録（既存キーはoccurrences++で集計） */
function recordPriceIssue(rjCode, issueType, rawFields) {
  const now = unixNow();
  // detailFetcher._store() から db.transactionNoSave() のコールバック内で
  // ネストして呼ばれることがある。better-sqlite3のtransaction()はSAVEPOINTで
  // ネストに対応しているため、ここを runInTransaction() で囲んでも安全だが、
  // 単発のUPDATE/INSERTのみなので _run() 直呼びのままで十分。
  _run(`
    INSERT INTO price_issues (rj_code, issue_type, raw_fields, first_seen, last_seen, occurrences)
    VALUES (?, ?, ?, ?, ?, 1)
    ON CONFLICT(rj_code) DO UPDATE SET
      issue_type  = excluded.issue_type,
      raw_fields  = excluded.raw_fields,
      last_seen   = excluded.last_seen,
      occurrences = occurrences + 1
  `, [rjCode, issueType, JSON.stringify(rawFields ?? {}), now, now]);
}

/** 正常に定価が取れるようになったら呼ぶ（次回発生時はoccurrences=1から再カウント） */
function clearPriceIssue(rjCode) {
  _run(`DELETE FROM price_issues WHERE rj_code = ?`, [rjCode]);
}

function getPriceIssues({ limit = 500, offset = 0 } = {}) {
  return _all(`
    SELECT pi.*, w.title, w.circle
    FROM price_issues pi
    LEFT JOIN works w ON w.rj_code = pi.rj_code
    ORDER BY pi.last_seen DESC
    LIMIT ? OFFSET ?
  `, [limit, offset]);
}

function getPriceIssuesCount() {
  return (_get('SELECT COUNT(*) AS n FROM price_issues') ?? { n: 0 }).n;
}

// ─── stats ───────────────────────────────────────────────────────────────────

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

// ─── backup ──────────────────────────────────────────────────────────────────

/**
 * DBの世代管理付きバックアップ。
 *
 * better-sqlite3のネイティブオンラインバックアップAPI(`_db.backup()`)を使用。
 * SQLite本体がページ単位で安全にコピーするため、sql.js時代のように
 * DB全体(350MB超)をまずJSバッファへロードしてから書き出す必要がなく、
 * 巡回処理をブロックしない。
 *
 * 世代管理:
 *   - 直近7日分     : 毎日分をすべて保持
 *   - 直近8週間分   : 週1回分だけ保持（7日より古い分）
 *   - 直近12ヶ月分  : 月1回分だけ保持（8週間より古い分）
 *   - それ以上古い分: 削除
 *
 * 呼び出し側(scheduler.js)は同期関数として `db.backup()` を呼んでいるため、
 * 内部の非同期処理は fire-and-forget にしてシグネチャを維持している。
 */
function backup() {
  if (!_db) return;
  try {
    const dir = path.resolve(path.dirname(DB_PATH), 'backups');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const now      = new Date();
    const stamp    = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const dest     = path.join(dir, `dlsite-${stamp}.db`);
    const metaDest = path.join(dir, `dlsite-${stamp}.meta.json`);
    const tmpPath  = dest + '.tmp';

    _db.backup(tmpPath)
      .then(async () => {
        await fs.promises.rename(tmpPath, dest);

        const buf    = await fs.promises.readFile(dest);
        const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
        const counts = {
          works:        (_get('SELECT COUNT(*) AS n FROM works') ?? { n: 0 }).n,
          priceHistory: (_get('SELECT COUNT(*) AS n FROM price_history') ?? { n: 0 }).n,
          circles:      (_get('SELECT COUNT(*) AS n FROM circles') ?? { n: 0 }).n,
        };
        let appVersion = null;
        try { appVersion = require('../package.json').version; } catch { /* ignore */ }

        const meta = {
          timestamp: now.toISOString(),
          dbFile:    path.basename(dest),
          sizeBytes: buf.length,
          sha256,
          counts,
          appVersion,
        };
        await fs.promises.writeFile(metaDest, JSON.stringify(meta, null, 2));

        log.info('[db] backup saved', dest, `(${(buf.length / 1024 / 1024).toFixed(1)}MB, works=${counts.works})`);
        _pruneBackups(dir);
      })
      .catch(err => log.error('[db] backup error', err.message));
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

// ─── export (for CSV/JSON API) ────────────────────────────────────────────────

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

// ─── UI query helpers ──────────────────────────────────────────────────────────

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
 * better-sqlite3が同梱するSQLiteはwindow function(ROW_NUMBER等)を標準サポートしているため
 * sql.js時代のようなビルド差異による例外は基本的に発生しないが、
 * 呼び出し側(exportShards.js)の既存フォールバック処理はそのまま活かしておく。
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
  const result = _run(`
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
  const affected = result.changes;
  if (affected > 0) {
    log.info('[db] recoverSuspectedDelisted:', affected, '件を通常優先度に復旧', { minErrors, maxErrors });
  }
  return affected;
}

/** 全RJコードをSetで返す（discovery高速化用） */
// rj_code の全件取得は discovery が6時間毎に呼ぶため、インメモリキャッシュで高速化する。
// upsertWork が呼ばれたときにキャッシュを無効化する（次回 getAllRjCodes() 時に再構築）。
/**
 * 「本当に消えた/非公開になった」と判定済み(priority=delisted)の作品に
 * 救済処置を与える。真の削除だった場合でも安全: 次回チェックでAPIに
 * 存在しなければ detailFetcher.js が再び recordApiMissing() で隔離するだけ。
 *
 * 呼び出し元は2種類:
 *   1. discovery系スキャンでそのRJが再びDLsiteの一覧に出現した場合
 *      （再公開の直接的な証拠なので即座に救済する）
 *   2. scheduler の定期隔離再サンプリングジョブ（getQuarantinedWorks）
 *      （180日隔離されたままだと再公開されても最大180日気づけないため、
 *      定期的に少数を強制的にdueへ戻して確認する）
 */
function salvageWork(rjCode) {
  const now = unixNow();
  _run(`
    UPDATE works SET
      consecutive_errors = 0,
      priority             = ?,
      check_interval        = ?,
      next_check_at         = ?
    WHERE rj_code = ?
  `, [config.priority.normal, config.checkInterval.normal, now, rjCode]);
}

/**
 * 隔離(priority=delisted)中の作品を、最後にチェックした時刻が古い順に
 * limit件だけ返す。定期的にこの中からサンプリングしてsalvageWork()し、
 * 「本当に消えた」まま180日待たずに再公開を検知できるようにする。
 */
function getQuarantinedWorks(limit = 100) {
  return _all(`
    SELECT rj_code FROM works
    WHERE priority = ?
    ORDER BY last_checked ASC
    LIMIT ?
  `, [config.priority.delisted, limit]);
}

/** 隔離(priority=delisted)中の全RJコードをSetで返す(discovery再出現検知用) */
function getDelistedRjCodes() {
  return new Set(
    _all('SELECT rj_code FROM works WHERE priority = ?', [config.priority.delisted])
      .map(r => r.rj_code)
  );
}

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
  checkIntegrity,
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
  getCircleGapCheckedMap,
  markCircleGapChecked,
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
  salvageWork,
  getQuarantinedWorks,
  getDelistedRjCodes,
  getSampleRjForSite,
  addCompCandidates,
  getDueCompCandidates,
  markCompCandidateProcessed,
  recordCompCandidateFetchFail,
  addCompWorksDirect,
  addCompCandidateScored,
  getCompPending,
  decideCompPending,
  getCompScanProgress,
  setCompScanProgress,
  getAllCompiledRjs,
  getCompStats,
  recordPriceIssue,
  clearPriceIssue,
  getPriceIssues,
  getPriceIssuesCount,
  importHistoryRows,
};
