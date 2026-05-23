'use strict';

module.exports = {
  db: {
    path: './dlsite.db',
  },

  server: {
    port: process.env.PORT ? parseInt(process.env.PORT) : 3000,
    host: '127.0.0.1',
  },

  fetch: {
    timeout: 20000,       // ms per request
    retryMax: 3,
    retryBaseDelay: 3000, // ms, doubles each retry
    concurrency: 3,       // parallel requests
    rateLimit: 1500,      // ms minimum between requests (same host)
    batchSize: 50,        // RJ codes per product/info/ajax call
  },

  // node-cron expressions
  cron: {
    discovery: '0 */6 * * *',   // discovery run every 6h
    detail:    '*/20 * * * *',  // detail queue flush every 20min
    saleBoost: '*/10 * * * *',  // re-prioritise sale works every 10min
  },

  // seconds between re-checks per work state
  checkInterval: {
    onSale:    2  * 60 * 60,   // 2h
    newWork:   6  * 60 * 60,   // 6h  (released < 7 days ago)
    recentWork:12 * 60 * 60,   // 12h (released < 30 days)
    popular:   12 * 60 * 60,   // 12h (dl_count > 1000)
    normal:    24 * 60 * 60,   // 24h
    cold:      72 * 60 * 60,   // 72h (≥5 checks with no price change)
  },

  // higher = checked first
  priority: {
    onSale:     100,
    circleOnSale: 90,
    newWork:     80,
    recentWork:  50,
    popular:     40,
    normal:      20,
    cold:         5,
  },

  ui: {
    port: 7777,
    host: '127.0.0.1',
  },

  dlsite: {
    sites: ['maniax', 'girls'],

    // ユーザー提供の FSR URL から抽出したベーステンプレート
    // {page} をページ番号に置換して使う
    fsrUrls: {
      maniax: {
        all:  'https://www.dlsite.com/maniax/fsr/=/language/jp/sex_category%5B0%5D/male/ana_flg/all/age_category%5B0%5D/general/age_category%5B1%5D/r15/age_category%5B2%5D/adult/order/trend/options%5B0%5D/JPN/options%5B1%5D/ENG/options%5B2%5D/CHI/options%5B3%5D/CHI_HANS/options%5B4%5D/CHI_HANT/options%5B5%5D/KO_KR/options%5B6%5D/SPA/options%5B7%5D/GER/options%5B8%5D/FRE/options%5B9%5D/IND/options%5B10%5D/ITA/options%5B11%5D/POR/options%5B12%5D/SWE/options%5B13%5D/THA/options%5B14%5D/VIE/options%5B15%5D/OTL/options%5B16%5D/NM/per_page/100/page/{page}/show_type/3',
        sale: 'https://www.dlsite.com/maniax/fsr/=/language/jp/sex_category%5B0%5D/male/ana_flg/all/age_category%5B0%5D/general/age_category%5B1%5D/r15/age_category%5B2%5D/adult/order/trend/options%5B0%5D/JPN/options%5B1%5D/ENG/options%5B2%5D/CHI/options%5B3%5D/CHI_HANS/options%5B4%5D/CHI_HANT/options%5B5%5D/KO_KR/options%5B6%5D/SPA/options%5B7%5D/GER/options%5B8%5D/FRE/options%5B9%5D/IND/options%5B10%5D/ITA/options%5B11%5D/POR/options%5B12%5D/SWE/options%5B13%5D/THA/options%5B14%5D/VIE/options%5B15%5D/OTL/options%5B16%5D/NM/per_page/100/page/{page}/campaign/campaign/show_type/3',
      },
      girls: {
        all:  'https://www.dlsite.com/girls/fsr/=/language/jp/sex_category[0]/female/sex_category[1]/gay/ana_flg/all/work_category[0]/doujin/work_category[1]/books/work_category[2]/drama/work_category[3]/pc/order/trend/options[0]/JPN/options[1]/ENG/options[2]/CHI_HANS/options[3]/CHI_HANT/options[4]/KO_KR/options[5]/SPA/options[6]/ARA/options[7]/GER/options[8]/FRE/options[9]/IND/options[10]/ITA/options[11]/POR/options[12]/SWE/options[13]/THA/options[14]/VIE/options[15]/OTL/options[16]/NM/per_page/100/page/{page}/is_tl/1/is_bl/1/is_gay/1/show_type/1',
        sale: 'https://www.dlsite.com/girls/fsr/=/language/jp/sex_category[0]/female/sex_category[1]/gay/ana_flg/all/work_category[0]/doujin/work_category[1]/books/work_category[2]/drama/work_category[3]/pc/order/trend/options[0]/JPN/options[1]/ENG/options[2]/CHI_HANS/options[3]/CHI_HANT/options[4]/KO_KR/options[5]/SPA/options[6]/GER/options[7]/FRE/options[8]/IND/options[9]/ITA/options[10]/POR/options[11]/SWE/options[12]/THA/options[13]/VIE/options[14]/OTL/options[15]/NM/per_page/100/page/{page}/campaign/campaign/is_tl/1/is_bl/1/is_gay[0]/1/show_type/1',
      },
    },

    // 通常discoveryのページ数（FSRとは別）
    // non-adult works can be on "home", adult on "maniax"
    sites_legacy: ['maniax', 'home'],
    baseUrl: 'https://www.dlsite.com',
    // pages per discovery run per source
    discoveryPages: {
      new:     5,
      ranking: 3,
      sale:    5,
    },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
      'AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/124.0.0.0 Safari/537.36',
    // DLsite に必要な Cookie:
    //   locale       = 日本語表示・JPY価格
    //   adultchecked = 年齢確認通過済み
    //   agecheck     = 旧形式の年齢確認フラグ
    cookies: 'locale=ja-jp; adultchecked=1; agecheck=1',
  },
};
