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
const { pushDebugBundle } = require('../scripts/pushDebugBundle');

const BASE  = config.dlsite.baseUrl;
const BATCH = Math.min(config.fetch.batchSize ?? 50, 50);  // DLsite Product Info API 上限

// ─── セッション健全性トラッキング（サーキットブレーカー + 自動再ウォームアップ）──
// バグ修正の経緯:
//   1. product/info/ajax がHTTP 200 + 完全な空オブジェクトを返す状態(年齢確認
//      セッション未確立等、サイト全体に影響する系統的な失敗)になると、
//      _processBatch は失敗のたびに際限なく再分割(50→25→13→7→4→2→1)を
//      繰り返し、1つの50件バッチの失敗が最大63回もの個別リクエストに
//      膨れ上がっていた。→ サーキットブレーカーを追加し、同一サイトで空応答が
//      連続したらそのサイトへのリクエストを今回の実行中は打ち切るようにした。
//   2. しかしサーキットブレーカーだけでは、根本原因(セッション切れ)自体は
//      何も解消しないため、turbo/allのような1回のジョブでセッションが
//      無効化されると、以降のリクエストが全滅し続けたまま早期終了して
//      しまっていた。→ 空応答streakが閾値に達したら warmUpSession() の
//      再実行(セッション再確立)を試みるフックを追加した。
//   3. ただし上記2つを別々のカウンタ(_consecutiveEmptyBySite と
//      _siteEmptyStreak)で独立に追跡していたため、(a) 分割によって
//      _apiFetch と _recordEmptyResult の呼び出し回数が食い違い閾値到達
//      タイミングがずれる、(b) 再ウォームアップが成功しても
//      _circuitOpenBySite は別カウンタなのでリセットされず、同一実行内では
//      二度とリクエストが送られない、という構造的な不具合があった
//      (再ウォームアップが成功しても実質何も改善しない)。
//   → ストリーク追跡・サーキット開閉・再ウォームアップ実行を単一の状態と
//      単一の判定フローに統合する。
const EMPTY_STREAK_THRESHOLD = 5;
const REWARM_COOLDOWN_MS     = 60_000; // 再ウォームアップの最短間隔(連発防止)

const _siteEmptyStreak       = {};  // site -> 連続空応答回数
const _circuitOpenBySite     = {};  // site -> このrunDetailFetch()呼び出し中は打ち切り中か
const _rewarmInProgressBySite = {}; // site -> 再ウォームアップ実行中か(重複起動防止)
let   _lastRewarmAt          = 0;   // runDetailFetch()をまたいでもクールダウンを維持する

function _resetSessionHealthState() {
  // circuit/streak は実行ごとにリセットする(前回打ち切ったサイトも今回はまず
  // 試す)。_lastRewarmAt はクールダウンの実効性を保つため実行をまたいで維持する。
  for (const site of Object.keys(_siteEmptyStreak))   delete _siteEmptyStreak[site];
  for (const site of Object.keys(_circuitOpenBySite)) delete _circuitOpenBySite[site];
}

/** _processBatch がこのサイトへのリクエストを送るべきでないか(circuit開放中 or 再ウォーム中) */
function _shouldSkipRequest(site) {
  return !!_circuitOpenBySite[site] || !!_rewarmInProgressBySite[site];
}

/** 成功(部分成功含む)を記録し、ストリーク・サーキットともにクリアする */
function _recordApiSuccess(site) {
  _siteEmptyStreak[site]   = 0;
  _circuitOpenBySite[site] = false;
}

/**
 * 空応答を記録し、閾値に達していたら判定フロー(再ウォームアップ試行 →
 * 失敗/クールダウン中ならサーキットを開いて今回の実行では諦める)を実行する。
 * 複数ワーカーが並行して呼んでも、再ウォームアップの多重起動は
 * _rewarmInProgressBySite で防止される。
 */
async function _recordApiEmptyAndMaybeRecover(site) {
  _siteEmptyStreak[site] = (_siteEmptyStreak[site] ?? 0) + 1;
  if (_siteEmptyStreak[site] < EMPTY_STREAK_THRESHOLD) return;
  if (_circuitOpenBySite[site] || _rewarmInProgressBySite[site]) return; // 既に対処中/対処済み

  if (typeof global._reWarmUpSession !== 'function') {
    log.warn('[detail] no re-warmup hook available (non-Electron context?)', site);
    _circuitOpenBySite[site] = true;
    return;
  }

  const now = Date.now();
  if (now - _lastRewarmAt < REWARM_COOLDOWN_MS) {
    log.warn('[detail] session re-warmup skipped (cooldown)', site,
      `${Math.ceil((REWARM_COOLDOWN_MS - (now - _lastRewarmAt)) / 1000)}s残り`);
    _circuitOpenBySite[site] = true;
    log.error(`[detail] ${site}: 空応答が${EMPTY_STREAK_THRESHOLD}回連続、再ウォームアップはクールダウン中 — ` +
      `このサイトへのリクエストを今回の巡回では打ち切ります(次回の巡回で自動的に再試行されます)`);
    return;
  }

  _rewarmInProgressBySite[site] = true;
  _lastRewarmAt = now;
  log.error(`[detail] ${site}: 空応答が${EMPTY_STREAK_THRESHOLD}回連続 — セッション再確立を試みます`);
  try {
    await global._reWarmUpSession();
    log.info('[detail] session re-warmup completed, resuming', site);
    // 再ウォームアップ成功: ストリーク・サーキットともにクリアして
    // もう一度チャンスを与える(ここが従来の構造的不具合の修正点)。
    _siteEmptyStreak[site]   = 0;
    _circuitOpenBySite[site] = false;
  } catch (e) {
    log.error('[detail] session re-warmup failed', site, e.message);
    _circuitOpenBySite[site] = true;
    log.error(`[detail] ${site}: セッション再確立に失敗 — ` +
      `このサイトへのリクエストを今回の巡回では打ち切ります(次回の巡回で自動的に再試行されます)`);
  } finally {
    _rewarmInProgressBySite[site] = false;
  }
}

// ─── public ──────────────────────────────────────────────────────────────────

async function runDetailFetch(limit = 300, { onProgress, rateLimit, concurrency } = {}) {
  // 実行ごとにサーキット/ストリークをリセット（前回の巡回で打ち切ったサイトも
  // 今回はまず1回試す。再ウォームアップのクールダウンは実行をまたいで維持する）
  _resetSessionHealthState();

  // バグ修正: 以前は apiServer.js の 'turbo'/'all' ジョブが実行中に
  // `config.fetch.rateLimit = 200` のようにグローバル設定を直接書き換えて
  // 一時的にブーストし、finally で元の値へ戻していた。しかしこれは
  // モジュール全体で共有されるグローバル状態のため、ブースト中に他の処理
  // （scheduler の定期detailジョブ等）が config.fetch.* を参照すると、
  // 意図せず速度が変わる/元に戻すタイミングが競合するレース状態になりうる。
  // 呼び出し元から明示的に上書き値を渡せるようにし、グローバルは一切変更しない。
  const effRateLimit   = rateLimit   ?? config.fetch.rateLimit;
  const effConcurrency = concurrency ?? config.fetch.concurrency;

  // due な作品が limit を超える場合でも、1回の呼び出しで全件処理し終えるまでループする。
  // （以前は limit 件で必ず打ち切られ、「全て巡回」等で残りが無視されるバグがあった）
  const result = { processed: 0, priceChanges: 0, errors: 0, total: 0, apiMissing: 0, contaminated: 0, fetchFail: 0, storeError: 0, verifiedAlive: 0 };

  // サイト別グループ
  // DLsite product/info/ajax が受け付けるサイト識別子のみ許可。
  // 旧DBに残存する 'aix' 等の廃止サイト名は 'maniax' にフォールバック。
  const VALID_SITES = new Set(config.dlsite.validSiteIds ?? ['maniax', 'girls', 'home', 'bl', 'pro']);

  // better-sqlite3移行後、db.save()は各文/トランザクションの実行と同時に
  // ディスクへ反映されるためno-opになっている。このバッチ間引きロジック自体は
  // 現在は実質的な効果を持たないが、db.save()呼び出し箇所を減らす分だけ
  // わずかにオーバーヘッドが下がるため、害はないのでそのまま残している。
  const SAVE_EVERY_N_BATCHES = 5;
  let batchesSinceSave = 0;

  // 'all'/'turbo' ジョブからの中断要求を実際に確認する。
  // (以前は global._crawlerAbort.detail がセットされても誰も見ておらず、
  //  「中断した」というログだけが出て実際には動き続けるバグがあった)
  const isAborted = () => !!global._crawlerAbort?.detail;

  // バッチ(50件)単位のHTTPリクエストを config.fetch.concurrency 件まで並列実行する
  // ワーカープール。以前は concurrency 設定が定義されているのに使われておらず、
  // 'turbo'(ぶっ飛ばし)モードも rateLimit を縮めるだけで実質ほぼ逐次処理のままだった。
  // (better-sqlite3への書き込み自体はNodeのシングルスレッド実行内で同期的に行われるため、
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
        const r = await _processBatch(batch, site, 0, effRateLimit);
        result.processed    += r.processed;
        result.priceChanges += r.priceChanges;
        result.errors       += r.errors;
        result.apiMissing    += r.apiMissing;
        result.contaminated  += r.contaminated;
        result.fetchFail     += r.fetchFail;
        result.storeError    += r.storeError;
        result.verifiedAlive += r.verifiedAlive;
        onProgress?.({ processed: result.processed, priceChanges: result.priceChanges, total: result.total });

        batchesSinceSave++;
        if (batchesSinceSave >= SAVE_EVERY_N_BATCHES) {
          db.save();
          batchesSinceSave = 0;
        }

        // 次チャンクがある場合のみsleep（最終バッチ後の無駄な700ms待機を除去）
        // ±20%のジッターを加え、複数サイト/ワーカーの待機が揃って規則的な
        // リクエストパターンになるのを避ける。
        if (effRateLimit > 0 && nextIdx < chunks.length) {
          const rl = effRateLimit;
          const jittered = Math.round(rl * 0.8 + Math.random() * rl * 0.4);
          await sleep(jittered);
        }
      }
    }

    const poolSize = Math.max(1, Math.min(effConcurrency ?? 1, chunks.length));
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
    log.info('[detail] due batch:', due.length, '(total so far:', result.total, ') concurrency=' + (effConcurrency ?? 1));

    const bySite = {};
    for (const w of due) {
      const raw = w.site_id ?? 'maniax';
      const s   = VALID_SITES.has(raw) ? raw : 'maniax';
      if (s !== raw) log.warn('[detail] unknown site_id fallback:', raw, '->', s, w.rj_code);
      (bySite[s] ??= []).push(w);
    }

    // サイト単位のバッチも並列実行する（以前は maniax → bl → girls と逐次で、
    // 1サイトの巡回が終わるまで他サイトを一切処理しなかった）。各サイトは
    // 内部で独自の concurrency プールと rateLimit 待機を持つため、サイト間を
    // 並列化しても単一サイトへの同時リクエスト数は変わらない。
    const abortedFlags = await Promise.all(
      Object.entries(bySite).map(([site, works]) => _runConcurrentBatches(works, site))
    );
    const abortedMidBatch = abortedFlags.some(Boolean);
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
  // バグ修正: savePriceIfChanged はオブジェクトを返す(changed=falseでも)ため
  // 素の真偽値として扱うと常にtruthyになり、変化が無くても毎回db.save()を
  // スケジュールしてしまっていた。
  const result = db.savePriceIfChanged(rjCode, priceData);
  const changed = result.changed === true;
  if (changed) db.save(); // Fix#7: ensure persistence outside transaction
  return changed;
}

// ─── バッチ処理 ───────────────────────────────────────────────────────────────

async function _processBatch(works, site, depth = 0, rateLimit = config.fetch.rateLimit) {
  const result = { processed: 0, priceChanges: 0, errors: 0, apiMissing: 0, contaminated: 0, fetchFail: 0, storeError: 0, verifiedAlive: 0 };

  // サーキットが開いている/再ウォームアップ中なら、ネットワークを叩かずに即座に
  // fetchError扱いにする（priorityは下げない・intervalのみ延長）。
  if (_shouldSkipRequest(site)) {
    db.transactionNoSave(() => {
      for (const w of works) db.recordFetchError(w.rj_code);
    });
    result.errors    += works.length;
    result.fetchFail  += works.length;
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
  // それでも失敗する場合は recordFetchError に倒してこれ以上分割しない。
  // 系統的な失敗の検出・抑制と再ウォームアップの起動は _apiFetch 内の
  // _recordApiEmptyAndMaybeRecover() に一元化されている(分割の深さに
  // かかわらず _apiFetch 呼び出しごとに正しくカウントされる)。
  const MAX_SPLIT_DEPTH = 1;
  if (!body && works.length > 1 && depth < MAX_SPLIT_DEPTH) {
    log.warn('[detail] batch fail, splitting', works.length);
    const mid = Math.ceil(works.length / 2);
    const r1 = await _processBatch(works.slice(0, mid), site, depth + 1, rateLimit);
    await sleep(Math.max(rateLimit ?? 0, 300));
    const r2 = await _processBatch(works.slice(mid), site, depth + 1, rateLimit);
    result.processed    += r1.processed    + r2.processed;
    result.priceChanges += r1.priceChanges + r2.priceChanges;
    result.errors       += r1.errors       + r2.errors;
    result.apiMissing    += r1.apiMissing    + r2.apiMissing;
    result.contaminated  += r1.contaminated  + r2.contaminated;
    result.fetchFail      += r1.fetchFail      + r2.fetchFail;
    result.storeError    += r1.storeError    + r2.storeError;
    result.verifiedAlive += r1.verifiedAlive + r2.verifiedAlive;
    return result;
  }

  if (!body) {
    // 1件でも失敗 — まとめて記録するが、保存は呼び出し元(runDetailFetch)が間引いて行う
    // (ストリーク/サーキット/再ウォームアップの記録は _apiFetch 側で既に完了している)
    db.transactionNoSave(() => {
      for (const w of works) db.recordFetchError(w.rj_code);
    });
    result.errors    += works.length;
    result.fetchFail  += works.length;
    return result;
  }

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
  // バグ修正: 以前は matchRatio（要求件数に対する一致件数の割合）が低いだけで
  // バッチ全体を「別バッチ向けキャッシュ汚染」と断定し、一致した作品まで含めて
  // 丸ごと recordFetchError に倒していた。しかし実運用ログでは、返ってきた
  // キーが少数でも「要求したバッチに実在するRJ」ばかりで、他バッチのRJが
  // 紛れ込んでいるわけではないケースが大量発生していた
  // (例: 50件要求して15件しか返らないが、その15件は全て要求リスト内のRJ)。
  // これは「古い/削除済み作品が多いバッチでAPIが部分応答している」だけの
  // 正常な挙動であり、汚染ではない。汚染の実際の兆候は「返ってきたキーが
  // 要求リストに存在しない(＝無関係な別バッチのRJ)」ことなので、
  // matchRatio ではなく foreignRatio（返ってきたキーのうち要求外だった割合）
  // で判定する。これにより:
  //   1. 本物の汚染（無関係なRJが大量に混入）は引き続き検出してrecordFetchErrorに倒す
  //   2. 単なる部分応答（一致した分は要求リスト内）は通常の per-work ループに通し、
  //      一致した作品は正しく価格保存され、不在の作品は recordApiMissing の
  //      段階的退避(7日→30日→180日+priority低下)に正しく乗る
  // (2)が無限リトライループ化していたのが本件の主因。
  const requestedKeys = new Set();
  for (const w of works) {
    const rj = w.rj_code.toUpperCase();
    requestedKeys.add(rj);
    requestedKeys.add(rj.replace(/^RJ0+/, 'RJ'));
  }
  const returnedKeys = Object.keys(normalizedBody);
  const foreignKeys  = returnedKeys.filter(k => !requestedKeys.has(k));
  const foreignRatio = returnedKeys.length > 0 ? foreignKeys.length / returnedKeys.length : 0;

  const MIN_BATCH_FOR_RATIO_CHECK  = 4;    // 部分一致の疑いはこれ未満の件数だと対象外（誤検出防止）
  const CONTAMINATION_FOREIGN_RATIO = 0.5; // 返ってきたキーの半数以上が要求外なら汚染とみなす
  // 完全不一致(foreignRatio=1, 一致0件)はバッチサイズによらず常に汚染確定として扱う。
  // 部分不一致は少数件バッチだとたまたま起きうるため MIN_BATCH_FOR_RATIO_CHECK で足切りする。
  const isContaminated = returnedKeys.length > 0 && (
    foreignRatio === 1 ||
    (works.length >= MIN_BATCH_FOR_RATIO_CHECK && foreignRatio >= CONTAMINATION_FOREIGN_RATIO)
  );

  if (isContaminated) {
    const matchedCount = works.length - works.filter(w => {
      const rj    = w.rj_code.toUpperCase();
      const nopad = rj.replace(/^RJ0+/, 'RJ');
      return !(rj in normalizedBody || nopad in normalizedBody);
    }).length;
    log.error('[detail] response contaminated (returned keys mostly unrelated to requested batch, likely stale CDN/proxy cache) — treating as fetch error, not delisted', {
      site,
      requestedCount: works.length,
      matchedCount,
      foreignRatio: foreignRatio.toFixed(2),
      requested: works.map(w => w.rj_code),
      foreignSample: foreignKeys.slice(0, 5),
    });
    db.transactionNoSave(() => {
      for (const w of works) db.recordFetchError(w.rj_code);
    });
    result.errors      += works.length;
    result.contaminated += works.length;
    return result;
  }

  // ── delisted化直前の作品だけ、詳細ページへ直接アクセスして存在確認する ──────
  // バッチAPIが「不在」を返しても、CDN/プロキシのキャッシュ汚染や一時的な
  // API不調である可能性が残る。特に consecutive_errors が既に1件溜まっている
  // 作品は、今回のミスで recordApiMissing() が priority=delisted まで
  // 落としてしまう(=以後最大180日ほぼ再確認されなくなる)ため、その直前だけ
  // 作品詳細ページ(/work/=/product_id/...)へ直接アクセスして本当に存在
  // しないか確認する。閾値に達していない作品まで毎回確認すると負荷が増える
  // ため、delisted化の瀬戸際にある作品だけに絞る。
  //
  // 効率化: works は db.getDueWorks() の `SELECT * FROM works ...` 結果を
  // そのまま引き継いでいるため、各要素に consecutive_errors が既に載っている。
  // 以前はここで notFoundKeys ごとに db.getWorkByRj() を再クエリしていたが、
  // 同期SQLクエリをバッチ件数分繰り返す無駄な往復だった。works配列を直接
  // 参照するだけで済む。
  const toVerify = [];
  for (const w of works) {
    const rj      = w.rj_code.toUpperCase();
    const rjNopad = rj.replace(/^RJ0+/, 'RJ');
    if (rj in normalizedBody || rjNopad in normalizedBody) continue;   // API上で見つかった
    if ((w.consecutive_errors ?? 0) >= 1) toVerify.push(w.rj_code);
  }

  const verifiedAlive = new Set();
  if (toVerify.length) {
    const VERIFY_CONCURRENCY = 3;
    let vi = 0;
    const verifyWorker = async () => {
      while (vi < toVerify.length) {
        const rjCode = toVerify[vi++];
        const status = await _verifyRjExists(rjCode, site);
        if (status === 'exists') {
          verifiedAlive.add(rjCode);
          log.warn('[detail] API missing but detail page confirms existence — rescuing from delisting', rjCode);
        }
        if (vi < toVerify.length) await sleep(300);   // 次がある場合のみ待機(最後の1件で無駄な待機をしない)
      }
    };
    await Promise.all(Array.from({ length: Math.min(VERIFY_CONCURRENCY, toVerify.length) }, verifyWorker));
  }

  db.transactionNoSave(() => {
    for (const w of works) {
      try {
        const dbKey   = w.rj_code;                          // DB に登録されているキー（これのみDB操作に使う）
        const rj      = dbKey.toUpperCase();
        const rjNopad = rj.replace(/^RJ0+/, 'RJ');
        const found   = rj in normalizedBody || rjNopad in normalizedBody;

        if (!found) {
          if (verifiedAlive.has(dbKey)) {
            // 詳細ページで実在確認済み → delisted化させず、一時的な取得失敗として扱う
            // (priorityは維持、intervalのみ延長。真に削除済みなら次回以降も
            //  ミスが続き、いずれ consecutive_errors 増加で自然にdelistedへ至る)
            db.recordFetchError(dbKey);
            result.errors++;
            result.fetchFail++;
            result.verifiedAlive++;
          } else {
            log.warn('[detail] key not in API response', rj,
              'available:', Object.keys(normalizedBody).slice(0, 3).join(', '));
            db.recordApiMissing(dbKey);   // API不在→急速退避
            result.errors++;
            result.apiMissing++;
          }
          continue;
        }

        // データ抽出用キーはnopadでも可、ただしDB操作は必ず dbKey を使う
        const dataKey     = (rj in normalizedBody) ? rj : rjNopad;
        const singleBody  = { [dbKey]: normalizedBody[dataKey] };  // DB キーで包み直す
        const changed     = _store(dbKey, singleBody);

        if (changed === null) {
          result.errors++;
          result.storeError++;
        } else {
          result.priceChanges += changed ? 1 : 0;
          result.processed++;
        }
      } catch (e) {
        log.error('[detail] store error', w.rj_code, e.message);
        db.recordFetchError(w.rj_code);
        result.errors++;
        result.storeError++;
      }
    }
  });

  return result;
}

// ─── 詳細ページ直読み確認（delisted化の瀬戸際にある作品のみ）───────────────────
// product/info/ajax バッチAPIではなく、作品詳細ページ本体へ直接アクセスして
// 存在有無を独立に確認する。バッチAPI側の一時的な不調・CDNキャッシュ汚染と
// 「本当に削除/非公開になった」を切り分けるための最終確認手段。
async function _verifyRjExists(rjCode, site) {
  const url = `${BASE}/${site}/work/=/product_id/${rjCode}.html`;
  try {
    const res = await fetchWithRetry(url, { headers: { Accept: 'text/html' } });
    if (res.status === 404) return 'gone';
    if (res.ok) return 'exists';
    log.warn('[detail] verifyRjExists non-ok/non-404 response', rjCode, res.status);
    return 'unknown';
  } catch (e) {
    log.warn('[detail] verifyRjExists fetch error', rjCode, e.message);
    return 'unknown';
  }
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
      // ストリーク記録・サーキット開閉・再ウォームアップの起動判定は
      // すべて _recordApiEmptyAndMaybeRecover に一元化されている(冒頭の
      // 「セッション健全性トラッキング」セクション参照)。
      await _recordApiEmptyAndMaybeRecover(site);
      return null;
    }
    // 成功(部分成功含む)したのでストリーク・サーキットともにクリアする
    _recordApiSuccess(site);
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

  const { work, price, priceIssue } = parsed;

  if (priceIssue) {
    db.recordPriceIssue(rjCode, priceIssue.type, priceIssue.raw);
  } else {
    // 過去にissueが記録されていて今回は正常に取れた場合はクリアする
    db.clearPriceIssue(rjCode);
  }

  // バグ修正(③の続き): price/price_work が両方欠損(no_price_field)、または
  // discount_rate>=100の異常値(price_work_missing_high_discount)のときは
  // parser.jsが安全策として price=0 等の信頼できない値を返す。これを
  // 無条件にsavePriceIfChangedへ渡すと「定価0円」でDB/配信データを
  // 上書きしてしまい、既存の正しい価格情報を破壊する(data ブランチで実在
  // 確認済み)。この場合は価格の書き込み自体をスキップし、既存の価格を
  // そのまま保持する(在庫/優先度スケジューリングは is_on_sale フラグだけで
  // 十分機能するため、work情報・巡回スケジュールの更新は通常通り行う)。
  const priceUnreliable = priceIssue?.type === 'no_price_field'
    || priceIssue?.type === 'price_work_missing_high_discount';

  // バグ修正(重大): savePriceIfChanged() は { changed, consecutive_no_change }
  // という「オブジェクト」を返す(changed=falseのときも！)。以前はこれを
  // そのまま真偽値として扱っていたため `if (changed)` 等が常にtruthyになり、
  // 実際には価格が変化していない作品も毎回「価格変動あり」として
  // カウント・ログされ続けていた(meta.json: processed===priceChangesが
  // 常に一致する不具合の直接の原因)。加えて `changed ? 0 : ...` が常に0を
  // 返すため consecutive_no_change が一切増加せず、"cold"優先度への降格が
  // 機能しない副作用もあった。.changed / .consecutive_no_change を正しく
  // 分解して使う。
  const saveResult = priceUnreliable
    ? { changed: false, consecutive_no_change: db.getWorkByRj(rjCode)?.consecutive_no_change ?? 0 }
    : db.savePriceIfChanged(rjCode, price);
  const changed  = saveResult.changed === true;
  const noChange = changed ? 0 : saveResult.consecutive_no_change + 1;

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

  const schedule = _schedule(work, price, noChange);

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

// ─── 完了ごとの自動デバッグpush ─────────────────────────────────────────────────
async function _runDetailFetchWithPush(...args) {
  let result, err;
  try {
    result = await runDetailFetch(...args);
    return result;
  } catch (e) {
    err = e;
    throw e;
  } finally {
    try {
      await pushDebugBundle({ job: 'detail', result: err ? { error: err.message } : result });
    } catch (pushErr) {
      log.error('[detail] pushDebugBundle failed', pushErr.message);
    }
  }
}

module.exports = { runDetailFetch: _runDetailFetchWithPush, fetchAndStore, saveDiscoveredPrice };
