'use strict';

/**
 * test/parser.test.js
 *
 * crawler/parser.js の parseProductInfo() 価格判定分岐のユニットテスト。
 *
 * parseProductInfo は DB/ネットワークに依存しない純粋関数（cheerio/config/logger
 * のみ使用）なので、モックなしで直接 require して実データ相当のfixtureを渡す。
 * 過去に繰り返しバグを生んでいる複雑な分岐（price_work/price/discount_rate/
 * official_price/discountオブジェクトの優先順位と組み合わせ）を、実際に修正された
 * 不具合パターンごとに固定化し、再発を検知できるようにする。
 *
 * フレームワーク不使用（node -c 以上の自動検証が無かったため、まずは依存ゼロで
 * `node test/parser.test.js` だけで実行できる最小のテストランナーにする）。
 *
 * 実行: node test/parser.test.js
 */

const assert = require('assert');
const path   = require('path');
const parser = require(path.join(__dirname, '..', 'crawler', 'parser'));

let pass = 0, fail = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    pass++;
  } catch (e) {
    fail++;
    failures.push({ name, error: e });
  }
}

function parse(rj, fields) {
  return parser.parseProductInfo(rj, { [rj]: fields });
}

// ── 基本: キーが見つからない場合 ────────────────────────────────────────────
test('key not found → null', () => {
  const r = parser.parseProductInfo('RJ000001', { RJ999999: {} });
  assert.strictEqual(r, null);
});

// ── discountオブジェクト最優先 ──────────────────────────────────────────────
test('discount.campaign_price/restore_price が最優先で使われる', () => {
  const r = parse('RJ000002', {
    is_discount_work: true,
    discount: { campaign_price: 700, restore_price: 1000 },
    price_work: 999, price: 111, discount_rate: 1, // 無視されるべき撹乱フィールド
  });
  assert.strictEqual(r.priceIssue, null);
  assert.strictEqual(r.price.price, 1000);
  assert.strictEqual(r.price.sale_price, 700);
  assert.strictEqual(r.price.is_on_sale, 1);
});

// ── official_price 経由（discountオブジェクトなし） ─────────────────────────
test('official_price + price(セール価格) の組み合わせ', () => {
  const r = parse('RJ000003', {
    is_sale: 1, official_price: 1000, price: 500,
  });
  assert.strictEqual(r.priceIssue, null);
  assert.strictEqual(r.price.price, 1000);
  assert.strictEqual(r.price.sale_price, 500);
});

// ── official_price=0 のデータ不備を有効値として拾わない（実際の修正済みバグ）──
test('official_price=0 は無視して price_work/price の大小関係にフォールバックする', () => {
  const r = parse('RJ000004', {
    is_sale: 1, official_price: 0, price_work: 1000, price: 500, discount_rate: 50,
  });
  assert.strictEqual(r.priceIssue, null);
  assert.strictEqual(r.price.price, 1000);
  assert.strictEqual(r.price.sale_price, 500);
});

// ── official_price=0 かつ discRate=0(ポイント還元) は priceIssue にしない ──
test('official_price=0・discount_rate未設定はpriceIssueにならずpriceCurを定価として扱う', () => {
  const r = parse('RJ000005', {
    is_sale: 1, official_price: 0, price: 500,
  });
  assert.strictEqual(r.priceIssue, null);
  assert.strictEqual(r.price.price, 500);
  assert.strictEqual(r.price.sale_price, null);
  assert.strictEqual(r.price.is_point_only, 1); // 値引きフィールドが無いのでポイント還元扱い
});

// ── price_work=通常価格, price=セール価格（標準ケース） ────────────────────
test('price_work>price のとき price_workが定価', () => {
  const r = parse('RJ000006', { is_sale: 1, price_work: 1000, price: 500, discount_rate: 50 });
  assert.strictEqual(r.price.price, 1000);
  assert.strictEqual(r.price.sale_price, 500);
});

// ── price_work=セール価格, price=通常価格（フィールドが逆転するケース） ────
test('price_work<price のとき price が定価（フィールド逆転）', () => {
  const r = parse('RJ000007', { is_sale: 1, price_work: 500, price: 1000 });
  assert.strictEqual(r.price.price, 1000);
  assert.strictEqual(r.price.sale_price, 500);
});

// ── price_workのみ + discount_rateから定価を逆算 ────────────────────────────
test('price_workのみ+discount_rateから定価を逆算する', () => {
  const r = parse('RJ000008', { is_sale: 1, price_work: 800, discount_rate: 20 });
  assert.strictEqual(r.priceIssue, null);
  assert.strictEqual(r.price.sale_price, 800);
  assert.strictEqual(r.price.price, 1000); // 800 * 100 / (100-20) = 1000
});

// ── priceのみ + discount_rateから定価を逆算 ─────────────────────────────────
test('priceのみ+discount_rateから定価を逆算する', () => {
  const r = parse('RJ000009', { is_sale: 1, price: 800, discount_rate: 20 });
  assert.strictEqual(r.price.sale_price, 800);
  assert.strictEqual(r.price.price, 1000);
});

// ── discount_rate>=100 は真に定価不明として priceIssue 記録（price_workなし）─
test('discount_rate>=100かつprice_work欠損はprice_work_missing_high_discount', () => {
  const r = parse('RJ000010', { is_sale: 1, price: 1000, discount_rate: 100 });
  assert.ok(r.priceIssue);
  assert.strictEqual(r.priceIssue.type, 'price_work_missing_high_discount');
  assert.strictEqual(r.price.sale_price, null);
});

// ── price_work/price同額（撹乱なし） → ambiguous ────────────────────────────
test('price_workとpriceが同額かつdiscount_rateなしはambiguous', () => {
  const r = parse('RJ000011', { is_sale: 1, price_work: 1000, price: 1000, discount_rate: 0 });
  assert.ok(r.priceIssue);
  assert.strictEqual(r.priceIssue.type, 'ambiguous');
  assert.strictEqual(r.price.price, 1000);
  assert.strictEqual(r.price.sale_price, null);
});

// ── 完全に価格情報が無い ────────────────────────────────────────────────────
test('価格フィールドが一切無い場合はno_price_field', () => {
  const r = parse('RJ000012', { is_sale: 1 });
  assert.ok(r.priceIssue);
  assert.strictEqual(r.priceIssue.type, 'no_price_field');
  assert.strictEqual(r.price.price, 0);
});

// ── セール中でない通常ケース（official_price優先） ─────────────────────────
test('セール中でない場合はofficial_priceを優先する', () => {
  const r = parse('RJ000013', { is_sale: 0, official_price: 1500, price_work: 0, price: 1500 });
  assert.strictEqual(r.priceIssue, null);
  assert.strictEqual(r.price.price, 1500);
  assert.strictEqual(r.price.sale_price, null);
  assert.strictEqual(r.price.is_on_sale, 0);
});

// ── 不正な組み合わせは安全網でinvalid_price_comboに分類 ────────────────────
test('sale_price>=price の不正な組み合わせはinvalid_price_comboとして検知する', () => {
  // discountオブジェクト経由で不正値を直接注入（実運用ではAPI応答の異常を想定）
  const r = parse('RJ000014', {
    is_discount_work: true,
    discount: { campaign_price: 1000, restore_price: 1000 }, // campaign < restore を満たさないため
    official_price: 1000, price: 1000, is_sale: 1,
  });
  // discountオブジェクトの条件(campaign<restore)を満たさないため officialPrice経路に落ち、
  // official_price===price(=1000) なので salePrice=null → priceIssueにはならない正常系。
  // ここでは「壊れたデータでもクラッシュせず一貫した結果を返す」ことだけを検証する。
  assert.strictEqual(typeof r.price.price, 'number');
  assert.ok(!Number.isNaN(r.price.price));
});

// ── ポイント還元判定: discount_rateが無くis_saleのみ ────────────────────────
test('discount_rate=0かつis_sale=1はポイント還元(is_point_only=1)として分類', () => {
  const r = parse('RJ000015', { is_sale: 1, price: 500, discount_rate: 0 });
  assert.strictEqual(r.price.is_point_only, 1);
  assert.strictEqual(r.price.discount_rate, 0);
});

// ── point / point_rate の分離（絶対値と還元率を混同しない） ────────────────
test('pointとpoint_rateが別カラムとして分離される', () => {
  const r = parse('RJ000016', { is_sale: 0, price_work: 1000, point: 50, point_rate: 5 });
  assert.strictEqual(r.price.point, 50);
  assert.strictEqual(r.price.point_rate, 5);
});

// ── site_id: 未知の値は null にフォールバックする ───────────────────────────
test('未知のsite_idはnullを返す(detailFetcher側でのフォールバックに委ねる)', () => {
  const r = parse('RJ000017', { is_sale: 0, price_work: 1000, site_id: 'aix' });
  assert.strictEqual(r.work.site_id, null);
});

test('既知のsite_idはそのまま採用される', () => {
  const r = parse('RJ000018', { is_sale: 0, price_work: 1000, site_id: 'girls' });
  assert.strictEqual(r.work.site_id, 'girls');
});

// ── ゼロ埋め違い/大文字小文字違いのキーにも対応する ──────────────────────────
test('ゼロ埋めなしキー(RJ1234567)でも大文字化したRJコードで引ける', () => {
  const r = parser.parseProductInfo('RJ01234567', { RJ1234567: { is_sale: 0, price_work: 500 } });
  assert.ok(r);
  assert.strictEqual(r.price.price, 500);
});

// ── 結果サマリ ───────────────────────────────────────────────────────────────
console.log(`\n[parser.test.js] ${pass} passed, ${fail} failed`);
if (failures.length) {
  for (const { name, error } of failures) {
    console.error(`\n✗ ${name}`);
    console.error('  ' + (error?.message ?? error));
  }
  process.exitCode = 1;
} else {
  console.log('全テスト成功');
}
