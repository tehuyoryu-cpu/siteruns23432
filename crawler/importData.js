'use strict';

/**
 * crawler/importData.js
 *
 * DB破損・消失時の復旧用: /api/export/csv or /api/export/json で過去に
 * 書き出したファイルから works + price_history を再構築する。
 *
 * 制約（重要）:
 *   - CSVエクスポートには maker_id / work_type / release_date / site_id が
 *     含まれない（apiServer.js の handleExportCsv 参照）。そのためCSV
 *     インポートではこれらが全て空/既定値('maniax')になる。
 *     JSONエクスポートには maker_id/work_type/release_date が含まれるため、
 *     可能な限りJSONを使うこと。
 *   - site_id はCSV/JSONどちらにも含まれないため 'maniax' 固定で復元する。
 *     bl/girlsサイトの作品は次回の価格更新パスで初めて正しく修正される
 *     （product/info/ajax が404/空応答を返す→recordApiMissingで検出される
 *     想定だが、確実ではないため復元直後は要目視確認）。
 *   - is_on_sale はCSV/JSONに直接の列が無いため、
 *     (discount_rate > 0 または sale_price が非null) から近似復元する。
 *
 * インポート直後、各作品は次回の「価格更新」パスで即座に再チェックされる
 * よう next_check_at を「今」に強制する(boostWorkUrgent)。これにより
 * site_id/maker_id/現存確認など、ファイルだけでは分からない情報が
 * できるだけ早く補正される。
 */

const fs     = require('fs');
const db     = require('./db');
const config = require('../config');
const log    = require('./logger');

const CHUNK = 200; // works単位でのトランザクション分割サイズ

// ─── CSV パーサ（ダブルクオート・カンマ・改行エスケープ対応の最小実装） ──────

function _parseCsv(text) {
  const rows = [];
  let i = 0, field = '', row = [], inQuotes = false;
  const pushField = () => { row.push(field); field = ''; };
  const pushRow   = () => { pushField(); rows.push(row); row = []; };
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"')  { inQuotes = true; i++; continue; }
    if (c === ',')  { pushField(); i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { pushRow(); i++; continue; }
    field += c; i++;
  }
  if (field.length || row.length) pushRow();
  return rows;
}

// ─── 公開関数 ─────────────────────────────────────────────────────────────────

function importFromCsv(filePath, { onProgress } = {}) {
  const text = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  const rows = _parseCsv(text).filter(r => r.length > 1 || (r.length === 1 && r[0] !== ''));
  if (!rows.length) throw new Error('CSVが空です');

  const header = rows.shift().map(h => h.trim());
  const idx    = Object.fromEntries(header.map((h, i) => [h, i]));
  for (const col of ['rj_code', 'price', 'sale_price', 'discount_rate', 'point', 'checked_at']) {
    if (!(col in idx)) throw new Error(`CSVヘッダーに列 "${col}" が見つかりません（想定形式と異なります）`);
  }

  const records = rows.map(r => ({
    rj_code:       r[idx.rj_code],
    title:         idx.title  != null ? (r[idx.title]  || null) : null,
    circle:        idx.circle != null ? (r[idx.circle] || null) : null,
    maker_id:      null,   // CSVには含まれない
    work_type:     null,
    release_date:  null,
    price:         _toInt(r[idx.price]),
    sale_price:    _toInt(r[idx.sale_price]),
    discount_rate: _toInt(r[idx.discount_rate]),
    point:         _toInt(r[idx.point]),
    checked_at:    r[idx.checked_at] ? Math.floor(new Date(r[idx.checked_at]).getTime() / 1000) : null,
  }));

  log.warn('[import] CSVインポート: maker_id/work_type/release_date/site_idは復元されません（JSONエクスポートを推奨）');
  return _importRecords(records, onProgress);
}

function importFromJson(filePath, { onProgress } = {}) {
  const raw  = fs.readFileSync(filePath, 'utf8');
  const data = JSON.parse(raw);
  if (!Array.isArray(data)) {
    throw new Error('JSONの形式が不正です（/api/export/json が出力する配列形式である必要があります）');
  }

  const records = data.map(r => ({
    rj_code:       r.rj_code,
    title:         r.title  ?? null,
    circle:        r.circle ?? null,
    maker_id:      r.maker_id  ?? null,
    work_type:     r.work_type ?? null,
    release_date:  r.release_date ?? null,
    price:         _numOrNull(r.price),
    sale_price:    _numOrNull(r.sale_price),
    discount_rate: _numOrNull(r.discount_rate),
    point:         _numOrNull(r.point),
    checked_at:    typeof r.checked_at === 'number'
      ? r.checked_at
      : (r.checked_at ? Math.floor(new Date(r.checked_at).getTime() / 1000) : null),
  }));

  return _importRecords(records, onProgress);
}

/** ファイル拡張子から自動判定してインポートする */
function importAuto(filePath, opts = {}) {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.json')) return importFromJson(filePath, opts);
  if (lower.endsWith('.csv'))  return importFromCsv(filePath, opts);
  throw new Error('拡張子から形式を判定できません（.json または .csv を指定してください）');
}

// ─── 内部処理 ─────────────────────────────────────────────────────────────────

function _toInt(v) {
  if (v == null || v === '') return null;
  const n = parseInt(String(v).replace(/[^0-9-]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

function _numOrNull(v) {
  return typeof v === 'number' ? v : (v == null ? null : _toInt(v));
}

function _importRecords(records, onProgress) {
  const byRj = new Map();
  let skippedNoRj = 0, skippedNoChecked = 0;

  for (const r of records) {
    if (!r.rj_code) { skippedNoRj++; continue; }
    const rj = String(r.rj_code).toUpperCase().trim();
    if (!/^RJ\d{4,}$/.test(rj)) { skippedNoRj++; continue; }
    if (!byRj.has(rj)) byRj.set(rj, []);
    byRj.get(rj).push(r);
  }
  for (const list of byRj.values()) {
    list.sort((a, b) => (a.checked_at ?? 0) - (b.checked_at ?? 0));
  }

  const rjCodes = [...byRj.keys()];
  let worksImported = 0, priceRowsImported = 0, processed = 0;

  for (let i = 0; i < rjCodes.length; i += CHUNK) {
    const chunk = rjCodes.slice(i, i + CHUNK);

    db.transaction(() => {
      for (const rj of chunk) {
        const list   = byRj.get(rj);
        // タイトル/サークル等はnullでない最新の値を採用（欠損レコード混入対策）
        const latest = [...list].reverse().find(r => r.title) ?? list[list.length - 1];

        db.upsertWork({
          rj_code:      rj,
          title:        latest.title,
          circle:       latest.circle,
          maker_id:     latest.maker_id,
          work_type:    latest.work_type,
          site_id:      'maniax',
          release_date: latest.release_date,
          dl_count:     0,
        });
        worksImported++;

        let lastOnSale = 0;
        for (const row of list) {
          if (row.checked_at == null) { skippedNoChecked++; continue; }
          const isOnSale = ((row.discount_rate ?? 0) > 0 || row.sale_price != null) ? 1 : 0;
          const result = db.savePriceIfChanged(rj, {
            price:         row.price,
            sale_price:    row.sale_price,
            point:         row.point,
            discount_rate: row.discount_rate,
            is_on_sale:    isOnSale,
            is_point_only: 0,
          });
          if (result?.changed) priceRowsImported++;
          lastOnSale = isOnSale;
        }

        db.markChecked(rj, {
          check_interval: config.checkInterval.normal,
          priority:       lastOnSale ? config.priority.onSale : config.priority.normal,
          is_on_sale:     lastOnSale,
        });
        // ファイルだけでは分からない情報(site_id/maker_id欠損/現存確認)を
        // できるだけ早く補正させるため、次回価格更新パスで即due扱いにする
        db.boostWorkUrgent(rj, lastOnSale ? config.priority.onSale : config.priority.normal, config.checkInterval.normal);
      }
    });

    processed += chunk.length;
    log.info('[import] progress', { processed, total: rjCodes.length, worksImported, priceRowsImported });
    onProgress?.({ processed, total: rjCodes.length, worksImported, priceRowsImported });
  }

  db.save();

  const result = {
    totalRjCodes: rjCodes.length,
    works:        worksImported,
    priceRows:    priceRowsImported,
    skippedNoRj,
    skippedNoChecked,
  };
  log.info('[import] done', result);
  return result;
}

module.exports = { importFromCsv, importFromJson, importAuto };
