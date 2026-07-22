'use strict';

/**
 * crawler/compAnalyzer.js
 * 総集編（コンピレーション）構造解析エンジン。
 * 拡張機能(comp_analyzer.js)からの移植 — DOMParser依存部分をcheerioに置換した以外は
 * スコアリングロジックを変更していない。
 */

const cheerio = require('cheerio');
const log     = require('./logger');

const THRESHOLD = 60;

// ─── イベント名の正規化 ────────────────────────────────────────────────────────

const _EVENT_DICT = {
  "コミックマーケット": "comiket", "コミケ": "comiket", "comiket": "comiket",
  "例大祭": "reitaisai", "博麗神社例大祭": "reitaisai", "れいたいさい": "reitaisai",
  "comic1": "comic1", "コミック1": "comic1", "こみっく1": "comic1",
  "m3": "m3", "えむすりー": "m3", "エムスリー": "m3",
  "ボイスフェスタ": "voicefesta", "ぼいすふぇすた": "voicefesta",
  "サンクリ": "suncre", "サンシャインクリエイション": "suncre",
  "紅楼夢": "kouroumu", "東方紅楼夢": "kouroumu",
};

function normalizeEvent(ev) {
  if (!ev) return "";
  let s = ev.replace(/[第回]\d+/g, "").replace(/\s/g, "").toLowerCase();
  s = s.replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  for (const [k, v] of Object.entries(_EVENT_DICT)) {
    if (s.startsWith(k.toLowerCase())) return v;
  }
  return s;
}

// ─── タイトル正規化・類似度 ────────────────────────────────────────────────────

const _NOISE   = /総集編|まとめ|BEST|best|Complete|complete|Collection|collection|Full\s*Pack|再録|番外編|[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩⅰⅱⅲⅳⅴⅵⅶⅷⅸⅹ]/g;
const _NUM_SFX = /[\s　]*[第]?[\d０-９一二三四五六七八九十百]+[弾話冊本作品件巻]?$/;

function normalizeTitle(t) {
  return (t || "").replace(_NOISE, "").replace(_NUM_SFX, "").replace(/[\s　]+/g, " ").trim();
}

function bigramSet(s) {
  const r = new Set();
  for (let i = 0; i < s.length - 1; i++) r.add(s.slice(i, i + 2));
  return r;
}
function ngramSim(a, b) {
  if (!a || !b) return 0;
  const ga = bigramSet(a), gb = bigramSet(b);
  if (!ga.size || !gb.size) return 0;
  let c = 0; ga.forEach(g => { if (gb.has(g)) c++; });
  return (2 * c) / (ga.size + gb.size);
}
function longestCommonPrefix(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return a.slice(0, i).trim();
}

// ─── 日付比較 ─────────────────────────────────────────────────────────────────

function dateDiffDays(a, b) {
  if (!a || !b) return null;
  const da = new Date(a.replace(/年|月/g, "-").replace("日", ""));
  const db = new Date(b.replace(/年|月/g, "-").replace("日", ""));
  if (isNaN(da) || isNaN(db)) return null;
  return Math.abs(da - db) / 86_400_000;
}

function isCandAfterComp(compDate, candDate) {
  if (!compDate || !candDate) return false;
  const dc = new Date(compDate.replace(/年|月/g, "-").replace("日", ""));
  const dd = new Date(candDate.replace(/年|月/g, "-").replace("日", ""));
  if (isNaN(dc) || isNaN(dd)) return false;
  return dd > dc;
}

// ─── ページ数組合せ探索 ─────────────────────────────────────────────────────────

function* _combos(arr, k) {
  if (k === 0) { yield []; return; }
  for (let i = 0; i <= arr.length - k; i++)
    for (const r of _combos(arr.slice(i + 1), k - 1)) yield [arr[i], ...r];
}

function findPageSubset(total, workCount, candidates) {
  const valid = candidates.filter(c => c.pageCount > 0);
  if (!total || !valid.length) return null;
  const tol = Math.max(5, Math.ceil(total * 0.05));
  if (workCount > 0 && workCount <= 8 && valid.length <= 20) {
    for (const combo of _combos(valid, Math.min(workCount, valid.length))) {
      if (Math.abs(combo.reduce((s, c) => s + c.pageCount, 0) - total) <= tol) return combo;
    }
  }
  const sorted = [...valid].sort((a, b) => b.pageCount - a.pageCount);
  const res = []; let rem = total;
  for (const c of sorted) {
    if (c.pageCount <= rem + tol) { res.push(c); rem -= c.pageCount; }
    if (Math.abs(rem) <= tol) return res;
  }
  return null;
}

// ─── HTML解析（cheerio） ───────────────────────────────────────────────────────

function parseCompMeta(html, selfRJ) {
  const $    = cheerio.load(html);
  const body = $('body').text() || '';

  let circleId = "";
  $("a[href*='maker_id']").each((_, el) => {
    if (circleId) return;
    const href = $(el).attr('href') || '';
    const m = href.match(/maker_id[/=]([A-Z0-9]+)/i);
    if (m) circleId = m[1];
  });
  if (!circleId) {
    const m = html.match(/"maker_id"\s*:\s*"([A-Z0-9]+)"/i);
    if (m) circleId = m[1];
  }

  let pageCount = 0;
  const pm = body.match(/(\d{2,4})\s*[Pp](?:age)?(?:[^a-zA-Z]|$)/) || body.match(/ページ数[：:]\s*(\d+)/);
  if (pm) pageCount = parseInt(pm[1], 10);

  let workCount = 0;
  const wm = body.match(/全?\s*(\d+)\s*(?:作品|本|タイトル|話)(?:を)?[収録掲載]/)
          || body.match(/(\d+)\s*(?:作品|タイトル)(?:を)?収録/)
          || body.match(/収録(?:作品|タイトル)数[：:]\s*(\d+)/);
  if (wm) workCount = parseInt(wm[1], 10);

  const title =
    $("h1.work_name,[itemprop='name']").first().text().trim()
    || $('title').text().split('|')[0].trim()
    || "";

  let releaseDate = "";
  const dateEl = $("[class*='regist_date'] td,[itemprop='datePublished']").first();
  if (dateEl.length) releaseDate = dateEl.text().trim();
  if (!releaseDate) {
    const dm = body.match(/\d{4}年\d{1,2}月\d{1,2}日/);
    if (dm) releaseDate = dm[0];
  }

  let price = 0;
  const pm2 = body.match(/(\d{1,3}(?:,\d{3})*)\s*円/);
  if (pm2) price = parseInt(pm2[1].replace(/,/g, ''), 10) || 0;

  const events = [];
  $("td a[href*='event_id'], span.work_genre a[href*='event']").each((_, el) => {
    const t = $(el).text().trim();
    if (t && t.length < 40) events.push(t);
  });

  const tags = [];
  $("a[href*='genre_id'], .work_genre a[href*='genre']").each((_, el) => {
    const t = $(el).text().trim();
    if (t && t !== "総集編") tags.push(t);
  });

  return { rj: selfRJ.toUpperCase(), circleId, title, pageCount, workCount, releaseDate, events, tags, price };
}

function parseCandidatesFromSearch(html, selfRJ) {
  const $   = cheerio.load(html);
  const map = new Map();
  $("a[href*='/product_id/RJ']").each((_, el) => {
    const href = $(el).attr('href') || '';
    const m = href.match(/\/product_id\/(RJ\d{4,})\.html/i);
    if (!m) return;
    const rj = m[1].toUpperCase();
    if (rj === selfRJ || map.has(rj)) return;
    const $el   = $(el);
    const title = $el.attr('title')?.trim()
      || $el.text().trim()
      || $el.find('img').attr('alt')?.trim()
      || "";
    map.set(rj, title || "");
  });
  return map;
}

/**
 * 作品詳細ページ → 収録作品RJ（優先順位: 作品内容セクション → ページ全体の product_id リンク）
 */
function extractDetailRJs(html, selfRJ) {
  const self  = selfRJ.toUpperCase();
  const rjSet = new Set();

  try {
    const $ = cheerio.load(html);

    let $content = null;
    $(".work_parts_title, h2, h3, dt").each((_, el) => {
      if ($content) return;
      const t = $(el).text().trim();
      if (t.includes("作品内容") || t.includes("収録") || t.includes("内容")) {
        const $el = $(el);
        const closest = $el.closest('.work_parts').length ? $el.closest('.work_parts')
          : $el.closest('.work_parts_container').length ? $el.closest('.work_parts_container')
          : $el.parent();
        if (closest && closest.length) $content = closest;
      }
    });

    if (!$content || !$content.length) $content = $('#work_outline');
    if (!$content || !$content.length) $content = $('.work_parts_container');
    if (!$content || !$content.length) $content = $('body');

    if ($content && $content.length) {
      [...$content.text().matchAll(/RJ\d{4,}/gi)].forEach(m => rjSet.add(m[0].toUpperCase()));

      $content.find('a[href]').each((_, a) => {
        const href = $(a).attr('href') || '';
        const m = href.match(/\/product_id\/(RJ\d{4,})/i);
        if (m) rjSet.add(m[1].toUpperCase());
      });
    }

    if (rjSet.size === 0 || (rjSet.size === 1 && rjSet.has(self))) {
      $("a[href*='/product_id/RJ']").each((_, a) => {
        const href = $(a).attr('href') || '';
        const m = href.match(/\/product_id\/(RJ\d{4,})/i);
        if (m) rjSet.add(m[1].toUpperCase());
      });
    }
  } catch (e) {
    log.warn('[compAnalyzer] extractDetailRJs cheerio失敗、regexフォールバック', e.message);
    [...html.matchAll(/RJ\d{4,}/gi)].forEach(m => rjSet.add(m[0].toUpperCase()));
  }

  rjSet.delete(self);
  return [...rjSet];
}

// ─── スコアリング ─────────────────────────────────────────────────────────────

function scoreCandidate(comp, cand) {
  let score = 0; const why = [];
  const cn = normalizeTitle(comp.title);
  const dn = normalizeTitle(cand.title);

  let titleScore = 0;
  const prefix = longestCommonPrefix(cn, dn);
  if (prefix.length >= 3) {
    const ratio = prefix.length / Math.max(cn.length, 1);
    if (ratio >= 0.6)      { titleScore += 70; why.push(`シリーズ一致「${prefix}」`); }
    else if (ratio >= 0.3) { titleScore += 30; why.push("シリーズ部分一致"); }
  }
  const sim = ngramSim(cn, dn);
  if (sim >= 0.8 && titleScore < 60)      { titleScore += 60; why.push(`タイトル高類似(${(sim * 100).toFixed(0)}%)`); }
  else if (sim >= 0.5 && titleScore < 30) { titleScore += 30; why.push(`タイトル類似(${(sim * 100).toFixed(0)}%)`); }
  score += Math.min(titleScore, 100);

  const ce = comp.events.map(normalizeEvent).filter(Boolean);
  const de = normalizeEvent(cand.event || "");
  if (de && ce.length) {
    if (ce.includes(de))                                  { score += 50; why.push(`イベント一致(${cand.event})`); }
    else if (ce.some(e => e.includes(de) || de.includes(e))) { score += 25; why.push(`イベント部分一致(${cand.event})`); }
  }

  if (isCandAfterComp(comp.releaseDate, cand.releaseDate)) {
    score -= 80;
    why.push("総集編より後発（収録不可）");
  } else {
    const days = dateDiffDays(comp.releaseDate, cand.releaseDate);
    if (days !== null) {
      if      (days <= 180)  { score += 40; why.push("6ヶ月以内"); }
      else if (days <= 365)  { score += 30; why.push("1年以内"); }
      else if (days <= 730)  { score += 20; why.push("2年以内"); }
      else if (days <= 1460) { score += 10; why.push("4年以内"); }
      else                   { score -= 10; why.push("4年超"); }
    }
  }

  const compTagSet = new Set(comp.tags);
  const hits = (cand.tags || []).filter(t => compTagSet.has(t)).length;
  if (hits > 0) { score += hits * 5; why.push(`タグ${hits}件一致`); }

  if (comp.pageCount && cand.pageCount) {
    const r = cand.pageCount / comp.pageCount;
    if (r > 0.85) { score -= 30; why.push("ページ数過大（単独85%超）"); }
    else if (r < 0.9 && r > 0.05) { score += 10; }
  }

  if (comp.price > 0 && cand.price > 0 && cand.price > comp.price * 1.5) {
    score -= 15; why.push("価格過大");
  }

  return { rj: cand.rj, score, reasons: why, pageCount: cand.pageCount || 0 };
}

/**
 * サークル同定によるRJ未記載総集編の収録作品推定。
 * @param {string} compRJ
 * @param {string} html            総集編作品詳細ページのHTML
 * @param {object} io
 * @param {(url:string)=>Promise<string>} io.fetchText  HTML取得（呼び出し側でレート制限・リトライを行う）
 * @param {(url:string)=>Promise<any>}    io.fetchJson  JSON取得
 * @param {(ms:number)=>Promise<void>}    io.sleep
 * @param {()=>boolean} [io.shouldContinue]  中断チェック（既定: 常にtrue）
 */
async function estimateContents(compRJ, html, io) {
  const { fetchText, fetchJson, sleep, shouldContinue = () => true } = io;

  const CIRCLE_URL = (id, p) => `https://www.dlsite.com/maniax/fsr/=/maker_id/${id}/per_page/100/page/${p}/show_type/1`;
  // バグ修正: 拡張機能版から移植した際に site_id が 'home' 固定のまま
  // 残っていた。'home' は config.dlsite.sites（実際にウォームアップ/巡回
  // している maniax/bl/girls）に含まれないファミリーで、product/info/=
  // エンドポイントもセッションが確立されていないため恒常的に404していた
  // （data実測: 1セッションで180件超）。compScanのPhase A(一覧走査)は
  // 現状maniaxジャンル515のみを対象にしており、CIRCLE_URLも既にmaniax
  // 固定になっているため、ここもmaniaxに揃える。
  const INFO_URL   = rj => `https://www.dlsite.com/maniax/product/info/=/product_id/${rj}.json`;
  const MAX_API = 30;

  const comp = parseCompMeta(html, compRJ);
  if (!comp.circleId) return [];

  // Phase 1: 検索結果HTMLからタイトル付き候補リストを作成
  const titleMap = new Map();
  for (let page = 1; page <= 5; page++) {
    if (!shouldContinue()) return [];
    let pageHtml;
    try { pageHtml = await fetchText(CIRCLE_URL(comp.circleId, page)); }
    catch { break; }
    parseCandidatesFromSearch(pageHtml, compRJ).forEach((title, rj) => titleMap.set(rj, title));
    if (titleMap.size - (page - 1) * 100 < 90) break;
    await sleep(200);
  }
  if (!titleMap.size) return [];

  // Phase 1.5: タイトル類似度で事前フィルタ
  const cn = normalizeTitle(comp.title);
  const ranked = [...titleMap.entries()]
    .map(([rj, title]) => ({ rj, title, prescore: ngramSim(cn, normalizeTitle(title)) }))
    .sort((a, b) => b.prescore - a.prescore)
    .slice(0, MAX_API);

  // Phase 2: フルスコアリング（呼び出し側が並列度を管理する想定のため逐次実行）
  const scored = [];
  for (const { rj } of ranked) {
    if (!shouldContinue()) break;
    let info;
    try { info = await fetchJson(INFO_URL(rj)); }
    catch { continue; }
    if (!info) continue;

    const genres = info.genres || [];
    const isComp = genres.some(g => (g.id || g.genre_id) === 515 || g.name === "総集編");
    if (isComp) continue;

    const cand = {
      rj,
      title:       info.work_name || "",
      pageCount:   info.page_count || 0,
      releaseDate: (info.regist_date || "").slice(0, 10),
      event:       info.event || "",
      tags:        genres.map(g => g.name || "").filter(Boolean),
      price:       info.price || 0,
    };
    const res = scoreCandidate(comp, cand);
    if (res.score >= THRESHOLD - 30) scored.push(res); // pending枠も拾えるよう閾値より緩めに集める
    await sleep(120);
  }
  scored.sort((a, b) => b.score - a.score);

  if (comp.pageCount > 0 && scored.length > 0) {
    const subset = findPageSubset(comp.pageCount, comp.workCount, scored);
    if (subset) {
      subset.forEach(s => {
        const t = scored.find(r => r.rj === s.rj);
        if (t) { t.score += 80; t.reasons.push("ページ数組合せ一致"); }
      });
      scored.sort((a, b) => b.score - a.score);
    }
  }

  const limit = comp.workCount > 0 ? comp.workCount * 2 : 20;
  const result = scored.slice(0, limit);
  log.debug('[compAnalyzer]', compRJ, `${result.length}件推定`,
    result.slice(0, 5).map(r => `${r.rj}(${r.score})`));
  return result;
}

module.exports = {
  THRESHOLD,
  parseCompMeta,
  parseCandidatesFromSearch,
  extractDetailRJs,
  scoreCandidate,
  estimateContents,
  normalizeTitle,
  ngramSim,
};
