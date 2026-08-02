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
const { getAbortSignal } = require('./abortSignals');
const apiTrace = require('./apiTrace');

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

// バグ修正(2026-07-27 実運用で確認): 空応答streakが閾値に達し再ウォーム
// アップを実行しても、診断結果(年齢確認ゲート不在+Cookie正常)から見て
// セッションは元々健全だったと分かるケースがある。この場合、再ウォーム後も
// 同じペースで空応答/劣化応答が継続する — 原因はセッション切れではなく
// product/info/ajaxエンドポイント単体へのレート制限/スロットリングだった
// と推測される。再ウォームは何も直さないため、同じ濃度でリクエストを
// 送り続けても再発するだけ。診断が「健全」だったサイトには一定時間だけ
// 並列度を落とし待機時間を増やすバックオフをかけ、DLsite側の警戒が
// 収まるのを待つ。_lastRewarmAt 同様、runDetailFetch()の呼び出しをまたいで
// 維持する(1回の巡回内だけでなく、次回の巡回でも抑制を継続させるため)。
const RATE_LIMIT_BACKOFF_MS     = 5 * 60_000; // 疑わしい場合の抑制継続時間
const RATE_LIMIT_BACKOFF_EXTRA  = 1500;       // バックオフ中に追加する待機(ms)

const _siteEmptyStreak       = {};  // site -> 連続空応答回数
const _circuitOpenBySite     = {};  // site -> このrunDetailFetch()呼び出し中は打ち切り中か
const _rewarmInProgressBySite = {}; // site -> 再ウォームアップ実行中か(重複起動防止)
const _siteBackoffUntil      = {};  // site -> レート制限疑いによる抑制の終了時刻(epoch ms)
let   _lastRewarmAt          = 0;   // runDetailFetch()をまたいでもクールダウンを維持する

// バグ修正(根本原因): 従来はサーキットが一度開くと、_shouldSkipRequest() が
// _apiFetch() の呼び出し自体を完全に止めてしまい、その結果 _apiFetch 内にしか
// ない回復判定(_recordApiEmptyAndMaybeRecover)も二度と実行されなくなっていた。
// つまり「サーキットが開いたら、その回のrunDetailFetch()が終わるまで
// 絶対に閉じない」状態で、途中でDLsite側の混雑が解消してもそれを検知する
// 手段が無かった。turboが94%エラーで終わった直後、何も変えずに次の
// (サーキットが実行単位でリセットされる)新規実行では0%エラーで
// 40万件処理できた実績があり、"実行を跨げば直る" = "実行中でも直せたはず"
// ということが分かっている。
// 古典的なサーキットブレーカーの Open → Half-Open 遷移を追加し、開放中でも
// 一定間隔ごとに1バッチだけ実際にfetchさせて回復を確認できるようにする。
const CIRCUIT_PROBE_INTERVAL_MS = 90_000; // 開放中でも90秒に1回だけ様子見リクエストを通す
const _circuitLastProbeAt       = {};     // site -> 直近にプローブを許可した時刻(epoch ms)

// ─── グローバルサーキット（複数サイト同時オープン検知）─────────────────────
// バグ修正の経緯: サーキットはこれまでサイト単位(maniax/girls/bl)で完全に独立して
// 開閉していた。しかし実機ログでは「複数サイトがほぼ同時に空応答streakへ突入する」
// パターンが繰り返し観測されており(例: 2026-07-28T11:44台のturboでmaniax/girls/bl
// 全サイトのエラー率が揃って急騰)、これは個々のサイトAPIの偶発的な不調ではなく、
// 使用中のIP/セッション全体がDLsite側から警戒された(全サイト共通のレート制限)結果
// と考えるのが自然。この場合、各サイトの独立したストリークがそれぞれ閾値5に
// 到達するまで待っていると、その間に他サイトへも無駄な失敗リクエストを送り
// 続けてしまい、劣化からの回復をかえって遅らせる。
// 一定数以上のサイトが同時にサーキット開放状態になったら「グローバル抑制」を
// 発動し、まだ閾値未到達の他サイトも含めて全サイトへのリクエストを
// _isInRateLimitBackoff() と同じ仕組み(並列度1・待機延長)で一時的に抑制する。
const GLOBAL_CIRCUIT_MIN_SITES  = 2;            // 同時オープンでグローバル発動する最小サイト数
const GLOBAL_CIRCUIT_BACKOFF_MS = 3 * 60_000;   // グローバル抑制の継続時間
let   _globalBackoffUntil       = 0;            // runDetailFetch()をまたいでも維持する(epoch ms)
let   _globalCircuitTriggeredAt = 0;            // 直近発動時刻（結果への付与・重複ログ抑制用）

// ─── 実行間の高エラー率履歴に基づく自動スロットル ───────────────────────────
// バグ修正の経緯: apiServer.js の _checkHighErrorRate() は 'all'/'turbo' 実行
// 完了後にエラー率を計算し、閾値(15%)超過なら highErrorRate フラグを立てて
// digest.log に警告するだけの事後診断だった。実機ログでは turbo/all が
// errorRate 0.94・0.48・0.25 等で終わる回が繰り返し発生しているにもかかわらず、
// 次回の turbo/all もまったく同じブースト設定(concurrency高め・rateLimit短め)
// で起動され、同じ劣化が再発していた — 「劣化を検知して警告する」ことと
// 「その情報を使って次回の負荷を実際に下げる」ことの間にフィードバックの
// 断絶があった(可視化止まりで自己防御になっていなかった)。
// 直近の(ブーストされた)実行が連続して高エラー率だった場合、次回の
// runDetailFetch() 開始時に自動で並列度を下げ・rateLimitを伸ばし、人手で
// config を見直すまでの間の被害を抑える。ストリークは正常な実行が1回
// 挟まればリセットされ、また長時間(AUTO_THROTTLE_RESET_AFTER_MS)実行が
// 無ければ「別の状況」とみなして忘れる。
const AUTO_THROTTLE_ERROR_RATE_THRESHOLD = 0.15;   // apiServer.js の閾値と揃える
const AUTO_THROTTLE_MIN_DENOM            = 50;     // サンプル数が少ない回は判定対象外
const AUTO_THROTTLE_STREAK_THRESHOLD     = 2;       // 連続でこの回数、高エラー率だったら自動抑制発動
const AUTO_THROTTLE_CONCURRENCY_CAP      = 2;       // 自動抑制中の並列度上限
const AUTO_THROTTLE_RATE_LIMIT_MIN_MS    = 1500;    // 自動抑制中のrateLimit下限(ms、これより短くしない)
const AUTO_THROTTLE_RESET_AFTER_MS       = 30 * 60_000; // この時間ノーラン(未実行)ならストリークを忘れる

const _consecutiveHighErrorRuns = {}; // jobName -> 連続高エラー率回数
const _lastRunFinishedAt        = {}; // jobName -> 直前実行の終了時刻(epoch ms)

/**
 * 呼び出し元(apiServer.js)から渡された rateLimit/concurrency を、直近の
 * 高エラー率ストリークに応じて上書きする。ストリークが閾値未満、または
 * ジョブ側が明示的にブースト値を渡していない(=通常巡回)場合はそのまま返す。
 */
function _maybeAutoThrottle(jobName, effRateLimit, effConcurrency) {
  if (!jobName) return { effRateLimit, effConcurrency, autoThrottled: false };

  const lastAt = _lastRunFinishedAt[jobName] ?? 0;
  if (Date.now() - lastAt > AUTO_THROTTLE_RESET_AFTER_MS) {
    _consecutiveHighErrorRuns[jobName] = 0; // 長時間空いた場合は状況が変わったとみなしリセット
  }

  const streak = _consecutiveHighErrorRuns[jobName] ?? 0;
  if (streak < AUTO_THROTTLE_STREAK_THRESHOLD) {
    return { effRateLimit, effConcurrency, autoThrottled: false };
  }

  const throttledConcurrency = Math.min(effConcurrency, AUTO_THROTTLE_CONCURRENCY_CAP);
  const throttledRateLimit   = Math.max(effRateLimit, AUTO_THROTTLE_RATE_LIMIT_MIN_MS);
  log.warn(
    `[detail] ${jobName}: 直近${streak}回連続で高エラー率だったため自動スロットルを発動します — ` +
    `concurrency ${effConcurrency}→${throttledConcurrency} / rateLimit ${effRateLimit}→${throttledRateLimit}ms ` +
    `(連続${AUTO_THROTTLE_STREAK_THRESHOLD}回、エラー率が正常水準に戻ると自動解除されます)`
  );
  return { effRateLimit: throttledRateLimit, effConcurrency: throttledConcurrency, autoThrottled: true };
}

/**
 * runDetailFetch() 完了時に呼ぶ。今回の結果からエラー率を計算し、
 * ストリークを更新する。サンプル数が少ない回は判定対象外(据え置き)。
 *
 * バグ修正: 以前は apiServer.js 側にも全く同じ「denom<50なら判定しない」
 * 「閾値0.15」という計算がハードコードで重複しており(_checkHighErrorRate)、
 * 片方だけ閾値を変えると自動抑制のトリガーと digest.log 上の表示が食い違う
 * リスクがあった。ここで計算したerrorRate/highErrorRateを result に
 * そのまま付与し、apiServer.js 側は再計算せずこの値を読むだけにする
 * (閾値・denom基準の一次情報源をここに一本化)。
 */
function _updateAutoThrottleStreak(jobName, result) {
  const denom = (result.processed ?? 0) + (result.errors ?? 0);
  if (denom < AUTO_THROTTLE_MIN_DENOM) {
    result.errorRate     = null;
    result.highErrorRate = false;
  } else {
    const errorRate = result.errors / denom;
    result.errorRate     = Math.round(errorRate * 1000) / 1000;
    result.highErrorRate = errorRate >= AUTO_THROTTLE_ERROR_RATE_THRESHOLD;
  }

  if (!jobName) return; // ストリーク追跡はブースト対象ジョブ('fetch'/'all'/'turbo')のみ
  _lastRunFinishedAt[jobName] = Date.now();

  if (denom < AUTO_THROTTLE_MIN_DENOM) return; // 判定不能、ストリークは維持

  if (result.highErrorRate) {
    _consecutiveHighErrorRuns[jobName] = (_consecutiveHighErrorRuns[jobName] ?? 0) + 1;
  } else {
    _consecutiveHighErrorRuns[jobName] = 0;
  }
}

/** レート制限疑いによる抑制期間中かどうか（サイト単位のバックオフ、またはグローバル抑制中） */
function _isInRateLimitBackoff(site) {
  return (_siteBackoffUntil[site] ?? 0) > Date.now() || _isInGlobalBackoff();
}

function _isInGlobalBackoff() {
  return _globalBackoffUntil > Date.now();
}

/**
 * サイトのサーキットが新たに開いた直後に呼ぶ。同時に開いているサイト数を
 * 数え、閾値以上ならグローバル抑制を発動する。既に発動中なら何もしない
 * (連続発動によるクールダウン延長の暴走を防ぐ)。
 */
function _maybeEscalateToGlobalCircuit(triggeringSite) {
  const openSites = Object.keys(_circuitOpenBySite).filter(s => _circuitOpenBySite[s]);
  if (openSites.length < GLOBAL_CIRCUIT_MIN_SITES) return;
  if (_isInGlobalBackoff()) return;
  _globalBackoffUntil       = Date.now() + GLOBAL_CIRCUIT_BACKOFF_MS;
  _globalCircuitTriggeredAt = Date.now();
  log.error(
    `[detail] グローバルサーキット発動 — ${openSites.length}サイト(${openSites.join(',')})が同時にサーキット開放中。` +
    `個別サイトの不調ではなくセッション/IP単位のレート制限の可能性が高いため、` +
    `全サイトへのリクエストを${Math.round(GLOBAL_CIRCUIT_BACKOFF_MS / 60000)}分間、並列度1まで抑制します`,
    { triggeringSite, openSites }
  );
}

function _resetSessionHealthState() {
  // circuit/streak は実行ごとにリセットする(前回打ち切ったサイトも今回はまず
  // 試す)。_lastRewarmAt はクールダウンの実効性を保つため実行をまたいで維持する。
  for (const site of Object.keys(_siteEmptyStreak))     delete _siteEmptyStreak[site];
  for (const site of Object.keys(_circuitOpenBySite))   delete _circuitOpenBySite[site];
  for (const site of Object.keys(_circuitLastProbeAt))  delete _circuitLastProbeAt[site];
}

/**
 * _processBatch がこのサイトへのリクエストを送るべきでないか(circuit開放中 or 再ウォーム中)。
 * サーキットが開いていても、前回プローブから CIRCUIT_PROBE_INTERVAL_MS 以上
 * 経過していれば、このバッチ1回分だけは実際にfetchさせる(Half-Open)。
 * 複数ワーカーが同時にこの条件を満たしても、直近プローブ時刻を即座に更新する
 * ことで多重プローブの発生をおおむね1回に抑える(取りこぼしは実害が小さいため許容)。
 */
function _shouldSkipRequest(site) {
  if (_rewarmInProgressBySite[site]) return true;
  if (!_circuitOpenBySite[site]) return false;
  const now = Date.now();
  if (now - (_circuitLastProbeAt[site] ?? 0) >= CIRCUIT_PROBE_INTERVAL_MS) {
    _circuitLastProbeAt[site] = now;
    log.info(`[detail] ${site}: サーキット開放中だが回復確認のためプローブを1件通します`);
    return false;
  }
  return true;
}

/** 成功(部分成功含む)を記録し、ストリーク・サーキットともにクリアする */
function _recordApiSuccess(site) {
  if (_circuitOpenBySite[site]) {
    log.info(`[detail] ${site}: プローブ成功 — サーキットを閉じて通常運転に戻します`);
  }
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
    _circuitOpenBySite[site]    = true;
    _circuitLastProbeAt[site]   = Date.now();
    _maybeEscalateToGlobalCircuit(site);
    return;
  }

  const now = Date.now();
  if (now - _lastRewarmAt < REWARM_COOLDOWN_MS) {
    log.warn('[detail] session re-warmup skipped (cooldown)', site,
      `${Math.ceil((REWARM_COOLDOWN_MS - (now - _lastRewarmAt)) / 1000)}s残り`);
    _circuitOpenBySite[site]  = true;
    _circuitLastProbeAt[site] = now;
    // ログ削減: サーキットブレーカーが自律的に対処する正常系(想定内の一時抑制)
    // であり、人間の即時対応を要するerrorではない。従来はerrorで記録して
    // いたため、正常に自己回復している状態でもエラーログが積み上がっていた。
    log.warn(`[detail] ${site}: 空応答が${EMPTY_STREAK_THRESHOLD}回連続、再ウォームアップはクールダウン中 — ` +
      `このサイトへのリクエストを今回の巡回では一時停止します(${Math.round(CIRCUIT_PROBE_INTERVAL_MS / 1000)}秒毎に回復確認)`);
    _maybeEscalateToGlobalCircuit(site);
    return;
  }

  _rewarmInProgressBySite[site] = true;
  _lastRewarmAt = now;
  // ログ削減: 再ウォームアップは試行段階であり、結果はこの後success(info)/
  // failure(error、catch節)のどちらかで確定する。試行を開始しただけの時点で
  // errorとして記録すると、成功して自己回復するケースまでエラーとして
  // 積み上がってしまうため、ここはwarnに留める。
  log.warn(`[detail] ${site}: 空応答が${EMPTY_STREAK_THRESHOLD}回連続 — セッション再確立を試みます`);
  try {
    await global._reWarmUpSession('reactive');
    log.info('[detail] session re-warmup completed, resuming', site);
    // 再ウォームアップ成功: ストリーク・サーキットともにクリアして
    // もう一度チャンスを与える(ここが従来の構造的不具合の修正点)。
    _siteEmptyStreak[site]   = 0;
    _circuitOpenBySite[site] = false;

    // 再ウォームの診断結果を見て、そもそもセッションが健全だったかを判定する。
    // gateAbsent(年齢確認ゲートが出ていない=既に通過済み)かつ
    // cookieObtained(年齢確認Cookieが存在)が両方成立していれば、今回の
    // 空応答streakはセッション切れが原因ではなかったと分かる。この場合は
    // レート制限を疑い、このサイトへのリクエストを一定時間だけ抑制する。
    const diag = global._lastWarmUpDiag?.results?.[site];
    if (diag?.cookieObtained && diag?.gateAbsent) {
      _siteBackoffUntil[site] = Date.now() + RATE_LIMIT_BACKOFF_MS;
      log.warn(`[detail] ${site}: 再ウォーム後も診断上はセッション健全(gate absent, cookie obtained) — ` +
        `セッション切れではなくレート制限の可能性が高いため、${Math.round(RATE_LIMIT_BACKOFF_MS / 60000)}分間このサイトへの並列度を抑制します`);
    }
  } catch (e) {
    log.error('[detail] session re-warmup failed', site, e.message);
    _circuitOpenBySite[site]  = true;
    _circuitLastProbeAt[site] = Date.now();
    log.error(`[detail] ${site}: セッション再確立に失敗 — ` +
      `このサイトへのリクエストを今回の巡回では一時停止します(${Math.round(CIRCUIT_PROBE_INTERVAL_MS / 1000)}秒毎に回復確認)`);
    _maybeEscalateToGlobalCircuit(site);
  } finally {
    _rewarmInProgressBySite[site] = false;
  }
}

// ─── デバッグ用スナップショット ─────────────────────────────────────────────
// このモジュール内の各種状態(_siteEmptyStreak/_circuitOpenBySite/
// _siteBackoffUntil/_globalBackoffUntil/_consecutiveHighErrorRuns等)は
// これまでWARN/ERRORログの文面からしか間接的に読み取れず、Claude等が
// リモートでdebugブランチのログだけを見て原因を特定する際、断片的な文字列
// メッセージを時系列でつなぎ合わせて現在の状態を再構築する必要があった
// （「このサイトは今サーキット開放中なのか」「グローバル抑制はいつまでか」
// といった"今の状態"を一目で確認できる場所が無かった）。
// pushDebugBundle.js から呼び出し、debug-summary.md に現在の状態を
// そのままダンプできるようにする。
function getHealthSnapshot() {
  const now = Date.now();
  const remainMs = until => Math.max(0, (until ?? 0) - now);

  const sites = new Set([
    ...Object.keys(_siteEmptyStreak),
    ...Object.keys(_circuitOpenBySite),
    ...Object.keys(_siteBackoffUntil),
  ]);

  const perSite = {};
  for (const site of sites) {
    perSite[site] = {
      emptyStreak:       _siteEmptyStreak[site] ?? 0,
      circuitOpen:       !!_circuitOpenBySite[site],
      rewarmInProgress:  !!_rewarmInProgressBySite[site],
      rateLimitBackoffRemainingSec: Math.round(remainMs(_siteBackoffUntil[site]) / 1000),
    };
  }

  return {
    perSite,
    global: {
      backoffActive:            _isInGlobalBackoff(),
      backoffRemainingSec:      Math.round(remainMs(_globalBackoffUntil) / 1000),
      lastTriggeredAt:          _globalCircuitTriggeredAt ? new Date(_globalCircuitTriggeredAt).toISOString() : null,
    },
    rewarm: {
      lastRewarmAt:          _lastRewarmAt ? new Date(_lastRewarmAt).toISOString() : null,
      cooldownRemainingSec:  Math.round(remainMs(_lastRewarmAt + REWARM_COOLDOWN_MS) / 1000),
    },
    autoThrottle: Object.fromEntries(
      Object.keys(_consecutiveHighErrorRuns).map(jobName => [jobName, {
        consecutiveHighErrorRuns: _consecutiveHighErrorRuns[jobName] ?? 0,
        active: (_consecutiveHighErrorRuns[jobName] ?? 0) >= AUTO_THROTTLE_STREAK_THRESHOLD,
        lastRunFinishedAt: _lastRunFinishedAt[jobName] ? new Date(_lastRunFinishedAt[jobName]).toISOString() : null,
      }])
    ),
  };
}

// ─── public ──────────────────────────────────────────────────────────────────

async function runDetailFetch(limit = 300, { onProgress, rateLimit, concurrency, jobName } = {}) {
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
  const requestedRateLimit   = rateLimit   ?? config.fetch.rateLimit;
  const requestedConcurrency = concurrency ?? config.fetch.concurrency;

  // 直近の(ブーストされた)実行が連続で高エラー率だった場合、要求された値を
  // さらに下げる（詳細は「実行間の高エラー率履歴に基づく自動スロットル」参照）。
  const throttle = _maybeAutoThrottle(jobName, requestedRateLimit, requestedConcurrency);
  const effRateLimit   = throttle.effRateLimit;
  const effConcurrency = throttle.effConcurrency;

  // due な作品が limit を超える場合でも、1回の呼び出しで全件処理し終えるまでループする。
  // （以前は limit 件で必ず打ち切られ、「全て巡回」等で残りが無視されるバグがあった）
  // rateLimit/concurrencyをresultに含める: apiServer.js/scheduler.jsはこの
  // オブジェクトをそのままdigest.logへ展開する(Object.entries(_lastResult[job]))
  // ため、これだけで「そのジョブが実際にどのパラメータで走ったか」が
  // digest.log/events.jsonlに残るようになる(以前は事後にログから推測するしかなく、
  // 特にturbo/allのブースト値・自動スロットル後の実効値は一切記録されていなかった)。
  const result = { processed: 0, priceChanges: 0, errors: 0, total: 0, apiMissing: 0, contaminated: 0, fetchFail: 0, storeError: 0, verifiedAlive: 0, autoThrottled: throttle.autoThrottled, rateLimit: effRateLimit, concurrency: effConcurrency };

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
    // レート制限疑いのバックオフ中は、並列度を1まで落とし待機時間も
    // 増やして負荷を下げる（詳細は _siteBackoffUntil のコメント参照）。
    const inBackoff = _isInRateLimitBackoff(site);

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
          const jittered = Math.round(rl * 0.8 + Math.random() * rl * 0.4)
            + (inBackoff ? RATE_LIMIT_BACKOFF_EXTRA : 0);
          await sleep(jittered);
        }
      }
    }

    const poolSize = inBackoff
      ? 1
      : Math.max(1, Math.min(effConcurrency ?? 1, chunks.length));
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
    // ログ削減: due 500件の全走査で不正 site_id が多数あると1件ずつ
    // WARNが積み上がっていた。個別詳細はtrace(events.jsonl)に落とし、
    // この取得バッチ単位で件数集約1行だけwarnで出す。
    const unknownSiteIdCounts = {};
    for (const w of due) {
      const raw = w.site_id ?? 'maniax';
      const s   = VALID_SITES.has(raw) ? raw : 'maniax';
      if (s !== raw) {
        log.trace('[detail] unknown site_id fallback:', raw, '->', s, w.rj_code);
        unknownSiteIdCounts[raw] = (unknownSiteIdCounts[raw] ?? 0) + 1;
      }
      (bySite[s] ??= []).push(w);
    }
    if (Object.keys(unknownSiteIdCounts).length > 0) {
      log.warn('[detail] unknown site_id fallback (aggregated)', unknownSiteIdCounts, '-> maniax');
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

  _updateAutoThrottleStreak(jobName, result);

  log.info('[detail] done', result);
  return result;
}

// 単体fetch（--rj オプション / テスト用）
async function fetchAndStore(rjCode, siteId = 'maniax') {
  const body = await _apiFetch([{ rj_code: rjCode }], siteId);
  if (!body) { db.transaction(() => db.recordFetchError(rjCode)); return false; }
  let changed = false;
  db.transaction(() => { changed = _store(rjCode, body, siteId); });
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
  // ログ削減: このバッチ内で発生したper-item相当の「対処済み異常」を集計し、
  // バッチ処理の最後に1行のwarnサマリとして出す（個別ログはtraceへ降格）。
  // 集計キー例: no_price_field / ambiguous / key_not_in_response / verify_rescued 等。
  const issueTally = {};
  const _tally = (key) => { issueTally[key] = (issueTally[key] ?? 0) + 1; };

  // バグ修正: 停止ボタン/turboの横取り等でこのジョブ系統(detail)が中止された
  // 場合、以前はここをすり抜けて _apiFetch が「aborted」エラーで失敗 →
  // 通常の失敗と区別されずバイナリ分割(50→25×2)して再試行 → 当然その再試行も
  // 即座に「aborted」で失敗 → recordFetchError で該当作品全ての次回チェック
  // 間隔を延ばしてしまう、という無駄かつ有害な連鎖が起きていた
  // (2026-07-23 05:27のログで確認: 中断直後に "batch fail, splitting" と
  //  "API fetch error aborted" が多数連発していた)。
  // 中止要求が既に来ている場合は、fetchも分割もDB更新も一切行わず即座に
  // 空の結果を返す。該当作品は due のまま残るため、次回実行時に
  // ペナルティなしで再試行される。
  if (getAbortSignal('detail').aborted) return result;

  // サーキットが開いている/再ウォームアップ中なら、ネットワークを叩かずに即座に
  // スキップする。
  // バグ修正: 以前は recordFetchError() を呼んでいたが、これは
  // consecutive_errors を積み増す関数であり、抑制が長引く/繰り返されると
  // (cron 10分毎に再発するようなセッション不調時)個々の作品には何の問題も
  // 無いにもかかわらず15回到達でセール中作品等の priority が強制的に
  // normal まで下げられてしまっていた（サーキット抑制はセッション全体の
  // 一時的な問題であり、個々の作品のfetch失敗ではないため区別すべき）。
  // db.recordCircuitSkip() は next_check_at のみを先送りし、
  // consecutive_errors/priority には触れない。
  if (_shouldSkipRequest(site)) {
    db.transactionNoSave(() => {
      for (const w of works) db.recordCircuitSkip(w.rj_code);
    });
    result.errors    += works.length;
    result.fetchFail  += works.length;
    return result;
  }

  let body = await _apiFetch(works, site);

  // ここでも中止が割り込んでいないか再確認する。_apiFetch実行中に停止ボタンが
  // 押された場合、bodyはnullになるが、これは「DLsiteが応答しなかった」のではなく
  // 「こちらから中断した」ことによるnullなので、以降の分割・recordFetchErrorの
  // 対象にしてはならない。
  if (!body && getAbortSignal('detail').aborted) return result;

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
    if (getAbortSignal('detail').aborted) {
      // 1つ目の分割が中止で打ち切られたなら、2つ目のための待機・fetchも省略する
      result.processed    += r1.processed;
      result.priceChanges += r1.priceChanges;
      result.errors       += r1.errors;
      result.apiMissing    += r1.apiMissing;
      result.contaminated  += r1.contaminated;
      result.fetchFail      += r1.fetchFail;
      result.storeError    += r1.storeError;
      result.verifiedAlive += r1.verifiedAlive;
      return result;
    }
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
    apiTrace.record({
      kind: 'contamination', site,
      requestedCount: works.length, matchedCount,
      foreignRatio: Number(foreignRatio.toFixed(2)),
      requested: works.map(w => w.rj_code),
      foreignSample: foreignKeys.slice(0, 5),
    });
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
  // バグ修正(2026-07-27 実運用で確認): このサイトが空応答streak由来の
  // レート制限バックオフ中(_isInRateLimitBackoff)の場合、not-found判定された
  // 作品ごとに詳細ページへ直接アクセスする救済確認(_verifyRjExists、最大3並列)を
  // 一切行わないようにする。劣化応答は一度に大量の「見つからない」を生むため、
  // まさにDLsite側の警戒を鎮めたい期間中に大量の追加リクエストを送ってしまい、
  // レート制限からの回復を妨げる自己増幅ループになっていた(実機ログで
  // 「空応答5回連続→再ウォーム→健全判定→5分間抑制」を数分おきに繰り返し続けて
  // いたことで発覚)。バックオフ中はこの追加確認をスキップし、単純な
  // recordFetchError(priorityは変えずintervalのみ延長)に倒す。バックオフが
  // 解除された後の正常な巡回で通常どおり再評価される。
  const skipVerify = _isInRateLimitBackoff(site);
  for (const w of works) {
    const rj      = w.rj_code.toUpperCase();
    const rjNopad = rj.replace(/^RJ0+/, 'RJ');
    if (rj in normalizedBody || rjNopad in normalizedBody) continue;   // API上で見つかった
    if (!skipVerify && (w.consecutive_errors ?? 0) >= 1) toVerify.push(w.rj_code);
  }
  if (skipVerify && works.some(w => (w.consecutive_errors ?? 0) >= 1)) {
    log.debug('[detail] rate-limit backoff中のためverifyRjExists救済確認をスキップ', site);
  }

  const verifiedAlive = new Set();
  // バグ修正: 以前は _verifyRjExists() の戻り値のうち 'exists' だけを見ており、
  // 'unknown'（fetch失敗・タイムアウト・404でも200でもない応答）は 'gone' と
  // 事実上同じ扱いで recordApiMissing（delisted化）へ進んでいた。
  // 'unknown' は「確認できなかった」であって「消滅を確認した」ではないため、
  // ネットワーク瞬断等で verify 自体がたまたま失敗しただけの作品まで
  // 誤ってdelisted化されるリスクがあった。verify結果をrjCodeごとに保持し、
  // 呼び出し元で 'unknown' は recordFetchError（priority維持）に、
  // 確認できた 'gone' のみ recordApiMissing に倒せるようにする。
  const verifyStatus = new Map(); // rjCode -> 'exists' | 'gone' | 'unknown'
  if (toVerify.length) {
    const VERIFY_CONCURRENCY = 3;
    let vi = 0;
    const verifyWorker = async () => {
      while (vi < toVerify.length) {
        const rjCode = toVerify[vi++];
        const status = await _verifyRjExists(rjCode, site);
        verifyStatus.set(rjCode, status);
        if (status === 'exists') {
          verifiedAlive.add(rjCode);
          _tally('verify_rescued');
          log.trace('[detail] API missing but detail page confirms existence — rescuing from delisting', rjCode);
        } else if (status === 'unknown') {
          _tally('verify_unknown');
          log.trace('[detail] verify inconclusive (not confirmed gone) — deferring to fetch-error instead of delisting', rjCode);
        }
        if (vi < toVerify.length) await sleep(300);   // 次がある場合のみ待機(最後の1件で無駄な待機をしない)
      }
    };
    await Promise.all(Array.from({ length: Math.min(VERIFY_CONCURRENCY, toVerify.length) }, verifyWorker));
  }

  // ── データ汚染対策③: site_id_unverified(CSV/JSONインポート由来で'maniax'固定
  // 復元された)作品がこのサイトのAPIで見つからなかった場合、recordApiMissing
  // (誤delistedの引き金)に倒す前に他サイトファミリーを試行し、本来のsite_idを
  // 確定させる。全サイトで不在だった場合のみ通常のapiMissing経路へ進む。
  const unresolvedImported = [];
  for (const w of works) {
    const rj      = w.rj_code.toUpperCase();
    const rjNopad = rj.replace(/^RJ0+/, 'RJ');
    if (rj in normalizedBody || rjNopad in normalizedBody) continue;
    if (w.site_id_unverified) unresolvedImported.push(w);
  }

  const resolvedSite = new Map(); // rj_code -> { site, body }
  const confirmedNotFound = new Set(); // 全サイト試行しても見つからなかった rj_code
  if (unresolvedImported.length) {
    const altSites = (config.dlsite.sites ?? ['maniax', 'bl', 'girls']).filter(s => s !== site);
    for (const w of unresolvedImported) {
      let found = false;
      for (const altSite of altSites) {
        const body = await _apiFetch([{ rj_code: w.rj_code }], altSite);
        if (body && Object.keys(body).length > 0) {
          resolvedSite.set(w.rj_code, { site: altSite, body });
          _tally('site_id_resolved');
          log.trace('[detail] site_id_unverified: resolved via alternate site', w.rj_code, altSite);
          found = true;
          break;
        }
        await sleep(200);
      }
      if (!found) confirmedNotFound.add(w.rj_code);
    }
  }

  db.transactionNoSave(() => {
    for (const w of works) {
      try {
        const dbKey   = w.rj_code;                          // DB に登録されているキー（これのみDB操作に使う）
        const rj      = dbKey.toUpperCase();
        const rjNopad = rj.replace(/^RJ0+/, 'RJ');
        const found   = rj in normalizedBody || rjNopad in normalizedBody;

        if (!found) {
          const resolved = resolvedSite.get(dbKey);
          if (resolved) {
            // 他サイトで発見 → site_idを訂正し正常経路として保存する
            const rBody     = resolved.body;
            const rDataKey  = (rj in rBody) ? rj : (rjNopad in rBody ? rjNopad : Object.keys(rBody)[0]);
            const singleBody = { [dbKey]: rBody[rDataKey] };
            db.updateSiteId(dbKey, resolved.site);
            db.clearSiteIdUnverified(dbKey);
            const changed = _store(dbKey, singleBody, resolved.site, issueTally);
            if (changed === null) { result.errors++; result.storeError++; }
            else { result.priceChanges += changed ? 1 : 0; result.processed++; }
            continue;
          }
          if (verifiedAlive.has(dbKey)) {
            // 詳細ページで実在確認済み → delisted化させず、一時的な取得失敗として扱う
            // (priorityは維持、intervalのみ延長。真に削除済みなら次回以降も
            //  ミスが続き、いずれ consecutive_errors 増加で自然にdelistedへ至る)
            db.recordFetchError(dbKey);
            result.errors++;
            result.fetchFail++;
            result.verifiedAlive++;
          } else {
            _tally('key_not_in_response');
            log.trace('[detail] key not in API response', rj,
              'available:', Object.keys(normalizedBody).slice(0, 3).join(', '));
            // 全サイト試行済みでも見つからなかったインポート由来作品は、
            // これ以上「未検証」のまま毎回全サイト再試行を繰り返さないよう
            // ここでフラグを解除してから通常のapiMissing経路に進める。
            if (confirmedNotFound.has(dbKey)) db.clearSiteIdUnverified(dbKey);
            if (skipVerify) {
              // レート制限バックオフ中は「not found」という応答自体が信頼できないため、
              // delisted化(recordApiMissing)には倒さず、通常のfetch失敗として扱う。
              db.recordFetchError(dbKey);
              result.errors++;
              result.fetchFail++;
            } else if (verifyStatus.get(dbKey) === 'unknown') {
              // バグ修正: verify自体が失敗/確定できなかった(ネットワーク瞬断・
              // タイムアウト・404でも200でもない応答)場合は「消滅を確認した」
              // わけではないため、gone確定の場合と同じdelisted経路(recordApiMissing)
              // に倒さない。次回巡回でconsecutive_errorsが増えれば自然にdelisted
              // へ至るため、誤って早期にdelisted化するリスクを避ける。
              db.recordFetchError(dbKey);
              result.errors++;
              result.fetchFail++;
            } else {
              db.recordApiMissing(dbKey);   // API不在→急速退避（verify未実施 or 'gone'確認済み）
              result.errors++;
              result.apiMissing++;
            }
          }
          continue;
        }

        // データ抽出用キーはnopadでも可、ただしDB操作は必ず dbKey を使う
        const dataKey     = (rj in normalizedBody) ? rj : rjNopad;
        const singleBody  = { [dbKey]: normalizedBody[dataKey] };  // DB キーで包み直す
        const changed     = _store(dbKey, singleBody, site, issueTally);
        // 現在のsite_idでの取得に成功した = このsite_idは正しかったと確定
        if (w.site_id_unverified) db.clearSiteIdUnverified(dbKey);

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

  if (Object.keys(issueTally).length > 0) {
    log.warn('[detail] batch issues summary', { site, batchSize: works.length, ...issueTally });
  }

  return result;
}

// ─── 詳細ページ直読み確認（delisted化の瀬戸際にある作品のみ）───────────────────
// product/info/ajax バッチAPIではなく、作品詳細ページ本体へ直接アクセスして
// 存在有無を独立に確認する。バッチAPI側の一時的な不調・CDNキャッシュ汚染と
// 「本当に削除/非公開になった」を切り分けるための最終確認手段。
async function _verifyRjExists(rjCode, site) {
  const url = `${BASE}/${site}/work/=/product_id/${rjCode}.html`;
  try {
    const res = await fetchWithRetry(url, { headers: { Accept: 'text/html' } }, 'detail');
    if (res.status === 404) return 'gone';
    if (!res.ok) {
      log.warn('[detail] verifyRjExists non-ok/non-404 response', rjCode, res.status);
      return 'unknown';
    }
    // バグ修正: 以前は HTTP 200 であれば無条件に 'exists' としていたが、
    // DLsiteが200 OKのまま年齢確認ページ・代替/エラーページを返すケースを
    // 区別できていなかった。年齢確認ゲート特有の文言(electron-main.jsの
    // AGE_GATE_SIGNAL_REと同じパターン)が含まれる場合、商品情報そのものは
    // 確認できていないため 'exists' と断定しない。また、商品ページ特有の
    // マーカー(自RJコード自体・work_name/product_id等)が本文に見当たらない
    // 場合も、200 OKだが別ページ(検索結果へのフォールバック等)の可能性が
    // あるため 'exists' としない。どちらも「実在しないと確認できたわけではない」
    // ため 'gone' ではなく 'unknown'（recordFetchErrorに倒れる、delisted化しない）
    // として扱い、安全側に倒す。
    const html = await res.text();
    const head = html.slice(0, 6000);
    const AGE_GATE_SIGNAL_RE = /(18歳|年齢確認|age.?check|age.?verif|adult.?check)/i;
    if (AGE_GATE_SIGNAL_RE.test(head)) {
      log.warn('[detail] verifyRjExists: age-gate encountered, cannot confirm product existence', rjCode, site);
      return 'unknown';
    }
    // バグ修正: hasProductMarker チェックは地域ブロックページも間接的に
    // 'unknown' へ落とせていたが(マーカーが無いため)、原因がage-gateなのか
    // 地域ブロックなのか区別がつかずログだけでは追いにくかった。
    // electron-main.js/parser.jsと同じ判定基準で明示的にログを分ける。
    if (parser.isRegionBlockedHtml(head)) {
      log.warn('[detail] verifyRjExists: 地域制限/アクセス不能ページの疑い、existsと誤判定しないようunknown扱いにします', rjCode, site);
      return 'unknown';
    }
    const hasProductMarker =
      html.toUpperCase().includes(rjCode.toUpperCase()) &&
      /work_name|product_id|itemprop=["']name["']/i.test(html);
    if (!hasProductMarker) {
      log.warn('[detail] verifyRjExists: 200 OK but no product markers found, treating as unknown', rjCode, site);
      return 'unknown';
    }
    return 'exists';
  } catch (e) {
    log.warn('[detail] verifyRjExists fetch error', rjCode, e.message);
    return 'unknown';
  }
}

// ─── API fetch ────────────────────────────────────────────────────────────────

async function _apiFetch(works, site) {
  // DLsite API は product_id[] 形式（配列）を要求する
  const params = works.map(w => `product_id%5B%5D=${encodeURIComponent(w.rj_code)}`).join('&');
  // バグ修正(データ汚染対策①): cdn_cache_min=1 はCDN側に「最低1分キャッシュしてよい」と
  // 明示的に許可するパラメータだった。一方でqueue.js側はCache-Control: no-cache等の
  // ヘッダーでキャッシュ利用禁止を伝えており、自己矛盾した指示を送っていた
  // (foreignRatio判定によるCDN汚染検出は事後対応でしかなく、入口を塞がなければ
  // 汚染発生率自体は下がらない)。パラメータ自体を削除する。
  const url    = `${BASE}/${site}/product/info/ajax?${params}`;
  try {
    const res = await fetchWithRetry(url, {
      headers: { Accept: 'application/json, */*' },
    }, 'detail');
    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      apiTrace.record({
        kind: 'http-error', site, url, status: res.status,
        contentType: res.headers.get('content-type'),
        cfRay: res.headers.get('cf-ray'),
        requested: works.map(w => w.rj_code),
        bodySample: bodyText.slice(0, 500),
      });
      log.error('[detail] API HTTP error', res.status, site, `${works.length}件`,
        works.slice(0,3).map(w=>w.rj_code).join(','));
      return null;
    }
    const body = await res.json();
    const returnedKeys = Object.keys(body).length;
    if (returnedKeys === 0) {
      apiTrace.record({
        kind: 'empty', site, url, status: res.status,
        contentType: res.headers.get('content-type'),
        requested: works.map(w => w.rj_code),
      });
      log.warn('[detail] API returned empty object', site, `requested ${works.length}件`,
        'sample:', works.slice(0,2).map(w=>w.rj_code).join(','));
      // ストリーク記録・サーキット開閉・再ウォームアップの起動判定は
      // すべて _recordApiEmptyAndMaybeRecover に一元化されている(冒頭の
      // 「セッション健全性トラッキング」セクション参照)。
      await _recordApiEmptyAndMaybeRecover(site);
      return null;
    }
    // バグ修正: 以前は returnedKeys > 0 でありさえすれば(たとえ50件要求して
    // 1件しか返らなくても)無条件に「成功」としてストリークをリセットしていた。
    // そのため、CDN/APIが慢性的に「ほぼ空だが完全にゼロではない」応答を返し
    // 続ける状態(2026-07-23 05:03/05:37のログで確認: 1バッチあたり要求50件中
    // 実質2〜3件しか返らない状態が延々と繰り返された)では、空応答ストリークが
    // 一度も閾値(5)に達せず、既存の自動セッション再確立(_recordApiEmptyAndMaybeRecover)
    // が永久に発動しないという盲点があった。マッチ率が著しく低い(既定20%未満)
    // 応答は「実質的に空」とみなし、空応答と同じストリーク/回復判定に乗せる。
    // ただし返ってきた分のデータ自体は無駄にしない(bodyはそのまま返して
    // _processBatch側で通常どおり保存させる)。
    // バッチが小さいと比率が安定しないため、CDN汚染判定と同様に
    // 最低件数(SEVERE_PARTIAL_MIN_BATCH)以上のバッチにのみ適用する。
    const SEVERE_PARTIAL_MIN_BATCH  = 4;
    const SEVERE_PARTIAL_RATIO      = 0.2;
    const isSeverelyPartial =
      works.length >= SEVERE_PARTIAL_MIN_BATCH &&
      returnedKeys < works.length * SEVERE_PARTIAL_RATIO;

    if (isSeverelyPartial) {
      // バグ修正(重大・データ破壊): 以前はここで body をそのまま _processBatch に渡し、
      // 返ってきた少数件については通常どおり価格保存・is_on_sale更新・サークルの
      // on_sale伝播(_handleCircleSale→boostCircleWorks)まで信頼して実行していた。
      // しかし「著しく劣化した応答」はCDN/中間プロキシが別クエリ由来の断片データを
      // 混入させている可能性が高く(cdn_cache_min廃止後も観測される)、この少数件の
      // 中身自体が汚染されている(誤ってis_sale=1等)危険がある。
      // 実際に本番DBで「セール中 531000/534619件」「セール中サークル 48994/49353件」
      // という99%超が恒常的にon_sale扱いになる異常が発生しており、severely partial
      // レスポンスに含まれる汚染データがcircles.on_saleへ伝播→boostCircleWorks()で
      // サークル全体を巻き込み、雪だるま式に拡大していたのが根本原因と特定した。
      // 「空応答扱い(=ストリーク加算・再ウォーム判定)」はそのまま行うが、
      // 中身は一切信頼せず破棄する。該当作品はrecordFetchError扱い(intervalのみ延長、
      // priority/is_on_saleは変更しない)となり、次回の正常な巡回で改めて取得される。
      apiTrace.record({
        kind: 'severe-partial', site, url,
        returnedKeys, requestedCount: works.length,
        bodySample: JSON.stringify(body).slice(0, 500),
      });
      log.warn('[detail] API response severely degraded (near-empty, discarding partial data as unreliable, counted toward recovery streak)', site,
        `got ${returnedKeys} / requested ${works.length}`);
      await _recordApiEmptyAndMaybeRecover(site);
      return null;
    }

    // 成功(通常の部分成功含む)したのでストリーク・サーキットともにクリアする
    _recordApiSuccess(site);
    if (returnedKeys < works.length * 0.5) {
      log.warn('[detail] API returned partial data', site,
        `got ${returnedKeys} / requested ${works.length}`);
    }
    return body;
  } catch (e) {
    // バグ修正: 停止ボタン/turboの横取り等による意図的な中断(fetchWithRetryが
    // 投げる "aborted: <url>")も、それ以外の本物のネットワーク/APIエラーと
    // 同じ log.error() で記録していたため、debugブランチのエラーログや
    // digest調査時に「大量のエラーが発生した」ように見えるノイズになっていた
    // (実際は中断の正常な副産物で対応不要)。中断由来のものは info レベルに
    // 格下げし、recentErrors/latest-error.log には残さない。
    if (/^aborted:/.test(e.message)) {
      log.info('[detail] API fetch aborted (intentional stop)', site, `${works.length}件`);
    } else {
      log.error('[detail] API fetch error', e.message, site, `${works.length}件`);
    }
    return null;
  }
}

// ─── 1件保存 ─────────────────────────────────────────────────────────────────

function _store(rjCode, body, site = null, issueTally = null) {
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

  // ── セール価格が定価として固定される現象の検知 ──────────────────────────
  // DLsiteのセールが終了した直後、CDNキャッシュ残留やAPI応答の一時的な
  // 不整合により is_sale=false で返ってきた price_work/price が、実は
  // まだ古いセール価格のままのことがある。これをそのまま「定価」として
  // 保存すると、以後ずっと安い金額が定価扱いになり、割引率計算・最安値
  // アラート等が全て狂う恒久的なデータ破損になる。
  //
  // 検知方法: 直前の巡回でセール中(existing.is_on_sale=1)だった作品が、
  // 今回is_on_sale=falseに切り替わったのに、新しい「定価」が直前の
  // セール価格(cur_sale_price)以下になっているケースを疑わしいとみなす。
  // ただし本当に定価改定(値下げ)された正当なケースもゼロではないため、
  // 即座に拒否はせず、次回巡回でも同じ値が再現された場合のみ受け入れる
  // (price_issuesテーブルのoccurrences/raw_fieldsを使って前回値と比較する)。
  let staleSalePriceSuspected = false;
  if (!priceIssue && price.is_on_sale === 0 && price.price != null) {
    const existingForStaleCheck = db.getWorkByRj(rjCode);
    if (existingForStaleCheck?.is_on_sale === 1 &&
        existingForStaleCheck.cur_sale_price != null &&
        price.price <= existingForStaleCheck.cur_sale_price) {
      const prior = db.getPriceIssue(rjCode);
      let priorPrice = null;
      if (prior?.issue_type === 'sale_price_as_regular_suspected') {
        try { priorPrice = JSON.parse(prior.raw_fields ?? '{}').new_price ?? null; } catch { /* ignore */ }
      }
      if (priorPrice === price.price) {
        // 2回連続で同じ値 → 一時的な不整合ではなく実際の値下げの可能性が
        // 高いと判断し、通常通り保存を許可する。
        db.clearPriceIssue(rjCode);
      } else {
        staleSalePriceSuspected = true;
        db.recordPriceIssue(rjCode, 'sale_price_as_regular_suspected', {
          new_price: price.price, prev_regular: existingForStaleCheck.cur_price,
          prev_sale: existingForStaleCheck.cur_sale_price, is_sale: false,
        });
        log.warn('[detail] sale price may have stuck as regular price — holding previous price, will confirm next check',
          rjCode, { new_price: price.price, prev_regular: existingForStaleCheck.cur_price, prev_sale: existingForStaleCheck.cur_sale_price });
      }
    }
  }

  if (priceIssue) {
    db.recordPriceIssue(rjCode, priceIssue.type, priceIssue.raw);
    if (issueTally) issueTally[priceIssue.type] = (issueTally[priceIssue.type] ?? 0) + 1;
    // price_issues.raw_fields は priceIssue.type ごとに厳選した一部フィールドのみ
    // (parser.js側で判定に使ったキーだけ)しか保持しておらず、そこに現れない
    // 未知のAPIフィールド（例: official_price/discountオブジェクトが実運用で
    // どんな形で来ているか）を後から調べる手立てがなかった。ここで該当RJの
    // 生APIレスポンス全体(body[rjCode]相当)をapiTrace(直近50件・メモリのみ)に
    // 積んでおくことで、/api/debug/api-trace とデバッグバンドル経由で
    // 「parserが判定に使わなかったフィールドまで含めた生の姿」を確認できるようにする。
    const rawBody = body[rjCode] ?? body[rjCode.toUpperCase()]
      ?? body[Object.keys(body)[0]] ?? null;
    apiTrace.record({
      kind: 'price-issue', site, rjCode, issueType: priceIssue.type,
      raw: rawBody,
    });
  } else if (!staleSalePriceSuspected) {
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
    || priceIssue?.type === 'price_work_missing_high_discount'
    || priceIssue?.type === 'invalid_price_combo'
    || staleSalePriceSuspected;

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
// バグ修正: 以前は呼び出し元(fetch/all/turbo/main.jsのどれか)に関わらず
// 常に job:'detail' 固定でpushしていたため、debugブランチのmeta.json/
// digest-recent.logを見ても実際にどのジョブ(特にturbo/allのブースト設定で
// 実行されたものか)が原因でエラー率が高騰したのか判別できなかった。
// 呼び出し元がoptionsに渡した jobName（'fetch'/'all'/'turbo'）をそのまま
// ラベルとして使い、未指定時のみ従来通り 'detail' にフォールバックする。
async function _runDetailFetchWithPush(limit, opts = {}) {
  const jobLabel = opts.jobName ?? 'detail';
  let result, err;
  try {
    result = await runDetailFetch(limit, opts);
    return result;
  } catch (e) {
    err = e;
    throw e;
  } finally {
    try {
      await pushDebugBundle({ job: jobLabel, result: err ? { error: err.message } : result });
    } catch (pushErr) {
      log.error('[detail] pushDebugBundle failed', pushErr.message);
    }
  }
}

module.exports = { runDetailFetch: _runDetailFetchWithPush, fetchAndStore, saveDiscoveredPrice, getHealthSnapshot };
