'use strict';

/**
 * scripts/pushDebugBundle.js
 *
 * 巡回ジョブ(discovery/detail/fullscan/endingsoon/circlegap/newrelease/compScan等)が
 * 完了するたびに、直近ログ・digest・構造化イベント・DB統計・price_issues を
 * GitHubへpushする。**ユーザーがログを手元からコピペしなくても、Claude(や他の
 * AIアシスタント)がリポジトリをpull/fetchするだけで直近の状態を把握できるように
 * するための機能。**
 *
 * push-data-shards.js と同じ「orphanコミットでブランチを毎回まるごと置換」方式。
 * 頻繁に呼ばれる想定のため、履歴を肥大化させずに常に最新状態だけを保つ。
 *
 * push先は config.github.debugBranch（既定 'debug'）。dataBranch（価格配信用）
 * とは意図的に分離し、互いのpush頻度・内容に影響しないようにしている。
 *
 * 生成されるファイルのうち `debug-summary.md` が最も重要 — DB統計・直近ジョブ要約・
 * 直近WARN/ERROR(集約済み)を1枚にまとめた、AIが最初に読むためのエントリーポイント。
 * それ以外は深掘り用の生データ(latest.log 等)。
 *
 * トークンが未設定の場合は何もせず即座に終了する（cronからの自動呼び出しを
 * エラー扱いにしないため）。
 */

const fs     = require('fs');
const config = require('../config');
const log    = require('../crawler/logger');
const { _resolveToken } = require('./push-data-shards');

const OWNER  = config.github?.owner;
const REPO   = config.github?.repo;
const BRANCH = config.github?.debugBranch ?? 'debug';
const API    = 'https://api.github.com';

const LOG_TAIL_LINES    = 500;
const ERRLOG_TAIL_LINES = 300;
const DIGEST_TAIL_LINES = 200;
const EVENTS_TAIL_LINES = 800;
const PRICE_ISSUES_MAX  = 3000;
const RECENT_ERRORS_MAX = 60;

let _appVersion = null;
try { _appVersion = require('../package.json').version; } catch { /* ignore */ }

// ─── push間引き ───────────────────────────────────────────────────────────────
// 各ジョブ完了ごとに毎回 orphan commit で330KB超のバンドルをフルpushしていたため、
// 短時間に複数ジョブが連続すると(discover→fetch→turboの連鎖等) GitHub API負荷と
// push失敗率(rate limit/タイムアウト)が上がっていた。直近pushからTHROTTLE_MS未満
// なら自動トリガー分はスキップする。ただし以下は間引かない:
//   - job === 'manual'（ダッシュボードの「デバッグ情報Push」ボタンを押した = 明示的要求）
//   - result にエラーが含まれる場合（失敗を握りつぶして見えなくしないため）
// プロセス再起動でリセットされるだけの単純なメモリ内タイマーで十分
// （起動直後のバーストは元々問題にしていた「長時間運用中の連続push」ではない）。
const THROTTLE_MS = 3 * 60 * 1000; // 3分
let _lastPushedAt = 0;

async function pushDebugBundle({ job = null, result = null } = {}) {
  const token = _resolveToken();
  if (!token) return { ok: false, skipped: true, reason: 'no-token' };
  if (!OWNER || !REPO) return { ok: false, skipped: true, reason: 'no-repo-config' };

  const hasError  = !!(result && result.error);
  const isManual  = job === 'manual';
  const elapsed   = Date.now() - _lastPushedAt;
  if (!isManual && !hasError && elapsed < THROTTLE_MS) {
    log.debug('[pushDebugBundle] throttled', { job, elapsedMs: elapsed, throttleMs: THROTTLE_MS });
    return { ok: true, skipped: true, reason: 'throttled', nextAllowedInMs: THROTTLE_MS - elapsed };
  }

  try {
    const files = [];

    const logTail    = _tailFile(log.getLogPath?.(),       LOG_TAIL_LINES);
    const errTail     = _tailFile(log.getErrorLogPath?.(), ERRLOG_TAIL_LINES);
    const digestTail  = _tailFile(log.getDigestLogPath?.(), DIGEST_TAIL_LINES);
    const eventsTail  = _tailFile(log.getEventsLogPath?.(), EVENTS_TAIL_LINES);

    if (logTail    != null) files.push({ path: 'latest.log',          content: logTail });
    if (errTail    != null) files.push({ path: 'latest-error.log',    content: errTail });
    if (digestTail != null) files.push({ path: 'digest-recent.log',   content: digestTail });
    if (eventsTail != null) files.push({ path: 'events-recent.jsonl', content: eventsTail });

    let dbStats = null, priceIssuesCount = null;
    try {
      // circular require回避のため呼び出し時に require する
      // (db.js -> ... -> pushDebugBundle.js という循環経路は無いが、
      //  スクリプト単体実行(push-data-shards.js経由)時にdb初期化を強制しないため)
      const db = require('../crawler/db');
      dbStats = db.getStats();
      const issues = db.getPriceIssues({ limit: PRICE_ISSUES_MAX });
      priceIssuesCount = db.getPriceIssuesCount();
      files.push({ path: 'price-issues.json',      content: JSON.stringify(issues, null, 2) });
      files.push({ path: 'price-issues-count.txt', content: String(priceIssuesCount) });
    } catch (e) {
      log.warn('[pushDebugBundle] db read failed', e.message);
    }

    const recentErrors = log.getRecentErrors?.() ?? [];

    const meta = {
      pushedAt:      new Date().toISOString(),
      job,
      resultSummary: _safeSummarize(result),
      dbStats,
      priceIssuesCount,
      env: {
        appVersion: _appVersion,
        node:       process.version,
        electron:   process.versions?.electron ?? null,
        platform:   process.platform,
        arch:       process.arch,
      },
    };
    files.push({ path: 'meta.json', content: JSON.stringify(meta, null, 2) });

    files.push({
      path: 'debug-summary.md',
      content: _buildSummaryMarkdown({ job, meta, digestTail, recentErrors }),
    });

    files.push({ path: 'README.md', content: _readmeContent() });

    if (!files.length) return { ok: false, skipped: true, reason: 'no-files' };

    await _orphanPush(token, files, `debug: ${job ?? 'manual'} @ ${new Date().toISOString()}`);
    _lastPushedAt = Date.now();
    log.info('[pushDebugBundle] pushed', { job, files: files.length, branch: BRANCH });
    return { ok: true, files: files.length };
  } catch (e) {
    log.error('[pushDebugBundle] failed', e.message);
    return { ok: false, error: e.message };
  }
}

// ─── ヘルパー ─────────────────────────────────────────────────────────────────

function _tailFile(filePath, maxLines) {
  if (!filePath) return null;
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    return text.split('\n').slice(-maxLines).join('\n');
  } catch {
    return null;
  }
}

function _safeSummarize(result) {
  if (result == null) return null;
  try { return JSON.parse(JSON.stringify(result)); } catch { return String(result); }
}

/**
 * Claude(や他のAI)が最初に開くための1枚サマリを組み立てる。
 * 生ログを全部読まなくても「今どういう状態か・直近何が起きたか」を掴めるようにする。
 */
function _buildSummaryMarkdown({ job, meta, digestTail, recentErrors }) {
  const L = [];
  L.push('# デバッグサマリ（自動生成）');
  L.push('');
  L.push(`- 生成日時: ${meta.pushedAt}`);
  L.push(`- トリガージョブ: ${job ?? '(手動 / スクリプト直接実行)'}`);
  if (meta.resultSummary != null) {
    L.push(`- 直近の実行結果: \`${JSON.stringify(meta.resultSummary)}\``);
  }
  L.push(`- 実行環境: v${meta.env.appVersion ?? '?'} / Node ${meta.env.node} / Electron ${meta.env.electron ?? 'N/A'} / ${meta.env.platform}-${meta.env.arch}`);
  L.push('');

  if (meta.dbStats) {
    const s = meta.dbStats;
    L.push('## DB統計');
    L.push(`- 追跡作品数: ${s.totalWorks}`);
    L.push(`- セール中: ${s.onSale}`);
    L.push(`- 確認待ち(due): ${s.dueNow}`);
    L.push(`- 価格記録数: ${s.priceChanges}`);
    L.push(`- サークル数: ${s.totalCircles}（うちセール中: ${s.circlesOnSale}）`);
    if (meta.priceIssuesCount != null) L.push(`- 定価取得エラー件数: ${meta.priceIssuesCount}`);
    L.push('');
  }

  L.push('## 直近のジョブ要約（digest.log 末尾）');
  L.push('```');
  L.push((digestTail && digestTail.trim()) || '(記録なし)');
  L.push('```');
  L.push('');

  L.push(`## 直近のWARN/ERROR（最大${RECENT_ERRORS_MAX}件・同種メッセージは集約済み）`);
  if (!recentErrors.length) {
    L.push('(直近のエラー・警告なし)');
  } else {
    L.push('```');
    for (const e of recentErrors.slice(-RECENT_ERRORS_MAX)) {
      L.push(`${e.ts} [${(e.level ?? '?').toUpperCase()}] ${e.msg}`);
    }
    L.push('```');
  }
  L.push('');

  L.push('## さらに詳しく調べるには');
  L.push('- `latest.log` — 全ログ末尾（時系列で追いたい時）');
  L.push('- `latest-error.log` — WARN/ERRORのみ末尾');
  L.push('- `digest-recent.log` — ジョブ実行ごとの1行要約');
  L.push('- `events-recent.jsonl` — 構造化ログ(JSON Lines)。level/job/msgで機械的にgrep・フィルタ可能');
  L.push('- `price-issues.json` — 定価が信頼できる形で取得できなかった作品一覧');

  return L.join('\n') + '\n';
}

function _readmeContent() {
  return `# デバッグブランチ (自動生成)

このブランチは DLsite Price Tracker が巡回ジョブ完了ごとに自動でpushする、
直近ログ・DB統計・エラー一覧です。**手動編集しないでください**(毎回まるごと上書きされます)。

このブランチが存在する目的は、ユーザーがログファイルの中身をコピペしなくても、
Claude（または他のAIアシスタント／開発者）がリポジトリを \`git fetch origin ${BRANCH}\`
するだけで直近の実行状態を把握できるようにすることです。

## まず読むファイル

**\`debug-summary.md\`** — 直近状態の要約。まずこれを読めば大枠が分かります。

## 詳細ファイル

| ファイル | 内容 |
|---|---|
| \`latest.log\` | 全ログ末尾${LOG_TAIL_LINES}行 |
| \`latest-error.log\` | WARN/ERRORのみ末尾${ERRLOG_TAIL_LINES}行 |
| \`digest-recent.log\` | ジョブ実行ごとの1行要約、末尾${DIGEST_TAIL_LINES}行 |
| \`events-recent.jsonl\` | 構造化ログ(JSON Lines)、末尾${EVENTS_TAIL_LINES}行。level/job/msgで機械的にフィルタ可能 |
| \`price-issues.json\` / \`price-issues-count.txt\` | 定価が信頼できる形で取得できなかった作品一覧・件数 |
| \`meta.json\` | pushトリガー・DB統計・実行環境情報 |

## 更新タイミング

discovery / detail(価格更新) / fullscan / endingsoon / circlegap / newrelease / compScan の
各ジョブが完了するたびに自動push されます（成功・失敗どちらでも記録されます）。

## Claudeが参照する手順の例

\`\`\`bash
git fetch origin ${BRANCH}
git show origin/${BRANCH}:debug-summary.md
\`\`\`
`;
}

async function _orphanPush(token, files, message) {
  const headers = {
    Authorization: `token ${token}`,
    Accept: 'application/vnd.github.v3+json',
    'Content-Type': 'application/json',
  };

  const tree = [];
  for (const f of files) {
    const res = await fetch(`${API}/repos/${OWNER}/${REPO}/git/blobs`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ content: f.content, encoding: 'utf-8' }),
    });
    if (!res.ok) throw new Error(`blob create failed (${f.path}): HTTP ${res.status} ${await res.text()}`);
    const { sha } = await res.json();
    tree.push({ path: f.path, mode: '100644', type: 'blob', sha });
  }

  const treeRes = await fetch(`${API}/repos/${OWNER}/${REPO}/git/trees`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ tree }),
  });
  if (!treeRes.ok) throw new Error(`tree create failed: HTTP ${treeRes.status} ${await treeRes.text()}`);
  const { sha: treeSha } = await treeRes.json();

  const commitRes = await fetch(`${API}/repos/${OWNER}/${REPO}/git/commits`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ message, tree: treeSha, parents: [] }),
  });
  if (!commitRes.ok) throw new Error(`commit create failed: HTTP ${commitRes.status} ${await commitRes.text()}`);
  const { sha: commitSha } = await commitRes.json();

  const refCheck = await fetch(`${API}/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`, { headers });
  if (refCheck.status === 404) {
    const createRes = await fetch(`${API}/repos/${OWNER}/${REPO}/git/refs`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ref: `refs/heads/${BRANCH}`, sha: commitSha }),
    });
    if (!createRes.ok) throw new Error(`ref create failed: HTTP ${createRes.status} ${await createRes.text()}`);
  } else {
    const updateRes = await fetch(`${API}/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ sha: commitSha, force: true }),
    });
    if (!updateRes.ok) throw new Error(`ref update failed: HTTP ${updateRes.status} ${await updateRes.text()}`);
  }
}

module.exports = { pushDebugBundle };
