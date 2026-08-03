'use strict';

module.exports = {
  db: {
    path: './dlsite.db',
  },

  server: {
    host: '127.0.0.1',
  },

  fetch: {
    timeout:      20000,
    retryMax:     3,
    retryBaseDelay: 1500,
    concurrency:  3,
    rateLimit:    700,    // DLsite安定動作確認済み
    batchSize:    50,
    // 'turbo'/'all'ジョブ用のブースト値。
    // 調整: 以前は concurrency:6/rateLimit:200ms(baseの約3.5倍の負荷)で固定していたが、
    // 2026-07-23 05:03台のログで「API returned partial data」（要求件数の半分未満しか
    // 返らない部分応答）が短時間に連発しているのを確認した。turboはdetail(価格更新)に加え
    // newrelease/endingsoon(discovery系)も同時並列実行するため、実際の同時アクセス数は
    // これよりさらに多い。DLsite側が明示的な429を返さず黙って部分応答/劣化するケースが
    // あるとみられるため、負荷をbase設定寄りに緩和して部分応答の発生頻度を下げる。
    //
    // 再調整(2026-07-28, digest.log実データに基づく): concurrency:4/rateLimit:350ms
    // でも通常のfetch(cron, concurrency:3/rateLimit:700ms)がほぼエラー0件なのに対し、
    // turbo/allは同じ実行内でerrors数千〜3万件台まで積み上がる回が頻発していた
    // (例: 'all' errors:30011件、'turbo' errors:7555件)。これはDLsite側がランダムに
    // 劣化しているのではなく、turbo自体の並列負荷(detail + newrelease/endingsoon の
    // 同時実行によるサイト単位の実効同時接続数増加)がセッション劣化/レート制限を
    // 誘発している可能性が高いと判断し、base設定にさらに近づける。
    // サーキットブレーカー・再ウォームは劣化後の誤delisted化を防ぐ後始末でしかなく、
    // 劣化の発生自体は防げないため、根本原因側(負荷設定)を下げる。
    //
    // 再々調整(2026-07-31, digest.log実データに基づく): concurrency:3/rateLimit:550msに
    // 下げた後も 'all' でエラー率48.1%(maniax)、直近では100%近くに達する回が
    // 依然として発生していた。turboConcurrencyは既にbaseと同値(3)まで下げきっており
    // 残る差はrateLimitの700ms→550msのみだったが、この150ms差だけでも
    // DLsite側のレート制限を誘発するには十分だったとみられる(セッション再確立後も
    // Cookie正常＝レート制限であることは診断ログで確認済み、詳細は
    // detailFetcher.js の _recordApiEmptyAndMaybeRecover 参照)。
    // rateLimitのブースト自体を撤廃してbaseと同値にする(turbo/allの速度優位は
    // 主にconcurrencyではなくturboジョブの新作収集/終了間近収集との並列実行
    // 構造から来ているため、rateLimitを揃えても実用上の速度低下は小さい)。
    turboConcurrency: 3,
    turboRateLimit:   700,

    // サイト単位の実効同時接続数の上限（系統横断）。
    // 背景: turboConcurrency/turboRateLimitの調整コメントの通り、turbo/allの
    // エラー率悪化の主因はdetail単体のconcurrencyではなく「detail(concurrency=3)
    // + newrelease/endingsoon(discovery系)が同時に同じDLsiteへアクセスすることに
    // よる実効同時接続数の増加」だった。各系統(detailFetcher.js/discovery.js/
    // compScan.js)はそれぞれ自分のconcurrencyしか見ておらず、他系統が今何本
    // リクエストを飛ばしているか知らないまま独立に動く。ロック(sharedKeys)で
    // 排他されない組み合わせ(turbo内のPromise.all並走、circlegap実行中への
    // scheduler定期fetchの割り込み等)では、系統別concurrencyをどれだけ絞っても
    // DLsite側から見た合計同時接続数は際限なく積み上がりうる。
    // → queue.js の fetchWithRetry(全系統が経由する唯一の関数)側で、実際の
    //   fetch()呼び出し(リトライ待機・レート制限sleepは含まない)だけを対象に
    //   系統横断のグローバルセマフォでハードキャップする。
    // 値の根拠: turbo実行時の典型的な内訳は detail(3) + newrelease(実質1本ずつ
    //   逐次) + endingsoon(実質1本ずつ逐次) ≒ 最大5本。他ジョブの割り込みに
    //   若干の余裕を持たせて5に設定。
    globalMaxConcurrent: 5,
  },

  // サークル欠落診断(circleGapScan)専用の設定。
  // 背景: circleGapScanは「待っていても二度と収集されない過去の取りこぼしを
  // 掘り起こす」ための低優先度バックグラウンド診断であり、通常の
  // discover/fetch/turbo/allのように短時間で完了することを期待していない
  // (既知サークル数×最大1000ページが理論上の上限で、実運用では無制限に近い
  // 時間がかかりうる)。apiServer.jsのsharedKeysでdiscover/endingsoon/newrelease
  // とは排他されるが、detail(価格更新)とは意図的に排他されておらず並走できる
  // ため、time-boxを入れずに長時間走らせ続けると globalMaxConcurrent の
  // スロットを長時間占有し、並走中のdetailの実効速度を下げ続けてしまう。
  // → 1回の実行あたりの最大所要時間(maxDurationMs)で強制的に区切り、
  //   未走査分は次回実行に持ち越す。db.js の last_gap_checked ローテーション
  //   (未チェック/最も古いサークルから優先)により、time-boxで打ち切っても
  //   「同じサークルばかり見て他が永久に後回しになる」ことはなく、複数回の
  //   実行を重ねれば自然に全サークルを消化できる。
  // concurrencyもfetch.concurrency(detail用、既定3)とは分離し、診断ツールが
  // 主系統(detail)と同等以上の枠を食わないよう低めに固定する。
  circleGap: {
    concurrency:   2,
    maxDurationMs: 20 * 60 * 1000,   // 1回の実行あたり最大20分
  },

  cron: {
    discovery: '0 */6 * * *',
    detail:    '*/10 * * * *',
    saleBoost: '*/10 * * * *',
  },

  checkInterval: {
    endingSoon: 20 * 60,        // 割引終了24時間以内: 20分おきに再チェック
    onSale:     2  * 60 * 60,
    newWork:    6  * 60 * 60,
    recentWork: 12 * 60 * 60,
    popular:    12 * 60 * 60,
    normal:     24 * 60 * 60,
    cold:       72 * 60 * 60,
  },

  priority: {
    endingSoon:   110,   // 割引終了間近: onSaleより最優先
    onSale:       100,
    circleOnSale:  90,
    newWork:       80,
    recentWork:    50,
    popular:       40,
    normal:        20,
    cold:           5,
    delisted:       0,   // APIから恒常的に消失（削除/非公開等）と判定された作品
  },

  ui: {
    port: 7777,
    host: '127.0.0.1',
  },

  // ブラウザ拡張機能(DLsite Score)向け配信データのシャーディング設定。
  // 詳細は crawler/exportShards.js のコメント参照。
  shards: {
    dataDir:       './data-export',
    dataShards:    1024,  // maker_id(サークル)単位でハッシュ分散するバケツ数
    idxShards:     64,    // RJコード→shard番号 索引のバケツ数
    recentLogSize: 8,     // トレンド計算用の直近価格ログ件数
  },

  // 総集編マーク機能（拡張機能から移植）のレート設定。
  // 意図的に config.fetch とは完全独立させている: config.fetch.rateLimit/concurrency は
  // 'all'/'turbo' ジョブ実行中に一時的に書き換えられる共有可変オブジェクトのため、
  // ここが同じ値を参照すると無関係なジョブの影響で総集編スキャンの速度が予期せず
  // 変動し、本編の巡回と帯域を奪い合う原因になる。
  compScan: {
    listingRateLimit: 400,   // ジャンル515一覧ページ間の待機(ms)
    detailRateLimit:  800,   // 総集編詳細ページ取得間の待機(ms)
    detailConcurrency: 2,
    estimateRateLimit: 150,  // サークル推定時のproduct/info APIコール間隔(ms)
    threshold: 60,           // これ以上で自動確定、未満はcomp_pendingで要確認
  },

  // GitHub への push (scripts/push-data-shards.js) 用設定。
  // トークンはリポジトリに含めず、環境変数 GH_TOKEN か DLSITE_DATA_DIR 直下の
  // .github-token ファイル(.gitignore済み)から読む。未設定ならpushはスキップされる。
  github: {
    owner:      'tehuyoryu-cpu',
    repo:       'siteruns23432',
    dataBranch: 'data',
    // 巡回ジョブ完了ごとに直近ログ・price_issuesを自動push(scripts/pushDebugBundle.js)する先。
    // dataBranchとは分離し、価格配信データの履歴を汚さないようにする。
    debugBranch: 'debug',
  },

  dlsite: {
    sites: ['maniax', 'bl', 'girls'],

    // product/info/ajax が返す site_id フィールドとして有効な値。
    // DLsiteのAPIは、URLのサイトファミリー(maniax/girls/bl等)とは別に
    // AI生成作品やスマホアプリ向けなどの内部分類コード(aix/appx等)を
    // site_id として返すことがある。これを無検証でDBへ書き込むと、
    // 毎回のスキャンで正しいsite_idが上書きされ壊れ続けるバグになる
    // (parser.js / detailFetcher.js の両方から参照する正規リスト)。
    validSiteIds: ['maniax', 'girls', 'home', 'bl', 'pro'],

    fsrUrls: {
      maniax: {
        all:  'https://www.dlsite.com/maniax/fsr/=/language/jp/sex_category%5B0%5D/male/ana_flg/all/age_category%5B0%5D/general/age_category%5B1%5D/r15/age_category%5B2%5D/adult/order/trend/options%5B0%5D/JPN/options%5B1%5D/ENG/options%5B2%5D/CHI/options%5B3%5D/CHI_HANS/options%5B4%5D/CHI_HANT/options%5B5%5D/KO_KR/options%5B6%5D/SPA/options%5B7%5D/GER/options%5B8%5D/FRE/options%5B9%5D/IND/options%5B10%5D/ITA/options%5B11%5D/POR/options%5B12%5D/SWE/options%5B13%5D/THA/options%5B14%5D/VIE/options%5B15%5D/OTL/options%5B16%5D/NM/per_page/100/page/{page}/show_type/3',
        sale: 'https://www.dlsite.com/maniax/fsr/=/language/jp/sex_category%5B0%5D/male/ana_flg/all/age_category%5B0%5D/general/age_category%5B1%5D/r15/age_category%5B2%5D/adult/order/trend/options%5B0%5D/JPN/options%5B1%5D/ENG/options%5B2%5D/CHI/options%5B3%5D/CHI_HANS/options%5B4%5D/CHI_HANT/options%5B5%5D/KO_KR/options%5B6%5D/SPA/options%5B7%5D/GER/options%5B8%5D/FRE/options%5B9%5D/IND/options%5B10%5D/ITA/options%5B11%5D/POR/options%5B12%5D/SWE/options%5B13%5D/THA/options%5B14%5D/VIE/options%5B15%5D/OTL/options%5B16%5D/NM/per_page/100/page/{page}/campaign/campaign/show_type/3',
        // 割引終了まで24時間以内 (soon/1)。work_categoryで同人/書籍/PC/アプリ/AIに絞り込み済み
        soon: 'https://www.dlsite.com/maniax/fsr/=/language/jp/sex_category%5B0%5D/male/ana_flg/all/age_category%5B0%5D/general/age_category%5B1%5D/r15/age_category%5B2%5D/adult/work_category%5B0%5D/doujin/work_category%5B1%5D/books/work_category%5B2%5D/pc/work_category%5B3%5D/app/work_category%5B4%5D/ai/order/release_d/options_and_or/and/options%5B0%5D/JPN/options%5B1%5D/ENG/options%5B2%5D/CHI_HANS/options%5B3%5D/CHI_HANT/options%5B4%5D/KO_KR/options%5B5%5D/SPA/options%5B6%5D/GER/options%5B7%5D/FRE/options%5B8%5D/IND/options%5B9%5D/ITA/options%5B10%5D/POR/options%5B11%5D/SWE/options%5B12%5D/THA/options%5B13%5D/VIE/options%5B14%5D/OTL/options%5B15%5D/NM/per_page/100/page/{page}/campaign/campaign/soon/1/show_type/1/from/fs.detail',
        // 新作収集用: soon(割引終了間近)から campaign/campaign(割引条件) と soon/1(24時間以内終了) を除去し、
        // regist_date_start/{date} で発売日フィルタ(呼び出し側で1年前の日付を埋める)を追加したもの。
        // 割引の有無を問わず、直近1年以内に発売された全作品を対象にする。
        newRelease: 'https://www.dlsite.com/maniax/fsr/=/language/jp/sex_category%5B0%5D/male/regist_date_start/{date}/ana_flg/all/age_category%5B0%5D/general/age_category%5B1%5D/r15/age_category%5B2%5D/adult/work_category%5B0%5D/doujin/work_category%5B1%5D/books/work_category%5B2%5D/pc/work_category%5B3%5D/app/work_category%5B4%5D/ai/order/release_d/options_and_or/and/options%5B0%5D/JPN/options%5B1%5D/ENG/options%5B2%5D/CHI_HANS/options%5B3%5D/CHI_HANT/options%5B4%5D/KO_KR/options%5B5%5D/SPA/options%5B6%5D/GER/options%5B7%5D/FRE/options%5B8%5D/IND/options%5B9%5D/ITA/options%5B10%5D/POR/options%5B11%5D/SWE/options%5B12%5D/THA/options%5B13%5D/VIE/options%5B14%5D/OTL/options%5B15%5D/NM/per_page/100/page/{page}/show_type/1',
      },
      girls: {
        all:  'https://www.dlsite.com/girls/fsr/=/language/jp/sex_category%5B0%5D/female/sex_category%5B1%5D/gay/ana_flg/all/work_category%5B0%5D/doujin/work_category%5B1%5D/books/work_category%5B2%5D/drama/work_category%5B3%5D/pc/order/trend/options%5B0%5D/JPN/options%5B1%5D/ENG/options%5B2%5D/CHI_HANS/options%5B3%5D/CHI_HANT/options%5B4%5D/KO_KR/options%5B5%5D/SPA/options%5B6%5D/ARA/options%5B7%5D/GER/options%5B8%5D/FRE/options%5B9%5D/IND/options%5B10%5D/ITA/options%5B11%5D/POR/options%5B12%5D/SWE/options%5B13%5D/THA/options%5B14%5D/VIE/options%5B15%5D/OTL/options%5B16%5D/NM/per_page/100/page/{page}/is_tl/1/is_bl/1/is_gay/1/show_type/1',
        sale: 'https://www.dlsite.com/girls/fsr/=/language/jp/sex_category%5B0%5D/female/sex_category%5B1%5D/gay/ana_flg/all/work_category%5B0%5D/doujin/work_category%5B1%5D/books/work_category%5B2%5D/drama/work_category%5B3%5D/pc/order/trend/options%5B0%5D/JPN/options%5B1%5D/ENG/options%5B2%5D/CHI_HANS/options%5B3%5D/CHI_HANT/options%5B4%5D/KO_KR/options%5B5%5D/SPA/options%5B6%5D/GER/options%5B7%5D/FRE/options%5B8%5D/IND/options%5B9%5D/ITA/options%5B10%5D/POR/options%5B11%5D/SWE/options%5B12%5D/THA/options%5B13%5D/VIE/options%5B14%5D/OTL/options%5B15%5D/NM/per_page/100/page/{page}/campaign/campaign/is_tl/1/is_bl/1/is_gay%5B0%5D/1/show_type/1',
        soon: 'https://www.dlsite.com/girls/fsr/=/language/jp/ana_flg/all/age_category%5B0%5D/general/age_category%5B1%5D/r15/age_category%5B2%5D/adult/work_category%5B0%5D/doujin/work_category%5B1%5D/books/work_category%5B2%5D/pc/work_category%5B3%5D/app/work_category%5B4%5D/ai/order%5B0%5D/release_d/options_and_or/and/options%5B0%5D/JPN/options%5B1%5D/ENG/options%5B2%5D/CHI_HANS/options%5B3%5D/CHI_HANT/options%5B4%5D/KO_KR/options%5B5%5D/SPA/options%5B6%5D/GER/options%5B7%5D/FRE/options%5B8%5D/IND/options%5B9%5D/ITA/options%5B10%5D/POR/options%5B11%5D/SWE/options%5B12%5D/THA/options%5B13%5D/VIE/options%5B14%5D/OTL/options%5B15%5D/NM/options_name%5B0%5D/%E6%97%A5%E6%9C%AC%E8%AA%9E%E4%BD%9C%E5%93%81/options_name%5B1%5D/%E8%8B%B1%E8%AA%9E%E4%BD%9C%E5%93%81/options_name%5B2%5D/%E7%B0%A1%E4%BD%93%E5%AD%97%E4%BD%9C%E5%93%81/options_name%5B3%5D/%E7%B9%81%E4%BD%93%E5%AD%97%E4%BD%9C%E5%93%81/options_name%5B4%5D/%E9%9F%93%E5%9B%BD%E8%AA%9E%E4%BD%9C%E5%93%81/options_name%5B5%5D/%E8%A8%80%E8%AA%9E%E4%B8%8D%E5%95%8F%E4%BD%9C%E5%93%81/per_page/100/page/{page}/campaign/campaign/soon/1/show_type/1/from/fsr.more',
        newRelease: 'https://www.dlsite.com/girls/fsr/=/language/jp/regist_date_start/{date}/ana_flg/all/age_category%5B0%5D/general/age_category%5B1%5D/r15/age_category%5B2%5D/adult/work_category%5B0%5D/doujin/work_category%5B1%5D/books/work_category%5B2%5D/pc/work_category%5B3%5D/app/work_category%5B4%5D/ai/order%5B0%5D/release_d/options_and_or/and/options%5B0%5D/JPN/options%5B1%5D/ENG/options%5B2%5D/CHI_HANS/options%5B3%5D/CHI_HANT/options%5B4%5D/KO_KR/options%5B5%5D/SPA/options%5B6%5D/GER/options%5B7%5D/FRE/options%5B8%5D/IND/options%5B9%5D/ITA/options%5B10%5D/POR/options%5B11%5D/SWE/options%5B12%5D/THA/options%5B13%5D/VIE/options%5B14%5D/OTL/options%5B15%5D/NM/options_name%5B0%5D/%E6%97%A5%E6%9C%AC%E8%AA%9E%E4%BD%9C%E5%93%81/options_name%5B1%5D/%E8%8B%B1%E8%AA%9E%E4%BD%9C%E5%93%81/options_name%5B2%5D/%E7%B0%A1%E4%BD%93%E5%AD%97%E4%BD%9C%E5%93%81/options_name%5B3%5D/%E7%B9%81%E4%BD%93%E5%AD%97%E4%BD%9C%E5%93%81/options_name%5B4%5D/%E9%9F%93%E5%9B%BD%E8%AA%9E%E4%BD%9C%E5%93%81/options_name%5B5%5D/%E8%A8%80%E8%AA%9E%E4%B8%8D%E5%95%8F%E4%BD%9C%E5%93%81/per_page/100/page/{page}/show_type/1',
      },
      bl: {
        // bl サイトは all/sale 未調査のため soon のみ（割引終了間近収集専用）
        soon: 'https://www.dlsite.com/bl/fsr/=/language/jp/ana_flg/all/age_category%5B0%5D/general/age_category%5B1%5D/r15/age_category%5B2%5D/adult/work_category%5B0%5D/doujin/work_category%5B1%5D/books/work_category%5B2%5D/pc/work_category%5B3%5D/app/work_category%5B4%5D/ai/order%5B0%5D/release_d/options_and_or/and/options%5B0%5D/JPN/options%5B1%5D/ENG/options%5B2%5D/CHI_HANS/options%5B3%5D/CHI_HANT/options%5B4%5D/KO_KR/options%5B5%5D/SPA/options%5B6%5D/GER/options%5B7%5D/FRE/options%5B8%5D/IND/options%5B9%5D/ITA/options%5B10%5D/POR/options%5B11%5D/SWE/options%5B12%5D/THA/options%5B13%5D/VIE/options%5B14%5D/OTL/options%5B15%5D/NM/options_name%5B0%5D/%E6%97%A5%E6%9C%AC%E8%AA%9E%E4%BD%9C%E5%93%81/options_name%5B1%5D/%E8%8B%B1%E8%AA%9E%E4%BD%9C%E5%93%81/options_name%5B2%5D/%E7%B0%A1%E4%BD%93%E5%AD%97%E4%BD%9C%E5%93%81/options_name%5B3%5D/%E7%B9%81%E4%BD%93%E5%AD%97%E4%BD%9C%E5%93%81/options_name%5B4%5D/%E9%9F%93%E5%9B%BD%E8%AA%9E%E4%BD%9C%E5%93%81/options_name%5B5%5D/%E8%A8%80%E8%AA%9E%E4%B8%8D%E5%95%8F%E4%BD%9C%E5%93%81/per_page/100/page/{page}/campaign/campaign/soon/1/show_type/1/from/fsr.more',
        newRelease: 'https://www.dlsite.com/bl/fsr/=/language/jp/regist_date_start/{date}/ana_flg/all/age_category%5B0%5D/general/age_category%5B1%5D/r15/age_category%5B2%5D/adult/work_category%5B0%5D/doujin/work_category%5B1%5D/books/work_category%5B2%5D/pc/work_category%5B3%5D/app/work_category%5B4%5D/ai/order%5B0%5D/release_d/options_and_or/and/options%5B0%5D/JPN/options%5B1%5D/ENG/options%5B2%5D/CHI_HANS/options%5B3%5D/CHI_HANT/options%5B4%5D/KO_KR/options%5B5%5D/SPA/options%5B6%5D/GER/options%5B7%5D/FRE/options%5B8%5D/IND/options%5B9%5D/ITA/options%5B10%5D/POR/options%5B11%5D/SWE/options%5B12%5D/THA/options%5B13%5D/VIE/options%5B14%5D/OTL/options%5B15%5D/NM/options_name%5B0%5D/%E6%97%A5%E6%9C%AC%E8%AA%9E%E4%BD%9C%E5%93%81/options_name%5B1%5D/%E8%8B%B1%E8%AA%9E%E4%BD%9C%E5%93%81/options_name%5B2%5D/%E7%B0%A1%E4%BD%93%E5%AD%97%E4%BD%9C%E5%93%81/options_name%5B3%5D/%E7%B9%81%E4%BD%93%E5%AD%97%E4%BD%9C%E5%93%81/options_name%5B4%5D/%E9%9F%93%E5%9B%BD%E8%AA%9E%E4%BD%9C%E5%93%81/options_name%5B5%5D/%E8%A8%80%E8%AA%9E%E4%B8%8D%E5%95%8F%E4%BD%9C%E5%93%81/per_page/100/page/{page}/show_type/1',
      },
    },

    sites_legacy:    ['maniax', 'home'],
    baseUrl:         'https://www.dlsite.com',
    discoveryPages:  { new: 5, ranking: 3, sale: 5 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
      'AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/124.0.0.0 Safari/537.36',
    cookies: 'locale=ja-jp; adultchecked=1; agecheck=1',
  },
};
