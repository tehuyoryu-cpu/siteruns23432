'use strict';

/**
 * scripts/push-data-shards.js
 *
 * crawler/exportShards.js が生成したローカルの data-export/ ディレクトリを
 * GitHub の専用ブランチ(config.github.dataBranch, 既定 "data")へ丸ごと反映する。
 *
 * 方針:
 *   - コード用の main ブランチとは完全に分離する(データは頻繁に総入れ替えされるため)
 *   - 毎回 "親コミットなし" の orphan commit を作り、force-ref updateでブランチ全体を
 *     置き換える(スカッシュ)。これによりデータブランチの履歴が肥大化しない。
 *   - 生成物は全ファイルをそのまま反映する(差分アップロードの最適化はせず、
 *     1日1回程度の実行頻度であればシンプルさを優先する)。
 *
 * トークン解決順序:
 *   1. 環境変数 GH_TOKEN
 *   2. DLSITE_DATA_DIR (またはcwd) 直下の .github-token ファイル(1行目がトークン)
 *   トークンが見つからない場合は何もせず正常終了する(cronからの自動実行を
 *   エラー扱いにしないため。手動pushしたい場合はこのスクリプトを直接叩く)。
 *
 * 使い方:
 *   node scripts/push-data-shards.js
 *   GH_TOKEN=ghp_xxx node scripts/push-data-shards.js
 */

const fs     = require('fs');
const path   = require('path');
const config = require('../config');
const log    = require('../crawler/logger');

const OWNER  = config.github?.owner;
const REPO   = config.github?.repo;
const BRANCH = config.github?.dataBranch ?? 'data';
const OUT_DIR = path.resolve(
  process.env.DLSITE_DATA_DIR || process.cwd(),
  config.shards?.dataDir ?? './data-export'
);

const API = 'https://api.github.com';

// バグ修正（Push Now が不安定な根本原因）:
// 1回の POST /git/trees に全ファイル(shards 最大1024 + index 最大64 + manifest
// + README ≈ 1090件)のcontentをまとめて埋め込んでいたため、DBが大きくなると
// 単一リクエストのペイロードが数十MBに達し、GitHub側のタイムアウト/5xxや、
// 手元の回線状況によっては素直に失敗しやすい状態だった。さらに全fetch呼び出しに
// タイムアウト・リトライが一切無く、通信が詰まると「実行中...」表示のまま
// 何分でも応答を待ち続けてしまう(ユーザーからは「固まった/不安定」に見える)。
// 対策:
//   ① ファイルをCHUNK_SIZE件ずつに分割し、base_tree を前チャンクのtree shaに
//      指定して積み上げていく(GitHub Trees APIの仕様上、base_treeに無い
//      パスは維持されるため、複数回に分けても最終的に全ファイルを含む
//      1本のtreeになる)。1リクエストのペイロードを大幅に縮小する。
//   ② 全fetch呼び出しにタイムアウト(30秒)とリトライ(最大3回・指数バックオフ、
//      429/5xx/タイムアウトが対象)を追加する。
const CHUNK_SIZE          = 150;   // 1回のtree作成リクエストに含める最大ファイル数
const REQUEST_TIMEOUT_MS  = 30_000;
const MAX_RETRY            = 3;
const RETRY_BASE_DELAY_MS = 1500;

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function _fetchWithRetry(url, opts = {}) {
  let lastErr;
  for (let i = 0; i <= MAX_RETRY; i++) {
    if (i > 0) {
      const wait = RETRY_BASE_DELAY_MS * 2 ** (i - 1);
      log.warn(`[push-data-shards] retry ${i}/${MAX_RETRY} (${wait}ms後)`, url, String(lastErr?.message ?? lastErr));
      await _sleep(wait);
    }
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, { ...opts, signal: ctrl.signal });
      clearTimeout(timer);
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status}`);
        continue;   // リトライ対象。ok/4xx(429以外)はそのまま返して呼び出し側で判定させる
      }
      return res;
    } catch (e) {
      clearTimeout(timer);
      lastErr = e.name === 'AbortError' ? new Error(`timeout after ${REQUEST_TIMEOUT_MS}ms`) : e;
    }
  }
  throw lastErr ?? new Error(`fetchWithRetry failed: ${url}`);
}

const README_CONTENT = `# DLsite Score — 配信データ (自動生成)

このブランチは DLsite Score ブラウザ拡張機能向けの価格スコアデータを配信するための
専用ブランチです。**手動編集しないでください**(毎回まるごと上書きされます)。

## 構成

- \`manifest.json\` — 生成日時・シャード数・スキーマ説明
- \`shards/NNNN.json\` — サークル単位でハッシュ分散したワークデータ本体
- \`index/NN.json\` — RJコード → shard番号 の対応表

## 取得方法

jsDelivr CDN 経由を推奨:
\`\`\`
https://cdn.jsdelivr.net/gh/${OWNER}/${REPO}@${BRANCH}/index/{idxShard}.json
https://cdn.jsdelivr.net/gh/${OWNER}/${REPO}@${BRANCH}/shards/{shard}.json
\`\`\`

shard番号の算出方法(FNV-1a 32bit)は \`crawler/exportShards.js\` の \`fnv1a()\` を参照。
`;

/**
 * @returns {Promise<{
 *   ok: boolean,
 *   skipped?: boolean,
 *   reason?: string,
 *   message?: string,
 *   files?: number,
 *   commit?: string,
 *   branch?: string,
 * }>}
 *   ok:true         — push成功（files/commit/branchが入る）
 *   ok:false,skipped — 意図的なスキップ（トークン未設定・出力なし等）。エラーではない。
 *   ok:false         — 実際の失敗はここには来ず throw する（呼び出し側の catch に委ねる）
 */
async function main({ onProgress } = {}) {
  const token = _resolveToken();
  if (!token) {
    // バグ修正: 従来はlog.info()で、通常ログファイルにしか残らず
    // dlsite-error.log にもダッシュボードのライブログにも一切出ていなかった。
    // 実際にこれが原因で「dataブランチへの日次自動push」が初回の手動テスト
    // (npm run export-shards:push)以来ずっとサイレントにスキップされ続け、
    // 何日経ってもdataブランチが更新されないという不具合を静かに引き起こして
    // いた(exportShards自体は正常完了するため、エラーとしては一切見えない)。
    // 意図した自動化が実質的に無効化されているのは重大な問題のため、
    // 明示的に警告として残す。
    const message = 'GitHubトークン未設定のためpushをスキップしました。' +
      'ダッシュボードの「⚙️ 設定」からトークンを保存すると次回から自動pushされます。';
    log.warn('[push-data-shards] ' + message);
    return { ok: false, skipped: true, reason: 'no-token', message };
  }
  if (!fs.existsSync(OUT_DIR)) {
    const message = 'エクスポート出力(data-export/)が見つかりません。先にエクスポートを実行してください';
    log.warn('[push-data-shards] output dir not found, run exportShards first', OUT_DIR);
    return { ok: false, skipped: true, reason: 'no-output', message };
  }
  if (!OWNER || !REPO) {
    const message = 'config.github.owner/repo が未設定です';
    log.error('[push-data-shards] config.github.owner/repo not set');
    return { ok: false, skipped: true, reason: 'no-config', message };
  }

  const files = _collectFiles(OUT_DIR);
  files.push({ path: 'README.md', content: README_CONTENT });
  if (!files.length) {
    const message = '書き出すファイルがありません';
    log.warn('[push-data-shards] no files to push');
    return { ok: false, skipped: true, reason: 'no-files', message };
  }

  log.info('[push-data-shards] start', { branch: BRANCH, files: files.length });

  const headers = {
    Authorization: `token ${token}`,
    Accept: 'application/vnd.github.v3+json',
    'Content-Type': 'application/json',
  };

  // 1. ファイルをCHUNK_SIZE件ずつに分割し、tree項目としてcontentを直接埋め込む
  //    (blob作成のラウンドトリップを避けつつ、1リクエストの肥大化も防ぐ)
  log.info('[push-data-shards] tree構築開始', { chunks: Math.ceil(files.length / CHUNK_SIZE), chunkSize: CHUNK_SIZE });
  let treeSha = null;
  for (let i = 0; i < files.length; i += CHUNK_SIZE) {
    const chunk = files.slice(i, i + CHUNK_SIZE);
    const treeItems = chunk.map(f => ({
      path:    f.path,
      mode:    '100644',
      type:    'blob',
      content: f.content ?? fs.readFileSync(f.abs, 'utf8'),
    }));
    // base_treeを前チャンクのsha結果に指定して積み上げる。
    // (base_treeに含まれるがこのチャンクで言及していないパスはそのまま維持される)
    const body = treeSha ? { base_tree: treeSha, tree: treeItems } : { tree: treeItems };
    const treeRes = await _fetchWithRetry(`${API}/repos/${OWNER}/${REPO}/git/trees`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!treeRes.ok) {
      throw new Error(`tree create failed (chunk ${i}〜${i + chunk.length - 1}件目): HTTP ${treeRes.status} ${await treeRes.text()}`);
    }
    ({ sha: treeSha } = await treeRes.json());
    log.info('[push-data-shards] tree chunk done', { from: i, count: chunk.length, treeSha });
    onProgress?.({ done: Math.min(i + chunk.length, files.length), total: files.length });
  }

  // 2. 親を持たないコミットを作成(スカッシュ運用のため毎回orphanにする)
  const commitRes = await _fetchWithRetry(`${API}/repos/${OWNER}/${REPO}/git/commits`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      message: `data: export ${new Date().toISOString()} (${files.length} files)`,
      tree: treeSha,
      parents: [],
    }),
  });
  if (!commitRes.ok) throw new Error(`commit create failed: HTTP ${commitRes.status} ${await commitRes.text()}`);
  const { sha: commitSha } = await commitRes.json();

  // 3. ref更新(既存ならforce update、無ければ新規作成)
  const refCheck = await _fetchWithRetry(`${API}/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`, { headers });
  if (refCheck.status === 404) {
    const createRes = await _fetchWithRetry(`${API}/repos/${OWNER}/${REPO}/git/refs`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ref: `refs/heads/${BRANCH}`, sha: commitSha }),
    });
    if (!createRes.ok) throw new Error(`ref create failed: HTTP ${createRes.status} ${await createRes.text()}`);
    log.info('[push-data-shards] branch created', BRANCH);
  } else {
    const updateRes = await _fetchWithRetry(`${API}/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ sha: commitSha, force: true }),
    });
    if (!updateRes.ok) throw new Error(`ref update failed: HTTP ${updateRes.status} ${await updateRes.text()}`);
  }

  log.info('[push-data-shards] done', { files: files.length, commit: commitSha });
  return { ok: true, files: files.length, commit: commitSha, branch: BRANCH };
}

function _resolveToken() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN.trim();
  const tokenPath = path.resolve(process.env.DLSITE_DATA_DIR || process.cwd(), '.github-token');
  try {
    return fs.readFileSync(tokenPath, 'utf8').trim().split('\n')[0] || null;
  } catch {
    return null;
  }
}

/** dir配下の*.jsonを再帰的に集め、{path (posix相対パス), abs} の配列を返す */
function _collectFiles(dir, base = dir, acc = []) {
  for (const name of fs.readdirSync(dir)) {
    const abs = path.join(dir, name);
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) {
      _collectFiles(abs, base, acc);
    } else if (name.endsWith('.json')) {
      const rel = path.relative(base, abs).split(path.sep).join('/');
      acc.push({ path: rel, abs });
    }
  }
  return acc;
}

if (require.main === module) {
  main()
    .then(result => {
      if (!result?.ok) process.exitCode = result?.skipped ? 0 : 1;
    })
    .catch(err => {
      log.error('[push-data-shards] fatal', err.message);
      process.exitCode = 1;
    });
}

module.exports = { main, _resolveToken };
