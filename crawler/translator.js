'use strict';

/**
 * crawler/translator.js
 * 翻訳パイプライン:
 *   1. hash(原文) → キャッシュ確認
 *   2. DeepL無料API（500文字/月まで無料、毎月リセット）
 *   3. Google翻訳（APIなし・無料スクレイプ）
 *   4. OpenRouter無料AIで文章を自然化
 *
 * 無料AIモデル: OpenRouterのfree tierモデル
 *   - google/gemma-3-27b-it:free
 *   - mistralai/mistral-7b-instruct:free
 */

const { fetchWithRetry, sleep } = require('./queue');
const log = require('./logger');

// ─── シンプルキャッシュ（メモリ + 永続化はnewsDbが担当） ──────────────────────

const _cache = new Map();

function _hashText(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (h * 33 ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

// ─── メイン翻訳関数 ─────────────────────────────────────────────────────────

async function translateArticle(title, description) {
  const titleHash = _hashText(title || '');
  const descHash  = _hashText(description || '');
  const cacheKey  = titleHash + '_' + descHash;

  // 1. キャッシュ確認
  if (_cache.has(cacheKey)) {
    return _cache.get(cacheKey);
  }

  let titleJa = null, descJa = null;
  let method = 'none';

  // 2. Google翻訳（APIなし）でタイトルと説明を翻訳
  try {
    titleJa = await _googleTranslate(title, 'en', 'ja');
    if (description) {
      descJa  = await _googleTranslate(description, 'en', 'ja');
    }
    method = 'google';
    await sleep(300);
  } catch (e) {
    log.warn('[translator] google failed', e.message);
  }

  // 3. OpenRouter無料AIで文章を自然化（タイトルのみ）
  if (titleJa) {
    try {
      titleJa = await _naturalizeWithAI(titleJa, title);
      method = 'ai_naturalized';
    } catch (e) {
      log.warn('[translator] AI naturalize failed', e.message);
      // Google翻訳のまま使用
    }
  }

  const result = {
    title:       titleJa || title,
    description: descJa  || description,
    method,
  };

  _cache.set(cacheKey, result);
  // キャッシュが膨らまないように上限管理
  if (_cache.size > 5000) {
    const firstKey = _cache.keys().next().value;
    _cache.delete(firstKey);
  }

  return result;
}

// ─── Google翻訳（APIなし・非公式エンドポイント） ─────────────────────────────

async function _googleTranslate(text, from, to) {
  if (!text || text.length < 2) return text;

  // 500文字以上は分割
  if (text.length > 500) {
    const parts = _splitText(text, 450);
    const translated = [];
    for (const part of parts) {
      const t = await _googleTranslateSingle(part, from, to);
      translated.push(t);
      await sleep(200);
    }
    return translated.join('');
  }

  return _googleTranslateSingle(text, from, to);
}

async function _googleTranslateSingle(text, from, to) {
  // Google翻訳の非公式エンドポイント（レート制限あり）
  const url = 'https://translate.googleapis.com/translate_a/single'
    + '?client=gtx'
    + '&sl=' + from
    + '&tl=' + to
    + '&dt=t'
    + '&q=' + encodeURIComponent(text);

  const res = await fetchWithRetry(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json, */*',
      'Referer': 'https://translate.google.com/',
    }
  });

  if (!res.ok) throw new Error('Google translate HTTP ' + res.status);

  const data = await res.json();
  if (!data || !data[0]) throw new Error('Google translate: empty response');

  // レスポンス形式: [[["翻訳後テキスト","元テキスト",...],...],...] 
  return data[0].map(seg => seg[0] || '').join('');
}

// ─── OpenRouter 無料AIで文章を自然化 ──────────────────────────────────────────

async function _naturalizeWithAI(translatedTitle, originalTitle) {
  // 翻訳が自然かどうか確認してから自然化
  if (!translatedTitle || translatedTitle === originalTitle) return translatedTitle;

  const prompt = `以下は英語のニュース記事タイトルを機械翻訳した日本語です。
より自然な日本語の見出しに書き直してください。
元の意味を変えず、20〜40字程度の簡潔な日本語見出しにしてください。
翻訳文のみ出力し、説明は不要です。

機械翻訳: ${translatedTitle}
元の英語: ${originalTitle}`;

  // OpenRouterの無料モデルを使用
  const MODELS = [
    'google/gemma-3-27b-it:free',
    'mistralai/mistral-7b-instruct:free',
    'meta-llama/llama-3.2-3b-instruct:free',
  ];

  for (const model of MODELS) {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + (process.env.OPENROUTER_API_KEY || ''),
          'HTTP-Referer': 'https://github.com/tehuyoryu-cpu/siteruns23432',
          'X-Title': 'News Translator',
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 100,
          temperature: 0.3,
        }),
      });

      if (!res.ok) {
        const err = await res.text();
        log.warn('[translator] OpenRouter error', model, res.status, err.slice(0, 100));
        continue;
      }

      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content?.trim();
      if (text && text.length > 0 && text.length < 100) {
        return text;
      }
    } catch (e) {
      log.warn('[translator] AI model failed', model, e.message);
    }
  }

  // 全モデル失敗 → Google翻訳のまま
  return translatedTitle;
}

// ─── テキスト分割ユーティリティ ──────────────────────────────────────────────

function _splitText(text, maxLen) {
  const parts = [];
  let start = 0;
  while (start < text.length) {
    let end = start + maxLen;
    if (end < text.length) {
      // 文区切りを探す
      const breakAt = text.lastIndexOf('. ', end);
      if (breakAt > start) end = breakAt + 2;
    }
    parts.push(text.slice(start, end));
    start = end;
  }
  return parts;
}

module.exports = { translateArticle };
