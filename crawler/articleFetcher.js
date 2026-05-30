'use strict';

/**
 * crawler/articleFetcher.js
 * ニュース記事の本文を取得・抽出する。
 * cheerio（既存依存）でHTMLをパースし、Readabilityライクに本文を抽出。
 * その後 translator.js で段落ごと日本語翻訳する。
 */

const cheerio = require('cheerio');
const log     = require('./logger');
const newsDb  = require('./newsDb');
const { translateParagraphs } = require('./translator');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── メインエントリ ──────────────────────────────────────────────────────────

async function fetchArticleContent(articleId) {
  const article = newsDb.getArticleById(articleId);
  if (!article) return { error: 'not found' };

  // 既にフェッチ済み
  if (article.content) return { cached: true, content: article.content, content_ja: article.content_ja };

  log.info('[articleFetcher] fetching', article.url);

  let html = null;
  try {
    const res = await fetch(article.url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,*/*',
        'Accept-Language': 'ja,en;q=0.9',
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    html = await res.text();
  } catch (e) {
    log.warn('[articleFetcher] fetch error', e.message);
    newsDb.markFetchFailed(articleId, e.message);
    return { error: e.message };
  }

  // 本文抽出
  const extracted = _extractContent(html, article.url);
  if (!extracted.text || extracted.text.length < 100) {
    const msg = 'content too short (' + (extracted.text?.length || 0) + ' chars)';
    newsDb.markFetchFailed(articleId, msg);
    return { error: msg };
  }

  // 日本語記事はそのまま保存、英語記事は翻訳
  let contentJa = null;
  if (article.lang === 'en') {
    try {
      contentJa = await translateParagraphs(extracted.paragraphs);
    } catch (e) {
      log.warn('[articleFetcher] translate error', e.message);
      contentJa = null;
    }
  } else {
    contentJa = extracted.text; // 既に日本語
  }

  // DB保存
  newsDb.saveArticleContent(articleId, extracted.text, contentJa, extracted.topImage);

  return {
    content:    extracted.text,
    content_ja: contentJa,
    top_image:  extracted.topImage,
    paragraphs: extracted.paragraphs,
  };
}

// ─── バッチ処理（スケジューラから呼ぶ） ────────────────────────────────────

async function runArticleFetchBatch(batchSize = 3) {
  const queue = newsDb.getContentFetchQueue(batchSize);
  if (!queue.length) return { fetched: 0 };

  log.info('[articleFetcher] batch', queue.length);
  let fetched = 0;

  for (const item of queue) {
    try {
      const result = await fetchArticleContent(item.id);
      if (!result.error) fetched++;
    } catch (e) {
      log.warn('[articleFetcher] batch error', item.id, e.message);
    }
    await sleep(2000); // 礼儀正しいクロール間隔
  }

  return { fetched };
}

// ─── 本文抽出（Readabilityライクな純JS実装） ─────────────────────────────────

function _extractContent(html, url) {
  const $ = cheerio.load(html);

  // 不要タグを削除
  $('script, style, noscript, iframe, nav, header, footer, aside, ' +
    '.ad, .ads, .advertisement, .social, .share, .related, .comment, ' +
    '.sidebar, .widget, .menu, .breadcrumb, .pagination, ' +
    '[class*="ad-"], [class*="ads-"], [id*="sidebar"], [id*="comment"]'
  ).remove();

  // OGP画像を先に取得
  const topImage =
    $('meta[property="og:image"]').attr('content') ||
    $('meta[name="twitter:image"]').attr('content') ||
    $('article img').first().attr('src') || null;

  // 本文候補セレクター（優先順位順）
  const CONTENT_SELECTORS = [
    'article', '[role="main"]', 'main',
    '.article-body', '.article-content', '.post-body', '.post-content',
    '.entry-content', '.entry-body', '.story-body', '.story-content',
    '.content-body', '.article__body', '.article__content',
    '.news-body', '.news-content', '.news-article',
    '#article-body', '#main-content', '#content',
    '.section-content', '.page-content',
  ];

  let $content = null;
  for (const sel of CONTENT_SELECTORS) {
    const el = $(sel).first();
    if (el.length && el.text().trim().length > 200) {
      $content = el;
      break;
    }
  }

  // セレクターで見つからなければスコアリング
  if (!$content) {
    $content = _scoreAndExtract($);
  }

  if (!$content) $content = $('body');

  // 段落抽出
  const paragraphs = [];
  $content.find('p, h1, h2, h3, h4, blockquote, li').each((_, el) => {
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    if (text.length > 20) {
      paragraphs.push({
        tag:  el.tagName.toLowerCase(),
        text,
      });
    }
  });

  // 段落が少なすぎる場合はfullText fallback
  let fullText;
  if (paragraphs.length < 3) {
    fullText = $content.text().replace(/\s+/g, ' ').trim();
  } else {
    fullText = paragraphs.map(p => p.text).join('\n\n');
  }

  return { text: fullText, paragraphs, topImage };
}

// テキスト密度スコアリングでコンテンツブロックを特定
function _scoreAndExtract($) {
  let best = null, bestScore = 0;

  $('div, section').each((_, el) => {
    const $el   = $(el);
    const text  = $el.text().trim();
    const links = $el.find('a').text().trim();
    const pCount = $el.find('p').length;

    if (text.length < 100) return;

    // リンクテキストが多い = ナビゲーション、除外
    const linkRatio = links.length / (text.length || 1);
    if (linkRatio > 0.5) return;

    const score = text.length * 0.5 + pCount * 30 - links.length * 0.3;
    if (score > bestScore) {
      bestScore = score;
      best = $el;
    }
  });

  return best;
}

module.exports = { fetchArticleContent, runArticleFetchBatch };
