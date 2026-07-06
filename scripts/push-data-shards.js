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

async function main() {
  const token = _resolveToken();
  if (!token) {
    log.info('[push-data-shards] no GitHub token configured, skipping push');
    return;
  }
  if (!fs.existsSync(OUT_DIR)) {
    log.warn('[push-data-shards] output dir not found, run exportShards first', OUT_DIR);
    return;
  }
  if (!OWNER || !REPO) {
    log.error('[push-data-shards] config.github.owner/repo not set');
    return;
  }

  const files = _collectFiles(OUT_DIR);
  files.push({ path: 'README.md', content: README_CONTENT });
  if (!files.length) {
    log.warn('[push-data-shards] no files to push');
    return;
  }

  log.info('[push-data-shards] start', { branch: BRANCH, files: files.length });

  const headers = {
    Authorization: `token ${token}`,
    Accept: 'application/vnd.github.v3+json',
    'Content-Type': 'application/json',
  };

  // 1. 各ファイルをblobとして作成
  const tree = [];
  for (const f of files) {
    const content = f.content ?? fs.readFileSync(f.abs, 'utf8');
    const res = await fetch(`${API}/repos/${OWNER}/${REPO}/git/blobs`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ content, encoding: 'utf-8' }),
    });
    if (!res.ok) throw new Error(`blob create failed (${f.path}): HTTP ${res.status} ${await res.text()}`);
    const { sha } = await res.json();
    tree.push({ path: f.path, mode: '100644', type: 'blob', sha });
  }

  // 2. treeを作成 (base_treeを指定しない = 完全に新しいツリーでブランチを置き換える)
  const treeRes = await fetch(`${API}/repos/${OWNER}/${REPO}/git/trees`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ tree }),
  });
  if (!treeRes.ok) throw new Error(`tree create failed: HTTP ${treeRes.status} ${await treeRes.text()}`);
  const { sha: treeSha } = await treeRes.json();

  // 3. 親を持たないコミットを作成(スカッシュ運用のため毎回orphanにする)
  const commitRes = await fetch(`${API}/repos/${OWNER}/${REPO}/git/commits`, {
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

  // 4. ref更新(既存ならforce update、無ければ新規作成)
  const refCheck = await fetch(`${API}/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`, { headers });
  if (refCheck.status === 404) {
    const createRes = await fetch(`${API}/repos/${OWNER}/${REPO}/git/refs`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ref: `refs/heads/${BRANCH}`, sha: commitSha }),
    });
    if (!createRes.ok) throw new Error(`ref create failed: HTTP ${createRes.status} ${await createRes.text()}`);
    log.info('[push-data-shards] branch created', BRANCH);
  } else {
    const updateRes = await fetch(`${API}/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ sha: commitSha, force: true }),
    });
    if (!updateRes.ok) throw new Error(`ref update failed: HTTP ${updateRes.status} ${await updateRes.text()}`);
  }

  log.info('[push-data-shards] done', { files: files.length, commit: commitSha });
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
  main().catch(err => {
    log.error('[push-data-shards] fatal', err.message);
    process.exitCode = 1;
  });
}

module.exports = { main };
