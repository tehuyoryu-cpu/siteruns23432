'use strict';

/**
 * crawler/newsCrawler.js
 * ニュースサイトのRSSフィードを取得し、記事を収集。
 * カテゴリ別にサイトを整理して定期クロール。
 */

const { fetchWithRetry, sleep } = require('./queue');
const log    = require('./logger');
const newsDb = require('./newsDb');
const { translateArticle } = require('./translator');

// ─── RSSフィード定義 ──────────────────────────────────────────────────────────

const NEWS_SOURCES = [
  // ネット・バズ・カルチャー系
  { id: 'netorabo',    name: 'ねとらぼ',           url: 'https://nlab.itmedia.co.jp/rss/2.0/index.rdf',          lang: 'ja', category: 'culture' },
  { id: 'buzzfeedjp',  name: 'BuzzFeed Japan',     url: 'https://www.buzzfeed.com/jp.xml',                        lang: 'ja', category: 'culture' },
  { id: 'buzzfeed',    name: 'BuzzFeed',            url: 'https://www.buzzfeed.com/index.xml',                     lang: 'en', category: 'culture' },
  { id: 'jtownet',     name: 'Jタウンネット',        url: 'https://j-town.net/feed',                               lang: 'ja', category: 'culture' },
  { id: 'otakuma',     name: 'おたくま経済新聞',     url: 'https://otakumachi.jp/feed/',                            lang: 'ja', category: 'culture' },
  { id: 'kai_you',     name: 'KAI-YOU',             url: 'https://kai-you.net/feed',                               lang: 'ja', category: 'culture' },
  { id: 'mashable',    name: 'Mashable',            url: 'https://mashable.com/feeds/rss/all',                     lang: 'en', category: 'culture' },
  { id: 'boredpanda',  name: 'Bored Panda',         url: 'https://www.boredpanda.com/feed/',                       lang: 'en', category: 'culture' },

  // テック・AIニュース系
  { id: 'techcrunch',  name: 'TechCrunch',          url: 'https://techcrunch.com/feed/',                           lang: 'en', category: 'tech' },
  { id: 'tcjp',        name: 'TechCrunch Japan',    url: 'https://jp.techcrunch.com/feed/',                        lang: 'ja', category: 'tech' },
  { id: 'arstechnica', name: 'Ars Technica',        url: 'https://feeds.arstechnica.com/arstechnica/index',        lang: 'en', category: 'tech' },
  { id: 'theverge',    name: 'The Verge',           url: 'https://www.theverge.com/rss/index.xml',                 lang: 'en', category: 'tech' },
  { id: 'wired',       name: 'Wired',               url: 'https://www.wired.com/feed/rss',                         lang: 'en', category: 'tech' },
  { id: 'wiredjp',     name: 'WIRED Japan',         url: 'https://wired.jp/feed/',                                 lang: 'ja', category: 'tech' },
  { id: 'mit_tech',    name: 'MIT Technology Review', url: 'https://www.technologyreview.com/feed/',               lang: 'en', category: 'tech' },
  { id: 'venturebeat', name: 'VentureBeat',         url: 'https://venturebeat.com/feed/',                          lang: 'en', category: 'tech' },
  { id: 'engadget',    name: 'Engadget',            url: 'https://www.engadget.com/rss.xml',                       lang: 'en', category: 'tech' },
  { id: 'cnet',        name: 'CNET',                url: 'https://www.cnet.com/rss/all/',                          lang: 'en', category: 'tech' },
  { id: 'cnetjp',      name: 'CNET Japan',          url: 'https://japan.cnet.com/index.rdf',                       lang: 'ja', category: 'tech' },
  { id: 'zdnet',       name: 'ZDNet',               url: 'https://www.zdnet.com/news/rss.xml',                     lang: 'en', category: 'tech' },
  { id: 'itmedia',     name: 'ITmedia',             url: 'https://rss.itmedia.co.jp/rss/2.0/itmedia_all.xml',      lang: 'ja', category: 'tech' },
  { id: 'gigazine',    name: 'GIGAZINE',            url: 'https://gigazine.net/news/rss_2.0/',                     lang: 'ja', category: 'tech' },

  // ビジネス・経済ニュース系
  { id: 'businessinsider', name: 'Business Insider', url: 'https://www.businessinsider.com/rss',                  lang: 'en', category: 'business' },
  { id: 'bijp',        name: 'Business Insider Japan', url: 'https://www.businessinsider.jp/feed/index.xml',      lang: 'ja', category: 'business' },
  { id: 'reuters',     name: 'Reuters',             url: 'https://feeds.reuters.com/reuters/topNews',              lang: 'en', category: 'business' },
  { id: 'cnbc',        name: 'CNBC',                url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html',  lang: 'en', category: 'business' },
  { id: 'forbes',      name: 'Forbes',              url: 'https://www.forbes.com/real-time/feed2/',                lang: 'en', category: 'business' },
  { id: 'forbesjp',    name: 'Forbes JAPAN',        url: 'https://forbesjapan.com/feed',                          lang: 'ja', category: 'business' },
  { id: 'toyokeizai',  name: '東洋経済オンライン',   url: 'https://toyokeizai.net/list/feed/rss',                   lang: 'ja', category: 'business' },
  { id: 'diamond',     name: 'ダイヤモンド・オンライン', url: 'https://diamond.jp/feed/index.rss',                 lang: 'ja', category: 'business' },
  { id: 'gendai',      name: '現代ビジネス',         url: 'https://gendai.media/rss',                               lang: 'ja', category: 'business' },

  // ゲームニュース系
  { id: 'ign',         name: 'IGN',                 url: 'https://www.ign.com/rss/articles',                       lang: 'en', category: 'game' },
  { id: 'polygon',     name: 'Polygon',             url: 'https://www.polygon.com/rss/index.xml',                  lang: 'en', category: 'game' },
  { id: 'kotaku',      name: 'Kotaku',              url: 'https://kotaku.com/rss',                                  lang: 'en', category: 'game' },
  { id: 'dexerto',     name: 'Dexerto',             url: 'https://www.dexerto.com/feed/',                          lang: 'en', category: 'game' },
  { id: 'famitsu',     name: 'Famitsu',             url: 'https://www.famitsu.com/rss/famitsu/all.xml',            lang: 'ja', category: 'game' },

  // アニメ・漫画・サブカル系
  { id: 'ann',         name: 'Anime News Network', url: 'https://www.animenewsnetwork.com/all/rss.xml',            lang: 'en', category: 'anime' },
  { id: 'comicnatalie', name: 'Comic Natalie',     url: 'https://natalie.mu/comic/feed/news',                      lang: 'ja', category: 'anime' },

  // 映画・エンタメ系
  { id: 'variety',     name: 'Variety',             url: 'https://variety.com/feed/',                              lang: 'en', category: 'entertainment' },
  { id: 'deadline',    name: 'Deadline Hollywood',  url: 'https://deadline.com/feed/',                             lang: 'en', category: 'entertainment' },
  { id: 'hollywoodreporter', name: 'The Hollywood Reporter', url: 'https://www.hollywoodreporter.com/feed/',       lang: 'en', category: 'entertainment' },

  // 音楽系
  { id: 'billboard',   name: 'Billboard',           url: 'https://www.billboard.com/feed/',                        lang: 'en', category: 'music' },
  { id: 'pitchfork',   name: 'Pitchfork',           url: 'https://pitchfork.com/rss/news/',                        lang: 'en', category: 'music' },
  { id: 'rollingstone', name: 'Rolling Stone',      url: 'https://www.rollingstone.com/feed/',                     lang: 'en', category: 'music' },
  { id: 'nme',         name: 'NME',                 url: 'https://www.nme.com/feed',                               lang: 'en', category: 'music' },

  // 科学・宇宙系
  { id: 'newscientist', name: 'New Scientist',      url: 'https://www.newscientist.com/feed/home/',                 lang: 'en', category: 'science' },
  { id: 'spacecom',    name: 'Space.com',           url: 'https://www.space.com/feeds/all',                        lang: 'en', category: 'science' },
  { id: 'nasa',        name: 'NASA',                url: 'https://www.nasa.gov/rss/dyn/breaking_news.rss',          lang: 'en', category: 'science' },
];

// ─── メインクロール ───────────────────────────────────────────────────────────

async function runNewsCrawl({ maxPerSource = 10, translateAll = true } = {}) {
  log.info('[news] crawl start, sources:', NEWS_SOURCES.length);
  let total = 0, errors = 0;

  for (const source of NEWS_SOURCES) {
    try {
      const items = await _fetchRss(source, maxPerSource);
      if (!items.length) continue;

      let added = 0;
      for (const item of items) {
        const isNew = newsDb.upsertArticle(item);
        if (isNew) {
          added++;
          // 英語記事は翻訳キューに追加
          if (source.lang === 'en' && translateAll) {
            newsDb.queueTranslation(item.id);
          }
        }
      }
      if (added > 0) log.info('[news]', source.name, '+' + added);
      total += added;
      await sleep(800);
    } catch (err) {
      log.warn('[news] source error', source.name, err.message);
      errors++;
    }
  }

  log.info('[news] crawl done', { total, errors });

  // 翻訳キューを処理
  if (translateAll) {
    await _processTranslationQueue();
  }

  return { total, errors };
}

// ─── RSSフェッチ ──────────────────────────────────────────────────────────────

async function _fetchRss(source, maxItems) {
  try {
    const res = await fetchWithRetry(source.url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; NewsBot/1.0)',
        'Accept': 'application/rss+xml, application/xml, text/xml, */*',
      }
    });
    if (!res.ok) {
      log.warn('[news] RSS fetch failed', source.name, res.status);
      return [];
    }
    const text = await res.text();
    return _parseRss(text, source, maxItems);
  } catch (e) {
    log.warn('[news] RSS error', source.name, e.message);
    return [];
  }
}

// ─── RSSパーサー（依存ゼロ、純粋正規表現） ───────────────────────────────────

function _parseRss(xml, source, maxItems) {
  const items = [];

  // Atom と RSS 両対応
  const isAtom = xml.includes('<feed');
  const entryTag = isAtom ? 'entry' : 'item';

  const entries = _extractAll(xml, entryTag);
  if (!entries.length) return [];

  for (const entry of entries.slice(0, maxItems)) {
    try {
      const title   = _decodeHtml(_extractText(entry, 'title'));
      const link    = _extractLink(entry, isAtom);
      const pubDate = _extractDate(entry, isAtom);
      const desc    = _decodeHtml(_stripTags(_extractText(entry, isAtom ? 'summary' : 'description'))).slice(0, 400);
      const guid    = _extractText(entry, 'guid') || _extractText(entry, 'id') || link;

      if (!title || !link) continue;

      const id = source.id + ':' + _hashStr(guid || link);

      items.push({
        id,
        source_id:   source.id,
        source_name: source.name,
        category:    source.category,
        lang:        source.lang,
        title,
        url:         link,
        description: desc,
        pub_date:    pubDate ? Math.floor(new Date(pubDate).getTime() / 1000) : Math.floor(Date.now() / 1000),
        fetched_at:  Math.floor(Date.now() / 1000),
        title_ja:    null,
        desc_ja:     null,
        translated_at: null,
      });
    } catch (_) {}
  }

  return items;
}

function _extractAll(xml, tag) {
  const results = [];
  const re = new RegExp(`<${tag}[\\s>]([\\s\\S]*?)<\\/${tag}>`, 'gi');
  let m;
  while ((m = re.exec(xml)) !== null) results.push(m[1]);
  return results;
}

function _extractText(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}(?:[^>]*)>\\s*(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?\\s*<\\/${tag}>`, 'i'));
  return m ? m[1].trim() : '';
}

function _extractLink(entry, isAtom) {
  if (isAtom) {
    const m = entry.match(/<link[^>]+href=["']([^"']+)["']/i);
    if (m) return m[1];
  }
  return _extractText(entry, 'link') || entry.match(/<link>([^<]+)<\/link>/i)?.[1] || '';
}

function _extractDate(entry, isAtom) {
  if (isAtom) {
    return _extractText(entry, 'published') || _extractText(entry, 'updated');
  }
  return _extractText(entry, 'pubDate') || _extractText(entry, 'dc:date');
}

function _decodeHtml(s) {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}

function _stripTags(s) {
  return s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function _hashStr(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (h * 33 ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

// ─── 翻訳キュー処理 ──────────────────────────────────────────────────────────

async function _processTranslationQueue(batchSize = 5) {
  const queue = newsDb.getTranslationQueue(batchSize);
  if (!queue.length) return;

  log.info('[news] translating', queue.length, 'articles');

  for (const article of queue) {
    try {
      const result = await translateArticle(article.title, article.description);
      newsDb.saveTranslation(article.id, result.title, result.description);
      await sleep(1500); // レート制限対策
    } catch (err) {
      log.warn('[news] translate error', article.id, err.message);
    }
  }
}

module.exports = { runNewsCrawl, NEWS_SOURCES };
