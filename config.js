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
    retryBaseDelay: 3000,
    concurrency:  3,
    rateLimit:    1500,
    batchSize:    50,
  },

  cron: {
    discovery: '0 */6 * * *',
    detail:    '*/20 * * * *',
    saleBoost: '*/10 * * * *',
  },

  checkInterval: {
    onSale:     2  * 60 * 60,
    newWork:    6  * 60 * 60,
    recentWork: 12 * 60 * 60,
    popular:    12 * 60 * 60,
    normal:     24 * 60 * 60,
    cold:       72 * 60 * 60,
  },

  priority: {
    onSale:       100,
    circleOnSale:  90,
    newWork:       80,
    recentWork:    50,
    popular:       40,
    normal:        20,
    cold:           5,
  },

  ui: {
    port: 7777,
    host: '127.0.0.1',
  },

  dlsite: {
    sites: ['maniax'],

    fsrUrls: {
      maniax: {
        all:  'https://www.dlsite.com/maniax/fsr/=/language/jp/sex_category%5B0%5D/male/ana_flg/all/age_category%5B0%5D/general/age_category%5B1%5D/r15/age_category%5B2%5D/adult/order/trend/options%5B0%5D/JPN/options%5B1%5D/ENG/options%5B2%5D/CHI/options%5B3%5D/CHI_HANS/options%5B4%5D/CHI_HANT/options%5B5%5D/KO_KR/options%5B6%5D/SPA/options%5B7%5D/GER/options%5B8%5D/FRE/options%5B9%5D/IND/options%5B10%5D/ITA/options%5B11%5D/POR/options%5B12%5D/SWE/options%5B13%5D/THA/options%5B14%5D/VIE/options%5B15%5D/OTL/options%5B16%5D/NM/per_page/100/page/{page}/show_type/3',
        sale: 'https://www.dlsite.com/maniax/fsr/=/language/jp/sex_category%5B0%5D/male/ana_flg/all/age_category%5B0%5D/general/age_category%5B1%5D/r15/age_category%5B2%5D/adult/order/trend/options%5B0%5D/JPN/options%5B1%5D/ENG/options%5B2%5D/CHI/options%5B3%5D/CHI_HANS/options%5B4%5D/CHI_HANT/options%5B5%5D/KO_KR/options%5B6%5D/SPA/options%5B7%5D/GER/options%5B8%5D/FRE/options%5B9%5D/IND/options%5B10%5D/ITA/options%5B11%5D/POR/options%5B12%5D/SWE/options%5B13%5D/THA/options%5B14%5D/VIE/options%5B15%5D/OTL/options%5B16%5D/NM/per_page/100/page/{page}/campaign/campaign/show_type/3',
      },
      girls: {
        all:  'https://www.dlsite.com/girls/fsr/=/language/jp/sex_category%5B0%5D/female/sex_category%5B1%5D/gay/ana_flg/all/work_category%5B0%5D/doujin/work_category%5B1%5D/books/work_category%5B2%5D/drama/work_category%5B3%5D/pc/order/trend/options%5B0%5D/JPN/options%5B1%5D/ENG/options%5B2%5D/CHI_HANS/options%5B3%5D/CHI_HANT/options%5B4%5D/KO_KR/options%5B5%5D/SPA/options%5B6%5D/ARA/options%5B7%5D/GER/options%5B8%5D/FRE/options%5B9%5D/IND/options%5B10%5D/ITA/options%5B11%5D/POR/options%5B12%5D/SWE/options%5B13%5D/THA/options%5B14%5D/VIE/options%5B15%5D/OTL/options%5B16%5D/NM/per_page/100/page/{page}/is_tl/1/is_bl/1/is_gay/1/show_type/1',
        sale: 'https://www.dlsite.com/girls/fsr/=/language/jp/sex_category%5B0%5D/female/sex_category%5B1%5D/gay/ana_flg/all/work_category%5B0%5D/doujin/work_category%5B1%5D/books/work_category%5B2%5D/drama/work_category%5B3%5D/pc/order/trend/options%5B0%5D/JPN/options%5B1%5D/ENG/options%5B2%5D/CHI_HANS/options%5B3%5D/CHI_HANT/options%5B4%5D/KO_KR/options%5B5%5D/SPA/options%5B6%5D/GER/options%5B7%5D/FRE/options%5B8%5D/IND/options%5B9%5D/ITA/options%5B10%5D/POR/options%5B11%5D/SWE/options%5B12%5D/THA/options%5B13%5D/VIE/options%5B14%5D/OTL/options%5B15%5D/NM/per_page/100/page/{page}/campaign/campaign/is_tl/1/is_bl/1/is_gay%5B0%5D/1/show_type/1',
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
