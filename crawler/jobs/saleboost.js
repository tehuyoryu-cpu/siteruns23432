'use strict';

/**
 * crawler/jobs/saleboost.js
 * セール優先（セール中サークルの優先度を維持）。
 */
module.exports = async function runSaleboostJob(ctx) {
  const { db, log } = ctx;

  const circles = db.getCirclesOnSale();
  // バグ修正: 以前はサークル毎に1文ずつUPDATEを発行し、それら数万件を
  // 1本の巨大なdb.transaction()で包んでいたため、WAL単一ライターロックを
  // 数秒〜数十秒も占有し続け、並行する価格更新の書き込みを止めていた
  // ([db] slow transaction の主因)。json_each()による一括UPDATEに変更。
  db.boostCirclesBulk(circles.map(c => c.maker_id), 100, 7200);
  db.syncCircleWorksCounts();
  log.info('[api] saleboost done, circles:', circles.length);

  return { result: null };
};
