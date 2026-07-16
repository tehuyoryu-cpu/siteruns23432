'use strict';

/**
 * scripts/pushDebugBundle.js
 *
 * 巡回ジョブ(discovery/detail/fullscan/endingsoon/circlegap/newrelease等)が
 * 完了するたびに、直近ログと price_issues（定価が取れなかった作品一覧）を
 * GitHubへpushする。リモートから不具合を確認できるようにするための機能。
 *
 * push-data-shards.js と同じ「orphanコミットでブランチを毎回まるごと置換」方式。
 * 頻繁に呼ばれる想定のため、履歴を肥大化させずに常に最新状態だけを保つ。
 *
 * push先は config.github.debugBranch（既定 'debug'）。dataBranch（価格配信用）
 * とは意図的に分離し、互いのpush頻度・内容に影響しないようにしている。
 *
 * トークンが未設定の場合は何もせず即座に終了する（cronからの自動呼び出しを
 * エラー扱いにしないため）。
 */

const fs     = require('fs');
const path   = require('path');
const config = require('../config');
const log    = require('../crawler/logger');
const { _resolveToken } = require('./push-data-shards');

const OWNER  = config.github?.owner;
const REPO   = config.github?.repo;
const BRANCH = config.github?.debugBranch ?? 'debug';
const API    = 'https://api.github.com';

const LOG_TAIL_LINES    = 500;
const ERRLOG_TAIL_LINES = 300;
const PRICE_ISSUES_MAX  = 3000;

async function pushDebugBundle({ job = null, result = null } = {}) {
  const token = _resolveToken();
  if (!token) return { ok: false, skipped: true, reason: 'no-token' };
  if (!OWNER || !REPO) return { ok: false, skipped: true, reason: 'no-repo-config' };

  try {
    const files = [];

    try {
      const logText = fs.readFileSync(log.getLogPath(), 'utf8');
      files.push({ path: 'latest.log', content: logText.split('\n').slice(-LOG_TAIL_LINES).join('\n') });
    } catch (e) {
      log.warn('[pushDebugBundle] log read failed', e.message);
    }

    try {
      const errPath = log.getErrorLogPath?.();
      if (errPath && fs.existsSync(errPath)) {
        const errText = fs.readFileSync(errPath, 'utf8');
        files.push({ path: 'latest-error.log', content: errText.split('\n').slice(-ERRLOG_TAIL_LINES).join('\n') });
      }
    } catch (e) {
      log.warn('[pushDebugBundle] error-log read failed', e.message);
    }

    try {
      // circular require回避のため呼び出し時に require する
      // (db.js -> ... -> pushDebugBundle.js という循環経路は無いが、
      //  スクリプト単体実行(push-data-shards.js経由)時にdb初期化を強制しないため)
      const db = require('../crawler/db');
      const issues = db.getPriceIssues({ limit: PRICE_ISSUES_MAX });
      files.push({ path: 'price-issues.json', content: JSON.stringify(issues, null, 2) });
      files.push({ path: 'price-issues-count.txt', content: String(db.getPriceIssuesCount()) });
    } catch (e) {
      log.warn('[pushDebugBundle] price-issues read failed', e.message);
    }

    files.push({
      path: 'meta.json',
      content: JSON.stringify({
        pushedAt: new Date().toISOString(),
        job,
        resultSummary: _safeSummarize(result),
      }, null, 2),
    });

    if (!files.length) return { ok: false, skipped: true, reason: 'no-files' };

    await _orphanPush(token, files, `debug: ${job ?? 'manual'} @ ${new Date().toISOString()}`);
    log.info('[pushDebugBundle] pushed', { job, files: files.length, branch: BRANCH });
    return { ok: true, files: files.length };
  } catch (e) {
    log.error('[pushDebugBundle] failed', e.message);
    return { ok: false, error: e.message };
  }
}

function _safeSummarize(result) {
  if (result == null) return null;
  try { return JSON.parse(JSON.stringify(result)); } catch { return String(result); }
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
