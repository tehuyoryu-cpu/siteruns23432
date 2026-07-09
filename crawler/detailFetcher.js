'use strict';

/**
 * crawler/detailFetcher.js
 * 個別作品の価格詳細取得（product/info/ajax バッチAPI）。
 */

const config = require('../config');
const db     = require('./db');
const parser = require('./parser');
const log    = require('./logger');
const { fetchWithRetry, sleep } = require('./queue');

const BASE  = config.dlsite.baseUrl;
const BATCH = Math.min(config.fetch.batchSize ?? 50, 50);  // DLsite Product Info API 上限

// ─── サーキットブレーカー ────────────────────────────────────────────────────
// バグ修正: product/info/ajax がHTTP 200 + 完全な空オブジェクトを返す状態
// (年齢確認セッション未確立等、サイト全体に影響する系統的な失敗)になると、
// 従来の _processBatch は失敗のたびに際限なく再分割(50→25→13→7→4→2→1)を
// 繰り返し、1つの50件バッチの失敗が最大63回もの個別リクエストに膨れ上がって
// いた。根本原因(セッション等)が直らない限りこの分割は絶対に成功しないため、
// 無駄なリクエスト・ログ肥大化・DLsiteへの負荷を生むだけだった。
// 同一サイトで「バッチ全体が空応答」という失敗が短時間に連続した場合、
// そのサイトへのリクエストを今回の runDetailFetch() 呼び出し中だけ打ち切り、
// 残りは(ネットワークを叩かずに)recordFetchError のみ記録する。
// 次回の巡回では自動的に再試行される(このフラグは実行ごとにリセットされる)。
const CIRCUIT_BREAKER_THRESHOLD = 5;
let _consecutiveEmptyBySite = {};
let _circuitOpenBySite      = {};

function _resetCircuitBreaker() {
  _consecutiveEmptyBySite = {};
  _circuitOpenBySite      = {};
}
function _recordEmptyResult(site) {
  _consecutiveEmptyBySite[site] = (_consecutiveEmptyBySite[site] ?? 0) + 1;
  if (_consecutiveEmptyBySite[site] >= CIRCUIT_BREAKER_THRESHOLD && !_circuitOpenBySite[site]) {
    _circuitOpenBySite[site] = true;
    log.error(`[detail] ${site}: 空応答(または取得失敗)が${CIRCUIT_BREAKER_THRESHOLD}回連続 — ` +
      `セッション/年齢確認が失敗している疑いが強いため、このサイトへのリクエストを今回の巡回では打ち切ります` +
      `(次回の巡回で自動的に再試行されます)`);
  }
}
function _recordNonEmptyResult(site) {
  _consecutiveEmptyBySite[site] = 0;
}
function _isCircuitOpen(site) {
  return !!_circuitOpenBySite[site];
}

// ─── public ──────────────────────────────────────────────────────────────────

async function runDetailFetch(limit = 300, { onProgress } = {}) {
  // 実行ごとにサーキットブレーカーをリセット（前回の巡回で打ち切ったサイトも
  // 今回はまず1回試す）
  _resetCircuitBreaker();

  // due な作品が limit を超える場合でも、1回の呼び出しで全件処理し終えるまでループする。
  // （以前は limit 件で必ず打ち切られ、「全て巡回」等で残りが無視されるバグがあった）
  const result = { processed: 0, priceChanges: 0, errors: 0, total: 0 };

  // サイト別グループ
  // DLsite product/info/ajax が受け付けるサイト識別子のみ許可。
  // 旧DBに残存する 'aix' 等の廃止サイト名は 'maniax' にフォールバック。
  const VALID_SITES = new Set(config.dlsite.validSiteIds ?? ['maniax', 'girls', 'home', 'bl', 'pro']);

  // sql.js の保存(_save)は DB 全体を毎回シリアライズし直すコストがあるため、
  // バッチごとに毎回保存せず SAVE_EVERY_N_BATCHES 回に1回だけ明示的に保存する。
  // (20000件規模だと毎バッチ保存は非常に遅くなるため)
  const SAVE_EVERY_N_BATCHES = 5;
  let batchesSinceSave = 0;

  // 'all'/'turbo' ジョブからの中断要求を実際に確認する。
  // (以前は global._crawlerAbort.detail がセットされても誰も見ておらず、
  //  「中断した」というログだけが出て実際には動き続けるバグがあった)
  const isAborted = () => !!global._crawlerAbort?.detail;

  // バッチ(50件)単位のHTTPリクエストを config.fetch.concurrency 件まで並列実行する
  // ワーカープール。以前は concurrency 設定が定義されているのに使われておらず、
  // 'turbo'(ぶっ飛ばし)モードも rateLimit を縮めるだけで実質ほぼ逐次処理のままだった。
  // (sql.js への書き込み自体はNodeのシングルスレッド実行内で同期的に行われるため、
  //  await の合間に他のPromiseの同期区間が割り込むことはなく安全)
  async function _runConcurrentBatches(works, site) {
    const chunks = [];
    for (let i = 0; i < works.length; i += BATCH) chunks.push(works.slice(i, i + BATCH));
    let nextIdx = 0;
    let aborted = false;

    async function worker() {
      while (nextIdx < chunks.length) {
        if (isAborted()) { aborted = true; return; }
        const myIdx = nextIdx++;
        const batch = chunks[myIdx];
        const r = await _processBatch(batch, site);
        result.processed    += r.processed;
        result.priceChanges += r.priceChanges;
        result.errors       += r.errors;
        onProgress?.({ processed: result.processed, priceChanges: result.priceChanges, total: result.total });

        batchesSinceSave++;
        if (batchesSinceSave >= SAVE_EVERY_N_BATCHES) {
          db.save();
          batchesSinceSave = 0;
        }

        // 次チャンクがある場合のみsleep（最終バッチ後の無駄な700ms待機を除去）
        if (config.fetch.rateLimit > 0 && nextIdx < chunks.length) {
          await sleep(config.fetch.rateLimit);
        }
      }
    }

    const poolSize = Math.max(1, Math.min(config.fetch.concurrency ?? 1, chunks.length));
    await Promise.all(Array.from({ length: poolSize }, () => worker()));
    return aborted;
  }

  // limit = 処理件数の上限（scheduler は 300、all/turbo は 99999 で「全件」を意味する）
  // イテレーション毎の取得サイズは ITER_SIZE で固定し、limit とは分離する。
  // 以前は getDueWorks(limit) を繰り返し呼んでいたため、limit=300 でも
  // due 作品が無くなるまでループし続け「全件処理」と同義になっていた。
  // ITER_SIZE=500: concurrency=3, batchSize=50 → ceil(500/50)=10チャンク / 3worker = 4ラウンド
  // ≈ 4 × (APIレスポンス + 700ms) ≈ 約5秒/500件（前回の300件から1.67倍のスループット）
  const ITER_SIZE = 500;
  while (true) {
    if (isAborted()) {
      log.info('[detail] aborted by external request (before fetching due works)');
      break;
    }

    // 残り処理可能件数を計算してキャップする
    const remaining = limit - result.total;
    if (remaining <= 0) {
      log.info('[detail] limit reached:', limit);
      break;
    }
    const batchSize = Math.min(ITER_SIZE, remaining);

    const due = db.getDueWorks(batchSize);
    if (!due.length) {
      if (result.total === 0) log.info('[detail] no due works');
      break;
    }

    result.total += due.length;
    log.info('[detail] due batch:', due.length, '(total so far:', result.total, ') concurrency=' + (config.fetch.concurrency ?? 1));

    const bySite = {};
    for (const w of due) {
      const raw = w.site_id ?? 'maniax';
      const s   = VALID_SITES.has(raw) ? raw : 'maniax';
      if (s !== raw) log.warn('[detail] unknown site_id fallback:', raw, '->', s, w.rj_code);
      (bySite[s] ??= []).push(w);
    }

    let abortedMidBatch = false;
    for (const [site, works] of Object.entries(bySite)) {
      if (abortedMidBatch) break;
      abortedMidBatch = await _runConcurrentBatches(works, site);
    }
    if (abortedMidBatch) {
      log.info('[detail] aborted by external request (mid-batch)');
      break;
    }

    // 取得件数が batchSize 未満 → due 作品が枯渇、終了
    if (due.length < batchSize) break;
  }

  // ループ終了時点でまだ保存していない分が残っていれば最後にフラッシュする
  if (batchesSinceSave > 0) db.save();

  log.info('[detail] done', result);
  return result;
}

// 単体fetch（--rj オプション / テスト用）
async function fetchAndStore(rjCode, siteId = 'maniax') {
  const body = await _apiFetch([{ rj_code: rjCode }], siteId);
  if (!body) { db.transaction(() => db.recordFetchError(rjCode)); return false; }
  let changed = false;
  db.transaction(() => { changed = _store(rjCode, body); });
  return changed;
}

// discovery が取得した初期価格を保存
function saveDiscoveredPrice(rjCode, priceData) {
  const changed = db.savePriceIfChanged(rjCode, priceData);
  if (changed) db.save(); // Fix#7: ensure persistence outside transaction
  return changed;
}

// ─── バッチ処理 ───────────────────────────────────────────────────────────────

async function _processBatch(works, site, depth = 0) {
  const result = { processed: 0, priceChanges: 0, errors: 0 };

  // サーキットブレーカーが開いていれば、ネットワークを叩かずに即座に
  // fetchError扱いにする（priorityは下げない・intervalのみ延長）。
  if (_isCircuitOpen(site)) {
    db.transactionNoSave(() => {
      for (const w of works) db.recordFetchError(w.rj_code);
    });
    result.errors += works.length;
    return result;
  }

  let body = await _apiFetch(works, site);

  // 失敗→バイナリ分割（半分ずつ、最大1段階まで）→個別エラー記録
  // SUB=10 固定にすると works.length < SUB の場合に無限ループするため halving を使う
  //
  // 以前は Promise.all で両半分を無条件に並列実行しており、失敗した50件バッチが
  // 25→12→6→3→1件…と再帰する過程で config.fetch.concurrency を無視した
  // 大量の同時リクエストが一気にDLsiteへ飛んでしまうバグがあった
  // (2026-07-03のログで2秒間に100件超のリクエストバーストを確認、直後に
  //  ERR_HTTP2_PING_FAILED / ERR_CONNECTION_TIMED_OUT が多発した原因と推測される)。
  // 分割時は逐次実行にし、間に短い待機を挟んでバーストを防ぐ。
  //
  // バグ修正: セッション/年齢確認の失敗のようにサイト全体に影響する系統的な
  // 失敗の場合、何段階再分割しても絶対に成功しない。以前は再帰の底(1件)まで
  // 無制限に分割し続けており、1つの50件バッチの失敗が最大63回もの個別
  // リクエストに膨れ上がっていた。分割は診断的価値のある最初の1段階だけに
  // 制限し(バッチサイズに起因する一時的な問題の切り分けは残しつつ)、
  // それでも失敗する場合は録fetchErrorに倒してこれ以上分割しない。
  // 系統的な失敗の検出・抑制はサーキットブレーカー(_recordEmptyResult等)が担う。
  const MAX_SPLIT_DEPTH = 1;
  if (!body && works.length > 1 && depth < MAX_SPLIT_DEPTH) {
    log.warn('[detail] batch fail, splitting', works.length);
    const mid = Math.ceil(works.length / 2);
    const r1 = await _processBatch(works.slice(0, mid), site, depth + 1);
    await sleep(Math.max(config.fetch.rateLimit ?? 0, 300));
    const r2 = await _processBatch(works.slice(mid), site, depth + 1);
    result.processed    += r1.processed    + r2.processed;
    result.priceChanges += r1.priceChanges + r2.priceChanges;
    result.errors       += r1.errors       + r2.errors;
    return result;
  }

  if (!body) {
    _recordEmptyResult(site);
    // 1件でも失敗 — まとめて記録するが、保存は呼び出し元(runDetailFetch)が間引いて行う
    db.transactionNoSave(() => {
      for (const w of works) db.recordFetchError(w.rj_code);
    });
    result.errors += works.length;
    return result;
  }

  _recordNonEmptyResult(site);

  // APIレスポンスのキーを正規化: 大文字版 + ゼロ埋めなし版の両方をインデックス
  const normalizedBody = {};
  for (const [k, v] of Object.entries(body)) {
    const upper  = k.toUpperCase();
    const nopad  = upper.replace(/^RJ0+/, 'RJ');
    normalizedBody[upper] = v;
    if (nopad !== upper) normalizedBody[nopad] = v;  // 例: RJ01234567 → RJ1234567 も登録
  }

  // バグ修正: レスポンスに何らかのキーは含まれているが、リクエストした作品が
  // 1件も含まれていないケースを検出する。これは「これらの作品が本当にAPIから
  // 消えた(削除/非公開)」のではなく、CDN/中間プロキシが別バッチ向けの
  // レスポンスを誤って返している(クエリ文字列を無視したキャッシュ等)可能性が
  // 非常に高い。区別せずに処理すると、以下の per-work ループが
  // db.recordApiMissing() を全件に対して呼んでしまい、実際には生きている
  // 作品の優先度が徐々に delisted まで落ちてしまう(観測例: 全く異なる複数の
  // RJ群に対して毎回同じ固定キー集合しか返らない)。
  // この場合は「削除された」ではなく「取得に失敗した」として扱い、
  // recordFetchError(intervalを延ばすのみ、priorityは下げない)に倒す。
  // バグ修正: 以前は matchedCount === 0（1件も一致しない）の場合のみ
  // 「レスポンス不一致＝別バッチ向けキャッシュ汚染」として扱っていた。
  // しかし実運用ログでは、50件requestして実際には固定の1〜2件（大文字/ゼロ埋め
  // なし版の重複を含むため実質1件のことが多い）だけが繰り返しキーとして返る
  // 事例が大量発生していた。この場合 matchedCount は0にならないため上の判定を
  // すり抜け、残りの数十件が「本当にAPIから消えた」と誤認されて
  // recordApiMissing() が呼ばれてしまう ── 2回連続でこれが起きると
  // priority=delisted(0) まで落ち、実際には生きている作品が巡回対象から
  // 実質除外されてしまう重大なデータ破損につながっていた。
  // 一致率が極端に低い場合も同じ「汚染されたレスポンス」として扱い、
  // recordApiMissing ではなく recordFetchError（priorityは下げず、
  // intervalのみ延長）に倒す。少数件バッチ(数件程度)はたまたま低一致率に
  // なりうるため、ある程度まとまった件数のバッチのみを対象にする。
  const MIN_BATCH_FOR_RATIO_CHECK = 4;   // これ未満の件数は対象外（誤検出防止）
  const SUSPECT_MATCH_RATIO       = 0.3; // 一致率がこれ未満なら汚染を疑う
  const matchedCount = works.filter(w => {
    const rj    = w.rj_code.toUpperCase();
    const nopad = rj.replace(/^RJ0+/, 'RJ');
    return rj in normalizedBody || nopad in normalizedBody;
  }).length;
  const matchRatio       = works.length > 0 ? matchedCount / works.length : 1;
  const isFullMismatch   = matchedCount === 0 && Object.keys(normalizedBody).length > 0;
  const isPartialSuspect = works.length >= MIN_BATCH_FOR_RATIO_CHECK
    && matchedCount > 0
    && matchRatio < SUSPECT_MATCH_RATIO;

  if (works.length > 0 && (isFullMismatch || isPartialSuspect)) {
    log.error('[detail] response mismatch (requested RJs mostly not found, likely stale CDN/proxy cache) — treating as fetch error, not delisted', {
      site,
      requestedCount: works.length,
      matchedCount,
      matchRatio: matchRatio.toFixed(2),
      requested: works.map(w => w.rj_code),
      availableSample: Object.keys(normalizedBody).slice(0, 5),
    });
    db.transactionNoSave(() => {
      for (const w of works) db.recordFetchError(w.rj_code);
    });
    result.errors += works.length;
    return result;
  }

  db.transactionNoSave(() => {
    for (const w of works) {
      try {
        const dbKey   = w.rj_code;                          // DB に登録されているキー（これのみDB操作に使う）
        const rj      = dbKey.toUpperCase();
        const rjNopad = rj.replace(/^RJ0+/, 'RJ');
        const found   = rj in normalizedBody || rjNopad in normalizedBody;

        if (!found) {
          log.warn('[detail] key not in API response', rj,
            'available:', Object.keys(normalizedBody).slice(0, 3).join(', '));
          db.recordApiMissing(dbKey);   // API不在→急速退避
          result.errors++;
          continue;
        }

        // データ抽出用キーはnopadでも可、ただしDB操作は必ず dbKey を使う
        const dataKey     = (rj in normalizedBody) ? rj : rjNopad;
        const singleBody  = { [dbKey]: normalizedBody[dataKey] };  // DB キーで包み直す
        const changed     = _store(dbKey, singleBody);

        if (changed === null) {
          result.errors++;
        } else {
          result.priceChanges += changed ? 1 : 0;
          result.processed++;
        }
      } catch (e) {
        log.error('[detail] store error', w.rj_code, e.message);
        db.recordFetchError(w.rj_code);
        result.errors++;
      }
    }
  });

  return result;
}

// ─── API fetch ────────────────────────────────────────────────────────────────

async function _apiFetch(works, site) {
  // DLsite API は product_id[] 形式（配列）を要求する
  const params = works.map(w => `product_id%5B%5D=${encodeURIComponent(w.rj_code)}`).join('&');
  const url    = `${BASE}/${site}/product/info/ajax?${params}&cdn_cache_min=1`;
  try {
    const res = await fetchWithRetry(url, {
      headers: { Accept: 'application/json, */*' },
    });
    if (!res.ok) {
      log.error('[detail] API HTTP error', res.status, site, `${works.length}件`,
        works.slice(0,3).map(w=>w.rj_code).join(','));
      return null;
    }
    const body = await res.json();
    const returnedKeys = Object.keys(body).length;
    if (returnedKeys === 0) {
      log.warn('[detail] API returned empty object', site, `requested ${works.length}件`,
        'sample:', works.slice(0,2).map(w=>w.rj_code).join(','));
      return null;
    }
    if (returnedKeys < works.length * 0.5) {
      log.warn('[detail] API returned partial data', site,
        `got ${returnedKeys} / requested ${works.length}`);
    }
    return body;
  } catch (e) {
    log.error('[detail] API fetch error', e.message, site, `${works.length}件`);
    return null;
  }
}

// ─── 1件保存 ─────────────────────────────────────────────────────────────────

function _store(rjCode, body) {
  const parsed = parser.parseProductInfo(rjCode, body);
  if (!parsed) {
    // 生データをエラーログに出力して原因を特定できるようにする
    const raw = body[rjCode] ?? body[rjCode.toUpperCase()];
    log.error('[detail] parseProductInfo failed', rjCode,
      raw ? `fields: ${Object.keys(raw).join(',')}` : 'key not found in body');
    db.recordFetchError(rjCode);
    return null;   // null = parse failure (distinct from false = price unchanged)
  }

  const { work, price } = parsed;

  // バグ修正(継続的なsite_id破損): parser.jsは既知のサイトファミリーに
  // 一致しないsite_id(aix/appx等の内部分類コード)をnullとして返す。
  // ここで null の場合は既存DB値を維持し、そもそも存在しない新規行なら
  // 'maniax' にフォールバックする。以前はここでの検証が無く、無効な値を
  // そのままDBへ書き込んでいたため、毎回のスキャンでsite_idが上書きされ
  // 壊れ続けていた（過去のDBマイグレーションは一括修正のみで、この
  // 書き込み時の未検証という根本原因自体は直っていなかった）。
  if (work.site_id == null) {
    const existingForSite = db.getWorkByRj(rjCode);
    work.site_id = existingForSite?.site_id ?? 'maniax';
  }

  db.upsertWork(work);

  if (work.maker_id) {
    db.upsertCircle(work.maker_id, work.circle ?? '');
    _handleCircleSale(work.maker_id, price);
  }

  const changed   = db.savePriceIfChanged(rjCode, price);
  const existing  = db.getWorkByRj(rjCode);
  const noChange  = changed ? 0 : (existing?.consecutive_no_change ?? 0) + 1;
  const schedule  = _schedule(work, price, noChange);

  db.markChecked(rjCode, {
    check_interval:        schedule.interval,
    priority:              schedule.priority,
    is_on_sale:            price.is_on_sale,
    consecutive_no_change: noChange,
    consecutive_errors:    0,
  });

  if (changed) log.info('[detail] price changed', { rj: rjCode, ...price });
  return changed;
}

// ─── サークルセール伝播 ───────────────────────────────────────────────────────

function _handleCircleSale(makerId, price) {
  const circle = db.getCircle(makerId);
  if (!circle) return;
  const onSale    = price.is_on_sale === 1;
  const wasOnSale = circle.on_sale === 1;

  if (onSale && !wasOnSale) {
    log.info('[detail] circle sale start', makerId);
    db.markCircleOnSale(makerId, true);
    db.boostCircleWorks(makerId, config.priority.circleOnSale, config.checkInterval.onSale);
  } else if (!onSale && wasOnSale) {
    log.info('[detail] circle sale end', makerId);
    db.markCircleOnSale(makerId, false);
    db.resetCircleWorksPriority(makerId, config.priority.normal, config.checkInterval.normal);
  }
}

// ─── スケジュール計算 ─────────────────────────────────────────────────────────

function _schedule(work, price, noChange) {
  const ci = config.checkInterval, p = config.priority;
  if (price.is_on_sale)   return { interval: ci.onSale,     priority: p.onSale };
  if (noChange >= 5)      return { interval: ci.cold,       priority: p.cold };
  const days = _ageDays(work.release_date);
  if (days <  7)          return { interval: ci.newWork,    priority: p.newWork };
  if (days < 30)          return { interval: ci.recentWork, priority: p.recentWork };
  if ((work.dl_count ?? 0) >= 1000) return { interval: ci.popular, priority: p.popular };
  return { interval: ci.normal, priority: p.normal };
}

function _ageDays(d) {
  try { return Math.floor((Date.now() - new Date(d).getTime()) / 86400000); }
  catch { return 9999; }
}

module.exports = { runDetailFetch, fetchAndStore, saveDiscoveredPrice };
