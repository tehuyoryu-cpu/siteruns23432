'use strict';

/**
 * crawler/jobs/index.js
 * ジョブ名 → 実装モジュールの対応表。apiServer.js の handleRun() はこれを
 * 見てディスパッチするだけの薄いラッパーになる(#1 apiServer分割 ステップ2)。
 *
 * 各モジュールは `async function run(ctx, { job }) => ({ result, tokens? })`
 * という共通シグネチャを持つ:
 *   - ctx:    apiServer.js が一度だけ構築して全ジョブへ渡す共有コンテキスト
 *             (sseSend/progress/log/config/db/lockManager/各種クローラー関数)
 *   - job:    実際に呼ばれたジョブ名（fullscan/fullscan_sale のように
 *             1ファイルを複数ジョブ名で共有する場合に使う）
 *   - result: _lastResult[job] にそのまま代入される値（無ければ null）
 *   - tokens: { detail, discovery } のうち、このジョブが自前で確保した
 *             ロックの所有者トークン。'all'/'turbo' のように apiServer.js側の
 *             共通preambleを経由せず自分でロックを取る特殊ジョブのみが返す。
 *             呼び出し元(apiServer.js)の共通finallyブロックがこれを使って
 *             最終的な解放を行う。
 */
const discover     = require('./discover');
const fetch_       = require('./fetch');
const saleboost    = require('./saleboost');
const all          = require('./all');
const turbo        = require('./turbo');
const endingsoon   = require('./endingsoon');
const newrelease   = require('./newrelease');
const circlegap    = require('./circlegap');
const compListing  = require('./compListing');
const compDetail   = require('./compDetail');
const pushdata     = require('./pushdata');
const pushdebug    = require('./pushdebug');
const fullscan     = require('./fullscan');

module.exports = {
  discover,
  fetch: fetch_,
  saleboost,
  all,
  turbo,
  endingsoon,
  newrelease,
  circlegap,
  comp_listing: compListing,
  comp_detail:  compDetail,
  pushdata,
  pushdebug,
  fullscan,
  fullscan_sale: fullscan, // 同じ実装をsaleフラグで分岐(job名で判定)
};
