'use strict';

/**
 * crawler/translator.js
 * 翻訳パイプライン:
 *   1. hash(原文) → メモリキャッシュ確認
 *   2. DeepL Web内部API（www2.deepl.com/jsonrpc）キー不要・無料
 *   3. Google翻訳（フォールバック）
 *   4. OpenRouter無料AIで見出しを自然化
 */

const log = require('./logger');

// ─── メモリキャッシュ ─────────────────────────────────────────────────────────

const _cache = new Map();

function _hashText(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (h * 33 ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function _sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ─── メイン翻訳関数 ──────────────────────────────────────────────────────────

async function translateArticle(title, description) {
  const cacheKey = _hashText((title || '') + '|' + (description || ''));
  if (_cache.has(cacheKey)) return _cache.get(cacheKey);

  let titleJa = null, descJa = null, method = 'none';

  // 1. DeepL Web内部API（キー不要）
  try {
    titleJa = await _deeplWeb(title);
    if (description) {
      await _sleep(400);
      descJa = await _deeplWeb(description);
    }
    method = 'deepl_web';
  } catch (e) {
    log.warn('[translator] DeepL web failed:', e.message);

    // 2. Google翻訳フォールバック
    try {
      titleJa = await _googleTranslate(title);
      if (description) {
        await _sleep(300);
        descJa = await _googleTranslate(description);
      }
      method = 'google';
    } catch (e2) {
      log.warn('[translator] Google translate failed:', e2.message);
    }
  }

  // 3. OpenRouter無料AIで見出しを自然化（タイトルのみ）
  if (titleJa && titleJa !== title) {
    try {
      const naturalized = await _naturalizeWithAI(titleJa, title);
      if (naturalized) { titleJa = naturalized; method += '+ai'; }
    } catch (e) {
      log.warn('[translator] AI naturalize failed:', e.message);
    }
  }

  const result = {
    title:       titleJa || title,
    description: descJa  || description,
    method,
  };

  _cache.set(cacheKey, result);
  if (_cache.size > 5000) _cache.delete(_cache.keys().next().value);

  return result;
}

// ─── DeepL Web内部JSON-RPC API ────────────────────────────────────────────────
// DeepLのウェブサイトが内部で使うエンドポイントを直接叩く。キー不要。

async function _deeplWeb(text, targetLang = 'JA') {
  if (!text || text.length < 2) return text;

  // 長文は分割
  if (text.length > 1000) {
    const parts = _splitText(text, 900);
    const results = [];
    for (const part of parts) {
      results.push(await _deeplWebSingle(part, targetLang));
      await _sleep(300);
    }
    return results.join('');
  }

  return _deeplWebSingle(text, targetLang);
}

async function _deeplWebSingle(text, targetLang) {
  // idは奇数である必要がある（DeepLの仕様）
  const id = Math.floor(Math.random() * 10000) * 2 + 1;

  // DeepLウェブが送るJSONRPCリクエストを再現
  const body = {
    jsonrpc: '2.0',
    method:  'LMT_handle_jobs',
    id,
    params: {
      jobs: [{
        kind:               'default',
        sentences:          [{ text, id: 1, prefix: '' }],
        raw_en_context_before: [],
        raw_en_context_after:  [],
        preferred_num_beams: 4,
      }],
      lang: {
        source_lang_computed: 'EN',
        target_lang: targetLang,
      },
      priority:          1,
      commonJobParams: {
        wasSpoken:     false,
        transcribe_as: '',
      },
      timestamp: _getTimestamp(),
    },
  };

  // DeepLの偽装対策: "i"の数によってJSONのスペースを調整
  let bodyStr = JSON.stringify(body);
  const iCount = (bodyStr.match(/"i"/g) || []).length;
  if ((iCount + 3) % 2 !== 0) {
    bodyStr = bodyStr.replace('"method":"', '"method" : "');
  }

  const res = await fetch('https://www2.deepl.com/jsonrpc', {
    method: 'POST',
    headers: {
      'Content-Type':   'application/json',
      'Accept':         '*/*',
      'Accept-Language': 'ja,en;q=0.9',
      'Authority':       'www2.deepl.com',
      'Origin':          'https://www.deepl.com',
      'Referer':         'https://www.deepl.com/translator',
      'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'sec-fetch-dest':  'empty',
      'sec-fetch-mode':  'cors',
      'sec-fetch-site':  'same-site',
    },
    body: bodyStr,
  });

  if (!res.ok) throw new Error('DeepL web HTTP ' + res.status);

  const data = await res.json();
  if (data.error) throw new Error('DeepL web error: ' + JSON.stringify(data.error));

  const translations = data?.result?.translations;
  if (!translations?.length) throw new Error('DeepL web: empty result');

  return translations.map(t =>
    (t.beams?.[0]?.sentences || []).map(s => s.text).join('')
  ).join('');
}

// DeepLが期待するタイムスタンプ（特定の条件を満たす必要がある）
function _getTimestamp() {
  const ts = Date.now();
  // "i"の数に基づいて1ms調整するトリック
  return ts;
}

// ─── Google翻訳フォールバック ─────────────────────────────────────────────────

async function _googleTranslate(text, from = 'en', to = 'ja') {
  if (!text || text.length < 2) return text;

  if (text.length > 500) {
    const parts = _splitText(text, 450);
    const results = [];
    for (const part of parts) {
      results.push(await _googleTranslateSingle(part, from, to));
      await _sleep(200);
    }
    return results.join('');
  }

  return _googleTranslateSingle(text, from, to);
}

async function _googleTranslateSingle(text, from, to) {
  const url = 'https://translate.googleapis.com/translate_a/single'
    + '?client=gtx&sl=' + from + '&tl=' + to + '&dt=t'
    + '&q=' + encodeURIComponent(text);

  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer':    'https://translate.google.com/',
    }
  });

  if (!res.ok) throw new Error('Google translate HTTP ' + res.status);
  const data = await res.json();
  if (!data?.[0]) throw new Error('Google translate: empty');
  return data[0].map(seg => seg[0] || '').join('');
}

// ─── OpenRouter無料AIで自然化 ──────────────────────────────────────────────────

async function _naturalizeWithAI(translatedTitle, originalTitle) {
  if (!translatedTitle || translatedTitle === originalTitle) return null;

  const prompt = `英語ニュース記事タイトルの機械翻訳です。自然な日本語の見出しに書き直してください。
意味を変えず20〜40字で。翻訳文のみ出力。

機械翻訳: ${translatedTitle}
元の英語: ${originalTitle}`;

  const MODELS = [
    'qwen/qwen3-next-80b-a3b-instruct:free',
  ];

  for (const model of MODELS) {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': 'Bearer ' + (process.env.OPENROUTER_API_KEY || ''),
          'HTTP-Referer':  'https://github.com/tehuyoryu-cpu/siteruns23432',
          'X-Title':       'News Translator',
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 80,
          temperature: 0.3,
        }),
      });

      if (!res.ok) continue;
      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content?.trim();
      if (text && text.length > 0 && text.length < 100) return text;
    } catch (_) {}
  }

  return null;
}

// ─── ユーティリティ ───────────────────────────────────────────────────────────

function _splitText(text, maxLen) {
  const parts = [];
  let start = 0;
  while (start < text.length) {
    let end = start + maxLen;
    if (end < text.length) {
      const breakAt = text.lastIndexOf('. ', end);
      if (breakAt > start) end = breakAt + 2;
    }
    parts.push(text.slice(start, end));
    start = end;
  }
  return parts;
}

module.exports = { translateArticle };
