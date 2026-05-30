'use strict';

/**
 * crawler/newsDb.js
 * ニュース記事のDB操作。
 * メインのdb.jsとは別のSQLiteファイルを使用。
 */

const initSqlJs = require('sql.js');
const fs   = require('fs');
const path = require('path');
const log  = require('./logger');

let _db  = null;
let _SQL = null;

const _exeDir = process.env.PORTABLE_EXECUTABLE_DIR
  || (process.resourcesPath ? path.join(process.resourcesPath, '..') : null)
  || process.cwd();
const DB_PATH = path.resolve(_exeDir, './news.db');

// ─── 初期化 ─────────────────────────────────────────────────────────────────

async function init() {
  if (_db) return;

  _SQL = await initSqlJs({
    locateFile: file => {
      if (process.resourcesPath) return path.join(process.resourcesPath, file);
      if (process.pkg) return path.join(path.dirname(process.execPath), file);
      return path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', file);
    },
  });

  if (fs.existsSync(DB_PATH)) {
    _db = new _SQL.Database(fs.readFileSync(DB_PATH));
  } else {
    _db = new _SQL.Database();
  }

  _applySchema();
  // content カラムがなければ追加（既存DBへの互換マイグレーション）
  try { _db.run('ALTER TABLE news_articles ADD COLUMN content      TEXT'); } catch(_) {}
  try { _db.run('ALTER TABLE news_articles ADD COLUMN content_ja   TEXT'); } catch(_) {}
  try { _db.run('ALTER TABLE news_articles ADD COLUMN top_image    TEXT'); } catch(_) {}
  try { _db.run('ALTER TABLE news_articles ADD COLUMN content_fetched_at INTEGER'); } catch(_) {}
  try { _db.run('ALTER TABLE news_articles ADD COLUMN fetch_error  TEXT'); } catch(_) {}

  _save();
  log.info('[newsDb] ready', DB_PATH);
}

function _applySchema() {
  _db.run(`
    CREATE TABLE IF NOT EXISTS news_articles (
      id            TEXT    PRIMARY KEY,
      source_id     TEXT    NOT NULL,
      source_name   TEXT    NOT NULL,
      category      TEXT    NOT NULL,
      lang          TEXT    NOT NULL DEFAULT 'en',
      title         TEXT    NOT NULL,
      url           TEXT    NOT NULL,
      description   TEXT,
      pub_date      INTEGER,
      fetched_at    INTEGER NOT NULL,
      title_ja      TEXT,
      desc_ja       TEXT,
      translated_at INTEGER
    );

    -- 本文カラム（ALTER TABLE で後から追加）
    CREATE TABLE IF NOT EXISTS news_translation_queue (
      article_id  TEXT PRIMARY KEY,
      queued_at   INTEGER NOT NULL,
      attempts    INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS news_content_queue (
      article_id   TEXT PRIMARY KEY,
      queued_at    INTEGER NOT NULL,
      attempts     INTEGER DEFAULT 0,
      last_error   TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_news_source   ON news_articles(source_id);
    CREATE INDEX IF NOT EXISTS idx_news_category ON news_articles(category);
    CREATE INDEX IF NOT EXISTS idx_news_pub_date ON news_articles(pub_date DESC);
    CREATE INDEX IF NOT EXISTS idx_news_lang     ON news_articles(lang);
  `);
}

function _save() {
  fs.writeFileSync(DB_PATH, Buffer.from(_db.export()));
}

// ─── 記事操作 ───────────────────────────────────────────────────────────────

/** 記事をupsert。新規追加の場合trueを返す */
function upsertArticle(article) {
  const stmt = _db.prepare(
    'SELECT id FROM news_articles WHERE id = ?'
  );
  stmt.bind([article.id]);
  const exists = stmt.step();
  stmt.free();

  if (exists) return false;

  _db.run(`
    INSERT OR IGNORE INTO news_articles
      (id, source_id, source_name, category, lang, title, url, description,
       pub_date, fetched_at, title_ja, desc_ja, translated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `, [
    article.id, article.source_id, article.source_name, article.category,
    article.lang, article.title, article.url, article.description || null,
    article.pub_date, article.fetched_at,
    article.title_ja || null, article.desc_ja || null, article.translated_at || null,
  ]);
  _save();
  return true;
}

/** 翻訳キューに追加 */
function queueTranslation(articleId) {
  _db.run(
    'INSERT OR IGNORE INTO news_translation_queue (article_id, queued_at) VALUES (?,?)',
    [articleId, Math.floor(Date.now() / 1000)]
  );
  _save();
}

/** 翻訳待ち記事を取得 */
function getTranslationQueue(limit = 10) {
  const stmt = _db.prepare(`
    SELECT a.id, a.title, a.description
    FROM news_translation_queue q
    JOIN news_articles a ON a.id = q.article_id
    WHERE a.title_ja IS NULL
    ORDER BY q.queued_at ASC
    LIMIT ?
  `);
  stmt.bind([limit]);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

/** 翻訳結果を保存 */
function saveTranslation(articleId, titleJa, descJa) {
  _db.run(`
    UPDATE news_articles
    SET title_ja = ?, desc_ja = ?, translated_at = ?
    WHERE id = ?
  `, [titleJa || null, descJa || null, Math.floor(Date.now() / 1000), articleId]);

  _db.run(
    'DELETE FROM news_translation_queue WHERE article_id = ?',
    [articleId]
  );
  _save();
}

/** 記事一覧取得（ページネーション付き） */
function getArticles({ category = null, lang = null, page = 1, limit = 30, q = null, sourceId = null } = {}) {
  const offset = (Math.max(1, page) - 1) * limit;
  let where = 'WHERE 1=1';
  const params = [];

  if (category) { where += ' AND category = ?'; params.push(category); }
  if (lang)     { where += ' AND lang = ?';     params.push(lang); }
  if (sourceId) { where += ' AND source_id = ?'; params.push(sourceId); }
  if (q) {
    where += ' AND (title LIKE ? OR title_ja LIKE ? OR description LIKE ?)';
    const like = '%' + q + '%';
    params.push(like, like, like);
  }

  const countStmt = _db.prepare(`SELECT COUNT(*) AS n FROM news_articles ${where}`);
  countStmt.bind(params);
  const total = countStmt.step() ? countStmt.getAsObject().n : 0;
  countStmt.free();

  const stmt = _db.prepare(`
    SELECT * FROM news_articles ${where}
    ORDER BY pub_date DESC
    LIMIT ? OFFSET ?
  `);
  stmt.bind([...params, limit, offset]);
  const articles = [];
  while (stmt.step()) articles.push(stmt.getAsObject());
  stmt.free();

  return { articles, total, page, pages: Math.ceil(total / limit) };
}

/** カテゴリ別統計 */
function getNewsStats() {
  const stmt = _db.prepare(`
    SELECT category, lang, COUNT(*) AS n,
           SUM(CASE WHEN title_ja IS NOT NULL THEN 1 ELSE 0 END) AS translated
    FROM news_articles
    GROUP BY category, lang
    ORDER BY n DESC
  `);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();

  const total = _db.prepare('SELECT COUNT(*) AS n FROM news_articles');
  total.step();
  const totalCount = total.getAsObject().n;
  total.free();

  return { byCategory: rows, total: totalCount };
}

/** IDで記事1件取得 */
function getArticleById(id) {
  const stmt = _db.prepare('SELECT * FROM news_articles WHERE id = ?');
  stmt.bind([id]);
  const row = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();
  return row;
}

/** 本文フェッチキューに追加 */
function queueContentFetch(articleId) {
  _db.run(
    'INSERT OR IGNORE INTO news_content_queue (article_id, queued_at) VALUES (?,?)',
    [articleId, Math.floor(Date.now() / 1000)]
  );
  _save();
}

/** 本文フェッチキュー取得 */
function getContentFetchQueue(limit = 3) {
  const stmt = _db.prepare(`
    SELECT a.id, a.url, a.lang
    FROM news_content_queue q
    JOIN news_articles a ON a.id = q.article_id
    WHERE a.content IS NULL AND (q.attempts < 3)
    ORDER BY q.queued_at ASC
    LIMIT ?
  `);
  stmt.bind([limit]);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

/** 本文保存 */
function saveArticleContent(articleId, content, contentJa, topImage) {
  _db.run(`
    UPDATE news_articles
    SET content = ?, content_ja = ?, top_image = ?, content_fetched_at = ?, fetch_error = NULL
    WHERE id = ?
  `, [content || null, contentJa || null, topImage || null,
      Math.floor(Date.now() / 1000), articleId]);
  _db.run('DELETE FROM news_content_queue WHERE article_id = ?', [articleId]);
  _save();
}

/** フェッチ失敗を記録 */
function markFetchFailed(articleId, error) {
  _db.run(`
    UPDATE news_content_queue
    SET attempts = attempts + 1, last_error = ?
    WHERE article_id = ?
  `, [error, articleId]);
  _db.run(
    'UPDATE news_articles SET fetch_error = ? WHERE id = ?',
    [error, articleId]
  );
  _save();
}

module.exports = {
  init,
  upsertArticle,
  queueTranslation,
  getTranslationQueue,
  saveTranslation,
  getArticles,
  getNewsStats,
  getArticleById,
  queueContentFetch,
  getContentFetchQueue,
  saveArticleContent,
  markFetchFailed,
};
