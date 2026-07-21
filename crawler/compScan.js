'use strict';

/**
 * crawler/compScan.js
 * 総集編マーク機能のオーケストレーション（拡張機能のcrawler_tab.jsフェーズA/Bを移植）。
 *
 * Phase A (runListingScan):
 *   DLsiteジャンル515(総集編)一覧を巡回し、総集編“作品”RJを comp_candidates へ収集する。
 *   現状 maniax のみ対応（bl/girlsの総集編ジャンルIDは未確認のため今後の課題）。
 *
 * Phase B (runDetailScan):
 *   comp_candidates の未処理分について詳細ページを取得し、
 *   1) 作品内容欄からの直接抽出（高信頼度）
 *   2) 失敗時はサークル同定によるスコアリング推定（compAnalyzer.js）
 *   の順で収録作品を判定する。
 *
 * レートは config.compScan（config.fetchとは完全に独立）を使用する。
 * 'all'/'turbo' ジョブが一時的に config.fetch.rateLimit/concurrency を
 * 書き換えても、このモジュールの速度には一切影響しない。
 */

const config       = require('../config');
const db           = require('./db');
const parser       = require('./parser');
const compAnalyzer = require('./compAnalyzer');
const log          = require('./logger');
const { fetchWithRetry, sleep } = require('./queue');
const { pushDebugBundle } = require('../scripts/pushDebugBundle');

const _LISTING_URL = page =>
  `https://www.dlsite.com/maniax/fsr/=/language/jp/sex_category%5B0%5D/male/ana_flg/all/order%5B0%5D/trend/genre%5B0%5D/515/options_and_or/and/per_page/100/page/${page}/show_type/1`;
const _WORK_URL = rj => `https://www.dlsite.com/maniax/work/=/product_id/${rj}.html`;

async function _getText(url) {
  const res = await fetchWithRetry(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}
async function _getJson(url) {
  const res = await fetchWithRetry(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ─── Phase A: 一覧走査 ─────────────────────────────────────────────────────────

async function runListingScan({ onProgress, shouldContinue = () => true } = {}) {
  const RL = config.compScan.listingRateLimit;
  const progress = db.getCompScanProgress();
  if (progress.listing_done) {
    log.info('[compScan] listing already done — resetCompScanProgress()で再走査可能');
    return { added: 0, alreadyDone: true };
  }

  let page = progress.listing_page || 1;
  let totalAdded = 0, consecutiveShort = 0, failCount = 0;

  while (shouldContinue()) {
    let html;
    try {
      html = await _getText(_LISTING_URL(page));
    } catch (e) {
      failCount++;
      log.warn('[compScan] listing fetch failed', { page, error: e.message, failCount });
      if (failCount >= 3) { log.error('[compScan] listing: 取得失敗が続いたため打ち切り'); break; }
      await sleep(RL * 2);
      continue;
    }
    failCount = 0;

    const items = parser.parseWorkList(html);
    if (!items.length) {
      log.info('[compScan] listing end', { page });
      break;
    }

    const added = db.addCompCandidates(items);
    totalAdded += added;
    db.setCompScanProgress({ listing_page: page + 1 });
    onProgress?.({ page, found: items.length, added, totalAdded });
    log.info('[compScan] listing page', { page, parsed: items.length, added, totalAdded });

    if (items.length < 100) {
      consecutiveShort++;
      if (consecutiveShort >= 2) { log.info('[compScan] listing end (confirmed short page)', { page }); break; }
    } else {
      consecutiveShort = 0;
    }

    page++;
    await sleep(RL);
  }

  if (shouldContinue()) db.setCompScanProgress({ listing_done: 1 });
  return { added: totalAdded, lastPage: page };
}

function resetCompScanProgress() {
  db.setCompScanProgress({ listing_page: 1, listing_done: 0 });
}

// ─── Phase B: 詳細解析 ─────────────────────────────────────────────────────────

async function _processOne(rj) {
  let html;
  try {
    html = await _getText(_WORK_URL(rj));
  } catch (e) {
    log.warn('[compScan] detail fetch failed', rj, e.message);
    // バグ修正: 以前はどんな失敗理由でも即座に processed_at を確定させていたため、
    // 一時的なネットワーク不調やDLsite側の瞬断で取得に失敗しただけの総集編候補も
    // 二度と再解析されなくなっていた(comp_candidatesにはprocessed_at IS NULLの
    // 間しかdue扱いにならず、Phase Aも既存rj_codeは再投入しないため復活経路がない)。
    // 404(確定的に削除済み)だけは即座に諦め、それ以外はfail_countで回数管理し、
    // 閾値未満なら processed_at を確定させずdueのまま残して次回スキャンで再試行する。
    if (/^HTTP 404$/.test(e.message)) {
      db.markCompCandidateProcessed(rj, 'gone');
    } else {
      db.recordCompCandidateFetchFail(rj, 'fetch-failed');
    }
    return { rj, ok: false };
  }

  const direct = compAnalyzer.extractDetailRJs(html, rj);
  if (direct.length) {
    db.addCompWorksDirect(rj, direct);
    db.markCompCandidateProcessed(rj, 'done');
    return { rj, ok: true, direct: direct.length, confirmed: 0, pending: 0 };
  }

  try {
    const scored = await compAnalyzer.estimateContents(rj, html, {
      fetchText: _getText,
      fetchJson: _getJson,
      sleep,
    });
    if (scored.length) {
      const { confirmed, pending } = db.addCompCandidateScored(rj, scored, config.compScan.threshold);
      db.markCompCandidateProcessed(rj, 'done');
      return { rj, ok: true, direct: 0, confirmed, pending };
    }
    db.markCompCandidateProcessed(rj, 'no-candidates');
    return { rj, ok: true, direct: 0, confirmed: 0, pending: 0 };
  } catch (e) {
    log.warn('[compScan] estimate failed', rj, e.message);
    // 同上の理由で、推定処理中の失敗(サークル一覧取得の一時的な不調等)も
    // 即座に確定させず、fail_countで回数管理してから諦める。
    db.recordCompCandidateFetchFail(rj, 'error');
    return { rj, ok: false };
  }
}

async function runDetailScan({ limit = 200, onProgress, shouldContinue = () => true } = {}) {
  const RL   = config.compScan.detailRateLimit;
  const CONC = config.compScan.detailConcurrency;

  const due = db.getDueCompCandidates(limit);
  if (!due.length) {
    log.info('[compScan] detail: no due candidates');
    return { processed: 0, direct: 0, confirmed: 0, pending: 0, errors: 0, total: 0 };
  }

  let idx = 0;
  const totals = { processed: 0, direct: 0, confirmed: 0, pending: 0, errors: 0 };

  async function worker() {
    while (shouldContinue()) {
      const i = idx++;
      if (i >= due.length) break;
      const rj = due[i];
      const r = await _processOne(rj);
      totals.processed++;
      if (!r.ok) totals.errors++;
      totals.direct    += r.direct    ?? 0;
      totals.confirmed += r.confirmed ?? 0;
      totals.pending    += r.pending  ?? 0;
      onProgress?.({ processed: totals.processed, total: due.length, ...totals });
      if (idx < due.length) await sleep(RL);
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, Math.min(CONC, due.length)) }, worker));
  log.info('[compScan] detail done', totals);
  return { ...totals, total: due.length };
}

// ─── 完了ごとの自動デバッグpush ─────────────────────────────────────────────────
function _withDebugPush(jobName, fn) {
  return async (...args) => {
    let result, err;
    try {
      result = await fn(...args);
      return result;
    } catch (e) {
      err = e;
      throw e;
    } finally {
      try {
        await pushDebugBundle({ job: jobName, result: err ? { error: err.message } : result });
      } catch (pushErr) {
        log.error('[compScan] pushDebugBundle failed', pushErr.message);
      }
    }
  };
}

module.exports = {
  runListingScan: _withDebugPush('comp_listing', runListingScan),
  runDetailScan:  _withDebugPush('comp_detail',  runDetailScan),
  resetCompScanProgress,
};
