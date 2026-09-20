# デバッグサマリ（自動生成）

- 生成日時: 2026-09-20T23:46:03.338Z
- トリガージョブ: detail
- 直近の実行結果: `{"processed":0,"priceChanges":0,"errors":500,"total":500,"apiMissing":0,"contaminated":0,"fetchFail":500,"storeError":0,"verifiedAlive":0,"autoThrottled":false,"rateLimit":700,"concurrency":3,"errorRate":1,"highErrorRate":true}`
- 実行環境: v1.0.0 / Node v20.18.0 / Electron 31.7.7 / win32-x64
- ビルド元コミット: `ebf526b4f94802b008c134e57d35f162d5c3a57f`（ビルド日時: 2026-09-18T00:06:27Z / run #396）
  ⚠ 原因調査時は、まず `git log` でこのSHAがmain HEADと一致しているか確認してください。古いビルドの場合、main上では既に修正済みの不具合を調べていることがあります。

## DB統計
- 追跡作品数: 187684
- セール中: 168687
- 確認待ち(due): 180892
- 価格記録数: 548265
- サークル数: 29916（うちセール中: 28618）
- 定価取得エラー件数: 1214

## データ汚染サニティスキャン（works.cur_* の矛盾レコード件数）
- sale_price >= price（矛盾）: 0
- discount_rateありでsale_price無し: 0
- price=0なのにis_on_sale=1: 117
- 価格が負の値: 0
- 割引率が0〜100%の範囲外: 0
⚠ 合計117件の汚染疑いレコードが残っています。起動時に自動修復(repairContaminatedPriceData)が走るはずなので、直近に再起動していない場合はアプリの再起動を検討してください。

## on_sale過剰判定バグの残留影響（観測専用・自動修復なし）
- is_on_sale=1だがsale_price/discount_rateが一度も記録されていない件数: 69950
  （本物のポイント還元キャンペーンも同じ形で現れるため、この数値そのものが全て不具合とは限らない。前回pushからの減少幅を見て自己修復の進捗を確認する用途）

## warmUpセッション診断ヒストリの傾向（直近6回、プロセス起動以降）
年齢確認Cookie取得の成否をサイトごとに積算したもの。周期的なセッション切れか、単発の一時的な失敗かをここで判別できる（生データは warmup-history-recent.json）。
- maniax: 6/6回成功 (100%)
- bl: 6/6回成功 (100%)
- girls: 6/6回成功 (100%)

## セッション健全性スナップショット（サーキットブレーカー/自動スロットル）
これまでのWARN/ERRORログの文面だけからでは分からない「今まさにどういう抑制状態か」をそのままダンプしたもの。エラー急増の原因調査はまずここを見ると早い。
```json
{
  "perSite": {
    "girls": {
      "emptyStreak": 0,
      "circuitOpen": false,
      "rewarmInProgress": false,
      "rateLimitBackoffRemainingSec": 0,
      "rateLimitBackoffLevel": 1
    }
  },
  "global": {
    "backoffActive": false,
    "backoffRemainingSec": 0,
    "lastTriggeredAt": null
  },
  "globalConcurrency": {
    "active": 0,
    "waiting": 0,
    "max": 5
  },
  "rewarm": {
    "lastRewarmAt": "2026-09-19T14:30:58.713Z",
    "cooldownRemainingSec": 0
  },
  "autoThrottle": {
    "all": {
      "consecutiveHighErrorRuns": 0,
      "active": false,
      "lastRunFinishedAt": "2026-09-20T12:23:45.152Z"
    }
  }
}
```
- `perSite[site].circuitOpen`: そのサイトへのリクエストを打ち切り中か（true の場合、90秒おきのプローブ以外は送っていない＝処理件数が伸びなくて当然の状態）
- `global.backoffActive`: 複数サイト同時劣化によるグローバル抑制中か（trueなら全サイト並列度1）
- `autoThrottle[job].active`: 直近の連続高エラー率により次回実行が自動で抑制されるか
- `globalConcurrency`: 系統横断(detail/discovery/compScan合計)の実効同時接続数。`waiting`が常態的に0でない場合はglobalMaxConcurrentが速度のボトルネックになっている可能性、`active`が`max`未満のままエラー率が高い場合は輻輳以外の要因(DLsite側のレート制限等)を疑う

## 直近のジョブ要約（digest.log 末尾）
```
2026-09-05T01:23:30.312Z [pushdebug] duration:0.9s ok:false skipped:false error:blob create failed (latest.log): HTTP 401 {
  "message": "Bad credentials",
  "documentation_url": "https://docs.github.com/rest",
  "status": "401"
}
2026-09-05T01:30:07.579Z [fetch] trigger:cron processed:484 priceChanges:0 errors:0 total:484 apiMissing:0 contaminated:0 fetchFail:0 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:0 highErrorRate:false duration:6.7s
2026-09-05T01:50:06.390Z [fetch] trigger:cron processed:500 priceChanges:1 errors:0 total:500 apiMissing:0 contaminated:0 fetchFail:0 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:0 highErrorRate:false duration:6.0s
2026-09-05T01:54:46.479Z [pushdebug] duration:0.9s ok:false skipped:false error:blob create failed (latest.log): HTTP 401 {
  "message": "Bad credentials",
  "documentation_url": "https://docs.github.com/rest",
  "status": "401"
}
2026-09-05T01:54:53.720Z [pushdata] duration:4.4s ok:false error:tree create failed (chunk 0〜149件目): HTTP 401 {
  "message": "Bad credentials",
  "documentation_url": "https://docs.github.com/rest",
  "status": "401"
}
2026-09-05T02:00:06.285Z [fetch] trigger:cron processed:467 priceChanges:8 errors:0 total:467 apiMissing:0 contaminated:0 fetchFail:0 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:0 highErrorRate:false duration:5.7s
2026-09-05T02:04:19.360Z [pushdata] duration:4.2s ok:false error:tree create failed (chunk 0〜149件目): HTTP 401 {
  "message": "Bad credentials",
  "documentation_url": "https://docs.github.com/rest",
  "status": "401"
}
2026-09-05T02:04:30.906Z [pushdata] duration:3.6s ok:false error:tree create failed (chunk 0〜149件目): HTTP 401 {
  "message": "Bad credentials",
  "documentation_url": "https://docs.github.com/rest",
  "status": "401"
}
2026-09-05T02:20:06.688Z [fetch] trigger:cron processed:497 priceChanges:3 errors:0 total:497 apiMissing:0 contaminated:0 fetchFail:0 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:0 highErrorRate:false duration:5.8s
2026-09-05T02:28:23.838Z [pushdata] duration:4.0s ok:false error:tree create failed (chunk 0〜149件目): HTTP 401 {
  "message": "Bad credentials",
  "documentation_url": "https://docs.github.com/rest",
  "status": "401"
}
2026-09-05T02:30:05.634Z [fetch] trigger:cron processed:500 priceChanges:6 errors:0 total:500 apiMissing:0 contaminated:0 fetchFail:0 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:0 highErrorRate:false duration:4.8s
2026-09-05T02:32:13.461Z [discover] trigger:cron discovered:113 duration:132.6s
2026-09-05T02:33:14.040Z [pushdata] duration:23.1s ok:true files:1088 changed:1089 commit:79a01811b9e2f4ffb3dc7b6ba40f204061fcee74 branch:data exportResult:{"works":55609,"dataShardFiles":1022,"idxShardFiles":64,"ms":3091}
2026-09-05T02:33:32.265Z [pushdebug] duration:11.9s ok:true files:12
2026-09-05T02:50:16.403Z [fetch] trigger:cron processed:500 priceChanges:110 errors:0 total:500 apiMissing:0 contaminated:0 fetchFail:0 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:0 highErrorRate:false duration:15.8s
2026-09-05T03:47:55.495Z [all] duration:575.3s ok:true discovered:2 processed:52537 priceChanges:87 errors:0 total:52537 apiMissing:0 contaminated:0 fetchFail:0 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:0 highErrorRate:false stopped:false
2026-09-05T05:20:19.039Z [fetch] trigger:cron processed:500 priceChanges:0 errors:0 total:500 apiMissing:0 contaminated:0 fetchFail:0 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:0 highErrorRate:false duration:18.0s
2026-09-05T06:30:16.143Z [fetch] trigger:cron processed:500 priceChanges:0 errors:0 total:500 apiMissing:0 contaminated:0 fetchFail:0 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:0 highErrorRate:false duration:15.4s
2026-09-05T07:00:16.998Z [fetch] trigger:cron processed:500 priceChanges:0 errors:0 total:500 apiMissing:0 contaminated:0 fetchFail:0 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:0 highErrorRate:false duration:16.1s
2026-09-05T07:20:15.641Z [fetch] trigger:cron processed:500 priceChanges:0 errors:0 total:500 apiMissing:0 contaminated:0 fetchFail:0 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:0 highErrorRate:false duration:14.7s
2026-09-05T07:30:15.048Z [fetch] trigger:cron processed:500 priceChanges:0 errors:0 total:500 apiMissing:0 contaminated:0 fetchFail:0 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:0 highErrorRate:false duration:15.0s
2026-09-06T01:30:18.717Z [fetch] trigger:cron processed:500 priceChanges:3 errors:0 total:500 apiMissing:0 contaminated:0 fetchFail:0 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:0 highErrorRate:false duration:17.8s
2026-09-06T01:40:18.339Z [fetch] trigger:cron processed:500 priceChanges:1 errors:0 total:500 apiMissing:0 contaminated:0 fetchFail:0 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:0 highErrorRate:false duration:17.9s
2026-09-06T02:10:18.229Z [fetch] trigger:cron processed:500 priceChanges:0 errors:0 total:500 apiMissing:0 contaminated:0 fetchFail:0 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:0 highErrorRate:false duration:17.2s
2026-09-06T13:12:36.244Z [endingsoon] duration:42.9s ok:true grandTotal:568 newCount:540 boostedCount:568 sites:{"maniax":528,"girls":23,"bl":17}
2026-09-06T13:13:19.242Z [newrelease] duration:33.6s ok:true grandTotal:204 sites:{"maniax":5,"girls":51,"bl":148}
2026-09-06T13:13:24.969Z [fetch] trigger:startup processed:499 priceChanges:499 errors:1 total:500 apiMissing:1 contaminated:0 fetchFail:0 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:0.002 highErrorRate:false duration:7.6s
2026-09-06T13:13:41.285Z [discover] trigger:startup discovered:265 duration:28.9s
2026-09-06T13:15:56.248Z [turbo] duration:150.7s ok:true processed:13747 priceChanges:567 errors:3 total:14000 apiMissing:0 contaminated:0 fetchFail:3 storeError:0 verifiedAlive:3 autoThrottled:false rateLimit:700 concurrency:3 errorRate:0 highErrorRate:false newRelease:{"grandTotal":0,"sites":{"maniax":0,"girls":0,"bl":0}} endingSoon:{"grandTotal":568,"newCount":0,"boostedCount":568,"sites":{"maniax":528,"girls":23,"bl":17}} stopped:true
2026-09-06T13:17:56.841Z [discover] duration:113.6s ok:true discovered:1096 stopped:false
2026-09-06T13:18:01.259Z [all] duration:113.8s ok:true discovered:0 processed:0 priceChanges:0 errors:0 total:0 apiMissing:0 contaminated:0 fetchFail:0 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:null highErrorRate:false stopped:true
2026-09-06T13:19:18.767Z [pushdata] duration:14.7s ok:true files:1089 changed:350 commit:499c0c7b37862c9995ce8e509707d506be8d443d branch:data exportResult:{"works":57560,"dataShardFiles":1023,"idxShardFiles":64,"ms":4812}
2026-09-06T13:19:21.194Z [pushdebug] duration:11.7s ok:true files:12
2026-09-06T13:22:56.771Z [all] duration:246.9s ok:true discovered:0 processed:20796 priceChanges:1402 errors:0 total:21000 apiMissing:0 contaminated:0 fetchFail:0 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:0 highErrorRate:false stopped:true
2026-09-06T13:29:43.594Z [all] duration:361.5s ok:true discovered:610 processed:24183 priceChanges:799 errors:3 total:24186 apiMissing:3 contaminated:0 fetchFail:0 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:0 highErrorRate:false stopped:false
2026-09-06T13:30:00.757Z [fetch] trigger:cron processed:0 priceChanges:0 errors:0 total:0 apiMissing:0 contaminated:0 fetchFail:0 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:null highErrorRate:false duration:0.0s
2026-09-06T13:40:13.899Z [fetch] trigger:cron processed:0 priceChanges:0 errors:2 total:2 apiMissing:0 contaminated:0 fetchFail:2 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:null highErrorRate:false duration:13.0s
2026-09-07T05:46:22.302Z [fetch] trigger:startup processed:498 priceChanges:42 errors:2 total:500 apiMissing:0 contaminated:0 fetchFail:2 storeError:0 verifiedAlive:2 autoThrottled:false rateLimit:700 concurrency:3 errorRate:0.004 highErrorRate:false duration:15.3s
2026-09-07T05:47:46.657Z [discover] trigger:startup discovered:2029 duration:105.3s
2026-09-07T05:50:17.517Z [fetch] trigger:cron processed:500 priceChanges:0 errors:0 total:500 apiMissing:0 contaminated:0 fetchFail:0 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:0 highErrorRate:false duration:17.1s
2026-09-07T05:57:06.036Z [all] duration:710.2s ok:true discovered:2226 processed:58352 priceChanges:2775 errors:0 total:58352 apiMissing:0 contaminated:0 fetchFail:0 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:0 highErrorRate:false stopped:false
2026-09-07T13:00:14.985Z [fetch] trigger:cron ok:false error:database is locked duration:14.0s
2026-09-07T13:00:16.823Z [fetch] trigger:cron processed:499 priceChanges:0 errors:1 total:500 apiMissing:0 contaminated:0 fetchFail:1 storeError:0 verifiedAlive:1 autoThrottled:false rateLimit:700 concurrency:3 errorRate:0.002 highErrorRate:false duration:16.7s
2026-09-07T13:01:55.445Z [pushdata] duration:20.6s ok:true files:1089 changed:447 commit:2038fd4670cb1349fe3923ef7781e3878e4b0f76 branch:data exportResult:{"works":60529,"dataShardFiles":1023,"idxShardFiles":64,"ms":10066}
2026-09-07T13:01:58.819Z [pushdebug] duration:24.4s ok:true files:12
2026-09-07T13:10:20.776Z [fetch] trigger:cron processed:500 priceChanges:0 errors:0 total:500 apiMissing:0 contaminated:0 fetchFail:0 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:0 highErrorRate:false duration:20.2s
2026-09-07T13:50:16.466Z [fetch] trigger:cron processed:500 priceChanges:0 errors:0 total:500 apiMissing:0 contaminated:0 fetchFail:0 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:0 highErrorRate:false duration:16.3s
2026-09-07T23:17:43.724Z [fetch] trigger:startup processed:0 priceChanges:0 errors:0 total:500 apiMissing:0 contaminated:0 fetchFail:0 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:null highErrorRate:false duration:51.9s
2026-09-07T23:19:43.622Z [all] duration:136.9s ok:true discovered:0 processed:0 priceChanges:0 errors:0 total:0 apiMissing:0 contaminated:0 fetchFail:0 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:null highErrorRate:false stopped:true
2026-09-07T23:22:03.352Z [pushdata] duration:8.3s ok:true files:1089 changed:1 commit:9acf87cb2a72007c9a7bdb3df4fcae716bfe788e branch:data exportResult:{"works":60529,"dataShardFiles":1023,"idxShardFiles":64,"ms":4313}
2026-09-07T23:22:10.226Z [pushdebug] duration:15.9s ok:true files:12
2026-09-07T23:24:56.034Z [fetch] trigger:cron processed:0 priceChanges:0 errors:500 total:500 apiMissing:0 contaminated:0 fetchFail:500 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:1 highErrorRate:true duration:295.3s
2026-09-07T23:34:58.970Z [discover] trigger:startup discovered:0 duration:1092.3s
2026-09-08T23:26:13.383Z [fetch] trigger:startup processed:0 priceChanges:0 errors:0 total:500 apiMissing:0 contaminated:0 fetchFail:0 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:null highErrorRate:false duration:43.6s
2026-09-08T23:28:12.639Z [all] duration:137.8s ok:true discovered:0 processed:0 priceChanges:0 errors:0 total:0 apiMissing:0 contaminated:0 fetchFail:0 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:null highErrorRate:false stopped:true
2026-09-08T23:28:47.477Z [pushdata] duration:9.1s ok:true files:1089 changed:1 commit:395f778f2eb0fa6a376c6734a3050d9fc8242597 branch:data exportResult:{"works":60529,"dataShardFiles":1023,"idxShardFiles":64,"ms":5118}
2026-09-08T23:28:52.829Z [pushdebug] duration:15.5s ok:true files:12
2026-09-08T23:50:35.697Z [fetch] trigger:cron processed:0 priceChanges:0 errors:500 total:500 apiMissing:0 contaminated:0 fetchFail:500 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:1 highErrorRate:true duration:1235.5s
2026-09-09T00:21:34.569Z [fetch] trigger:cron processed:0 priceChanges:0 errors:500 total:500 apiMissing:0 contaminated:0 fetchFail:500 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:1 highErrorRate:true duration:1293.8s
2026-09-09T00:45:24.078Z [fetch] trigger:cron processed:0 priceChanges:0 errors:500 total:500 apiMissing:0 contaminated:0 fetchFail:500 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:1 highErrorRate:true duration:923.3s
2026-09-09T01:01:01.792Z [discover] trigger:startup discovered:0 duration:5737.1s
2026-09-09T01:54:11.891Z [fetch] trigger:cron processed:0 priceChanges:0 errors:500 total:500 apiMissing:0 contaminated:0 fetchFail:500 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:1 highErrorRate:true duration:2651.8s
2026-09-09T11:40:29.116Z [all] duration:724.5s ok:true discovered:581 processed:61478 priceChanges:1027 errors:12 total:61490 apiMissing:12 contaminated:0 fetchFail:0 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:0 highErrorRate:false stopped:false
2026-09-09T11:40:55.380Z [pushdata] duration:11.1s ok:true files:1089 changed:310 commit:c6da8c7a57e7167470c59feee0d9c950a1c8dca2 branch:data exportResult:{"works":61092,"dataShardFiles":1023,"idxShardFiles":64,"ms":1678}
2026-09-09T11:40:57.958Z [pushdebug] duration:14.2s ok:true files:12
2026-09-09T11:42:56.951Z [turbo] duration:106.3s ok:true processed:0 priceChanges:0 errors:0 total:0 apiMissing:0 contaminated:0 fetchFail:0 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:null highErrorRate:false newRelease:{"grandTotal":43,"sites":{"maniax":0,"girls":0,"bl":43}} endingSoon:{"grandTotal":5489,"newCount":5310,"boostedCount":5489,"sites":{"maniax":5489}} stopped:true
2026-09-09T12:00:20.000Z [fetch] trigger:cron processed:490 priceChanges:490 errors:10 total:500 apiMissing:10 contaminated:0 fetchFail:0 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:0.02 highErrorRate:false duration:19.3s
2026-09-09T12:10:19.426Z [fetch] trigger:cron processed:500 priceChanges:500 errors:0 total:500 apiMissing:0 contaminated:0 fetchFail:0 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:0 highErrorRate:false duration:18.7s
2026-09-09T12:20:20.744Z [fetch] trigger:cron processed:500 priceChanges:500 errors:0 total:500 apiMissing:0 contaminated:0 fetchFail:0 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:0 highErrorRate:false duration:19.8s
2026-09-09T12:40:21.359Z [fetch] trigger:cron processed:499 priceChanges:499 errors:1 total:500 apiMissing:1 contaminated:0 fetchFail:0 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:0.002 highErrorRate:false duration:20.6s
2026-09-09T14:00:19.602Z [fetch] trigger:cron processed:499 priceChanges:499 errors:1 total:500 apiMissing:1 contaminated:0 fetchFail:0 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:0.002 highErrorRate:false duration:19.3s
2026-09-09T14:02:03.355Z [fullscan] duration:8341.9s ok:true grandTotal:0 sites:{"maniax":0,"bl":0,"girls":0}
2026-09-11T23:26:19.273Z [fetch] trigger:startup processed:500 priceChanges:500 errors:0 total:500 apiMissing:0 contaminated:0 fetchFail:0 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:0 highErrorRate:false duration:17.6s
2026-09-11T23:26:25.160Z [newrelease] duration:41.0s ok:true grandTotal:382 sites:{"maniax":2,"girls":252,"bl":128}
2026-09-11T23:28:11.087Z [discover] trigger:startup discovered:2186 duration:134.5s
2026-09-11T23:29:31.610Z [endingsoon] duration:36.3s ok:true grandTotal:641 newCount:582 boostedCount:641 sites:{"maniax":598,"girls":30,"bl":13}
2026-09-11T23:29:49.114Z [pushdebug] duration:10.1s ok:true files:12
2026-09-11T23:30:08.969Z [fetch] trigger:cron processed:499 priceChanges:499 errors:1 total:500 apiMissing:0 contaminated:0 fetchFail:1 storeError:0 verifiedAlive:1 autoThrottled:false rateLimit:700 concurrency:3 errorRate:0.002 highErrorRate:false duration:8.0s
2026-09-11T23:30:15.116Z [pushdata] duration:24.0s ok:true files:1090 changed:1052 commit:1d89695bd9df7c224cfe3596e88d2f48a06b935a branch:data exportResult:{"works":69337,"dataShardFiles":1024,"idxShardFiles":64,"ms":5550}
2026-09-11T23:30:15.329Z [pushdebug] duration:10.6s ok:true files:12
2026-09-11T23:34:26.624Z [newrelease] duration:15.7s ok:true grandTotal:0 sites:{"maniax":0,"girls":0,"bl":0}
2026-09-11T23:37:26.190Z [all] duration:168.5s ok:true discovered:238 processed:8950 priceChanges:5061 errors:0 total:9000 apiMissing:0 contaminated:0 fetchFail:0 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:0 highErrorRate:false stopped:true
2026-09-11T23:40:17.910Z [fetch] trigger:cron processed:500 priceChanges:254 errors:0 total:500 apiMissing:0 contaminated:0 fetchFail:0 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:0 highErrorRate:false duration:17.3s
2026-09-11T23:45:47.402Z [newrelease] duration:14.9s ok:true grandTotal:0 sites:{"maniax":0,"girls":0,"bl":0}
2026-09-11T23:46:06.766Z [endingsoon] duration:17.4s ok:true grandTotal:641 newCount:0 boostedCount:641 sites:{"maniax":598,"girls":30,"bl":13}
2026-09-11T23:46:30.242Z [fetch] trigger:startup processed:500 priceChanges:487 errors:0 total:500 apiMissing:0 contaminated:0 fetchFail:0 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:0 highErrorRate:false duration:10.8s
2026-09-11T23:48:05.053Z [discover] trigger:startup discovered:92 duration:110.7s
2026-09-11T23:57:27.878Z [all] duration:649.3s ok:true discovered:0 processed:59917 priceChanges:7532 errors:25 total:59942 apiMissing:24 contaminated:0 fetchFail:1 storeError:0 verifiedAlive:1 autoThrottled:false rateLimit:700 concurrency:3 errorRate:0 highErrorRate:false stopped:false
2026-09-12T00:00:00.562Z [fetch] trigger:cron processed:0 priceChanges:0 errors:0 total:0 apiMissing:0 contaminated:0 fetchFail:0 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:null highErrorRate:false duration:0.0s
2026-09-12T00:17:43.497Z [all] duration:138.4s ok:true discovered:1650 processed:1650 priceChanges:1648 errors:0 total:1650 apiMissing:0 contaminated:0 fetchFail:0 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:0 highErrorRate:false stopped:false
2026-09-12T00:18:45.588Z [all] duration:54.4s ok:true discovered:22 processed:22 priceChanges:22 errors:0 total:22 apiMissing:0 contaminated:0 fetchFail:0 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:null highErrorRate:false stopped:false
2026-09-12T00:18:47.198Z [pushdebug] duration:15.8s ok:true files:12
2026-09-12T00:18:56.492Z [pushdata] duration:24.4s ok:true files:1090 changed:1066 commit:9fa18ce99b93e595ca6e5ddce378a41e08256a7b branch:data exportResult:{"works":71526,"dataShardFiles":1024,"idxShardFiles":64,"ms":4182}
2026-09-12T00:20:00.447Z [fetch] trigger:cron processed:0 priceChanges:0 errors:0 total:0 apiMissing:0 contaminated:0 fetchFail:0 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:null highErrorRate:false duration:0.0s
2026-09-12T00:22:35.612Z [pushdebug] duration:11.6s ok:true files:12
2026-09-12T00:30:13.576Z [fetch] trigger:cron processed:0 priceChanges:0 errors:0 total:0 apiMissing:0 contaminated:0 fetchFail:0 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:null highErrorRate:false duration:12.9s
2026-09-12T01:01:58.451Z [all] duration:162.5s ok:true discovered:0 processed:0 priceChanges:0 errors:86 total:86 apiMissing:0 contaminated:0 fetchFail:86 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:1 highErrorRate:true stopped:false
2026-09-12T02:40:57.070Z [all] duration:948.0s ok:true discovered:0 processed:69993 priceChanges:459 errors:805 total:70798 apiMissing:1 contaminated:0 fetchFail:804 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:1500 concurrency:2 withinRunThrottled:true errorRate:0.011 highErrorRate:false stopped:false
2026-09-12T02:42:14.127Z [all] duration:65.7s ok:true discovered:89 processed:89 priceChanges:88 errors:0 total:89 apiMissing:0 contaminated:0 fetchFail:0 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:0 highErrorRate:false stopped:false
2026-09-12T03:01:25.716Z [fetch] trigger:cron processed:0 priceChanges:0 errors:450 total:450 apiMissing:0 contaminated:0 fetchFail:450 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:1 highErrorRate:true duration:84.9s
2026-09-12T06:20:19.262Z [fetch] trigger:cron processed:500 priceChanges:0 errors:0 total:500 apiMissing:0 contaminated:0 fetchFail:0 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:0 highErrorRate:false duration:18.6s
2026-09-12T13:28:30.907Z [all] duration:917.7s ok:true discovered:1417 processed:70328 priceChanges:1412 errors:376 total:70704 apiMissing:1 contaminated:0 fetchFail:375 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:1500 concurrency:2 withinRunThrottled:true errorRate:0.005 highErrorRate:false stopped:false
2026-09-12T13:50:14.164Z [fetch] trigger:cron processed:0 priceChanges:0 errors:25 total:25 apiMissing:0 contaminated:0 fetchFail:25 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:null highErrorRate:false duration:13.6s
2026-09-12T15:00:14.051Z [fetch] trigger:cron processed:0 priceChanges:0 errors:0 total:0 apiMissing:0 contaminated:0 fetchFail:0 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:null highErrorRate:false duration:13.2s
2026-09-13T00:58:45.735Z [all] duration:874.0s ok:true discovered:64 processed:72950 priceChanges:876 errors:1 total:72951 apiMissing:1 contaminated:0 fetchFail:0 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:0 highErrorRate:false stopped:false
2026-09-13T00:59:14.649Z [pushdebug] duration:11.7s ok:true files:12
2026-09-13T01:25:18.455Z [all] duration:88.2s ok:true discovered:131 processed:131 priceChanges:131 errors:0 total:131 apiMissing:0 contaminated:0 fetchFail:0 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:0 highErrorRate:false stopped:false
2026-09-13T01:29:51.627Z [all] duration:69.6s ok:true discovered:0 processed:14 priceChanges:0 errors:0 total:14 apiMissing:0 contaminated:0 fetchFail:0 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:null highErrorRate:false stopped:false
2026-09-13T01:30:00.717Z [fetch] trigger:cron processed:0 priceChanges:0 errors:0 total:0 apiMissing:0 contaminated:0 fetchFail:0 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:null highErrorRate:false duration:0.0s
2026-09-13T02:50:22.443Z [fetch] trigger:cron processed:500 priceChanges:2 errors:0 total:500 apiMissing:0 contaminated:0 fetchFail:0 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:0 highErrorRate:false duration:22.0s
2026-09-13T03:10:18.647Z [fetch] trigger:cron processed:500 priceChanges:2 errors:0 total:500 apiMissing:0 contaminated:0 fetchFail:0 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:0 highErrorRate:false duration:17.8s
2026-09-13T04:00:19.032Z [fetch] trigger:cron processed:500 priceChanges:0 errors:0 total:500 apiMissing:0 contaminated:0 fetchFail:0 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:0 highErrorRate:false duration:18.0s
2026-09-13T04:34:25.873Z [fullscan] duration:9999.5s ok:true grandTotal:0 sites:{"maniax":0,"bl":0,"girls":0}
2026-09-13T05:33:56.573Z [all] duration:3011.0s ok:true discovered:1807 processed:72698 priceChanges:1876 errors:1 total:72699 apiMissing:1 contaminated:0 fetchFail:0 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:0 highErrorRate:false stopped:false
2026-09-13T05:36:25.391Z [all] duration:139.6s ok:true discovered:1877 processed:1965 priceChanges:1877 errors:0 total:1965 apiMissing:0 contaminated:0 fetchFail:0 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:0 highErrorRate:false stopped:false
2026-09-13T05:36:40.103Z [pushdebug] duration:12.1s ok:true files:12
2026-09-13T05:50:15.381Z [newrelease] duration:52.6s ok:true grandTotal:15 sites:{"maniax":0,"girls":0,"bl":15}
2026-09-13T06:03:07.205Z [fetch] trigger:startup processed:468 priceChanges:468 errors:32 total:500 apiMissing:32 contaminated:0 fetchFail:0 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:0.064 highErrorRate:false duration:25.6s
2026-09-13T06:04:35.747Z [discover] trigger:startup discovered:1409 duration:119.3s
2026-09-13T06:04:38.430Z [fullscan] duration:202.4s ok:true grandTotal:0 sites:{"maniax":0}
2026-09-13T06:04:48.385Z [pushdebug] duration:11.2s ok:true files:12
2026-09-13T06:05:03.327Z [pushdebug] duration:11.7s ok:true files:12
2026-09-13T06:10:23.071Z [fetch] trigger:cron processed:494 priceChanges:494 errors:6 total:500 apiMissing:6 contaminated:0 fetchFail:0 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:0.012 highErrorRate:false duration:22.9s
2026-09-13T08:50:42.483Z [all] duration:908.0s ok:true discovered:0 processed:86614 priceChanges:12305 errors:123 total:86737 apiMissing:65 contaminated:0 fetchFail:58 storeError:0 verifiedAlive:58 autoThrottled:false rateLimit:700 concurrency:3 errorRate:0.001 highErrorRate:false stopped:true
2026-09-13T10:56:37.165Z [fetch] trigger:startup processed:442 priceChanges:0 errors:58 total:500 apiMissing:0 contaminated:0 fetchFail:58 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:0.116 highErrorRate:false duration:95.2s
2026-09-13T10:57:09.327Z [discover] trigger:startup discovered:873 duration:132.4s
2026-09-13T11:00:25.110Z [fetch] trigger:cron processed:500 priceChanges:0 errors:0 total:500 apiMissing:0 contaminated:0 fetchFail:0 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:0 highErrorRate:false duration:24.4s
2026-09-13T12:28:59.179Z [fullscan] duration:5708.5s ok:true grandTotal:74187 sites:{"maniax":60087,"bl":11211,"girls":2889}
2026-09-13T13:08:40.946Z [all] duration:2205.7s ok:true discovered:2157 processed:163584 priceChanges:77112 errors:176 total:163760 apiMissing:108 contaminated:0 fetchFail:68 storeError:0 verifiedAlive:4 autoThrottled:false rateLimit:700 concurrency:3 errorRate:0.001 highErrorRate:false stopped:false
2026-09-13T13:54:40.144Z [fullscan] duration:2747.9s ok:true grandTotal:0 sites:{"maniax":0,"bl":0,"girls":0}
2026-09-13T14:14:49.914Z [all] duration:157.3s ok:true discovered:1782 processed:1936 priceChanges:1797 errors:3 total:1939 apiMissing:0 contaminated:0 fetchFail:3 storeError:0 verifiedAlive:3 autoThrottled:false rateLimit:700 concurrency:3 errorRate:0.002 highErrorRate:false stopped:false
2026-09-13T15:00:24.433Z [fetch] trigger:cron processed:500 priceChanges:4 errors:0 total:500 apiMissing:0 contaminated:0 fetchFail:0 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:0 highErrorRate:false duration:23.7s
2026-09-13T18:20:22.332Z [fetch] trigger:cron processed:500 priceChanges:3 errors:0 total:500 apiMissing:0 contaminated:0 fetchFail:0 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:0 highErrorRate:false duration:22.3s
2026-09-13T19:10:21.405Z [fetch] trigger:cron processed:500 priceChanges:0 errors:0 total:500 apiMissing:0 contaminated:0 fetchFail:0 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:0 highErrorRate:false duration:21.4s
2026-09-13T23:22:32.553Z [pushdebug] duration:19.4s ok:true files:12
2026-09-13T23:22:42.172Z [pushdata] duration:28.3s ok:true files:1090 changed:1089 commit:4150d51068fc5ef9b4d7de62579b7a9ecd9c9c7f branch:data exportResult:{"works":166735,"dataShardFiles":1024,"idxShardFiles":64,"ms":6458}
2026-09-17T10:01:52.837Z [fetch] trigger:startup processed:431 priceChanges:332 errors:69 total:500 apiMissing:1 contaminated:0 fetchFail:68 storeError:0 verifiedAlive:10 autoThrottled:false rateLimit:700 concurrency:3 errorRate:0.138 highErrorRate:false duration:61.2s
2026-09-17T10:02:48.285Z [discover] trigger:startup discovered:1825 duration:121.7s
2026-09-17T10:10:18.693Z [fetch] trigger:cron processed:500 priceChanges:382 errors:0 total:500 apiMissing:0 contaminated:0 fetchFail:0 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:0 highErrorRate:false duration:18.6s
2026-09-17T10:25:38.304Z [fullscan] duration:1528.6s ok:true grandTotal:82 sites:{"maniax":79,"bl":3}
2026-09-17T10:26:13.955Z [pushdebug] duration:11.3s ok:true files:12
2026-09-17T10:56:04.569Z [all] duration:1831.4s ok:true discovered:0 processed:168163 priceChanges:103488 errors:43 total:168206 apiMissing:16 contaminated:0 fetchFail:27 storeError:0 verifiedAlive:27 autoThrottled:false rateLimit:700 concurrency:3 errorRate:0 highErrorRate:false stopped:true
2026-09-17T11:10:12.754Z [fetch] trigger:cron processed:0 priceChanges:0 errors:0 total:0 apiMissing:0 contaminated:0 fetchFail:0 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:null highErrorRate:false duration:12.1s
2026-09-17T11:20:12.238Z [fetch] trigger:cron processed:0 priceChanges:0 errors:0 total:0 apiMissing:0 contaminated:0 fetchFail:0 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:null highErrorRate:false duration:11.3s
2026-09-17T11:30:12.508Z [fetch] trigger:cron processed:0 priceChanges:0 errors:0 total:0 apiMissing:0 contaminated:0 fetchFail:0 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:null highErrorRate:false duration:11.7s
2026-09-17T11:40:13.825Z [fetch] trigger:cron processed:0 priceChanges:0 errors:0 total:0 apiMissing:0 contaminated:0 fetchFail:0 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:null highErrorRate:false duration:13.0s
2026-09-17T12:10:19.060Z [fetch] trigger:cron processed:404 priceChanges:0 errors:0 total:404 apiMissing:0 contaminated:0 fetchFail:0 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:0 highErrorRate:false duration:18.1s
2026-09-17T12:20:18.299Z [fetch] trigger:cron processed:485 priceChanges:0 errors:0 total:485 apiMissing:0 contaminated:0 fetchFail:0 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:0 highErrorRate:false duration:17.3s
2026-09-17T12:30:19.124Z [fetch] trigger:cron processed:500 priceChanges:0 errors:0 total:500 apiMissing:0 contaminated:0 fetchFail:0 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:0 highErrorRate:false duration:19.1s
2026-09-17T12:40:18.144Z [fetch] trigger:cron processed:500 priceChanges:0 errors:0 total:500 apiMissing:0 contaminated:0 fetchFail:0 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:0 highErrorRate:false duration:17.6s
2026-09-17T13:10:18.013Z [fetch] trigger:cron processed:500 priceChanges:0 errors:0 total:500 apiMissing:0 contaminated:0 fetchFail:0 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:0 highErrorRate:false duration:17.4s
2026-09-17T17:00:20.743Z [fetch] trigger:cron processed:500 priceChanges:1 errors:0 total:500 apiMissing:0 contaminated:0 fetchFail:0 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:0 highErrorRate:false duration:20.6s
2026-09-17T17:03:14.900Z [fullscan] duration:823.0s ok:true grandTotal:3 sites:{"maniax":3}
2026-09-18T11:46:30.651Z [fetch] trigger:startup processed:500 priceChanges:414 errors:0 total:500 apiMissing:0 contaminated:0 fetchFail:0 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:0 highErrorRate:false duration:20.4s
2026-09-18T11:48:24.972Z [discover] trigger:startup discovered:2031 duration:140.1s
2026-09-18T11:50:22.223Z [fetch] trigger:cron processed:500 priceChanges:393 errors:0 total:500 apiMissing:0 contaminated:0 fetchFail:0 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:0 highErrorRate:false duration:21.3s
2026-09-18T13:11:08.222Z [fullscan] duration:4916.0s ok:true grandTotal:20 sites:{"maniax":2,"bl":0,"girls":18}
2026-09-18T23:49:29.772Z [pushdebug] duration:12.9s ok:true files:12
2026-09-18T23:50:59.770Z [fetch] trigger:startup processed:500 priceChanges:1 errors:0 total:500 apiMissing:0 contaminated:0 fetchFail:0 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:0 highErrorRate:false duration:7.7s
2026-09-18T23:53:35.740Z [discover] trigger:startup discovered:3576 duration:169.4s
2026-09-19T14:34:43.533Z [all] duration:52976.0s ok:true discovered:0 processed:251750 priceChanges:39115 errors:846 total:252596 apiMissing:14 contaminated:0 fetchFail:832 storeError:0 verifiedAlive:4 autoThrottled:false rateLimit:1500 concurrency:2 withinRunThrottled:true errorRate:0.003 highErrorRate:false stopped:false
2026-09-20T01:50:27.789Z [fetch] trigger:cron processed:500 priceChanges:1 errors:0 total:500 apiMissing:0 contaminated:0 fetchFail:0 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:0 highErrorRate:false duration:27.3s
2026-09-20T03:04:55.236Z [all] duration:1961.4s ok:true discovered:6057 processed:154017 priceChanges:6535 errors:31 total:154048 apiMissing:4 contaminated:0 fetchFail:27 storeError:0 verifiedAlive:22 autoThrottled:false rateLimit:700 concurrency:3 errorRate:0 highErrorRate:false stopped:false
2026-09-20T03:07:13.259Z [all] duration:129.0s ok:true discovered:1599 processed:1645 priceChanges:1595 errors:0 total:1645 apiMissing:0 contaminated:0 fetchFail:0 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:0 highErrorRate:false stopped:false
2026-09-20T04:08:15.021Z [all] duration:90.1s ok:true discovered:0 processed:490 priceChanges:0 errors:0 total:490 apiMissing:0 contaminated:0 fetchFail:0 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:0 highErrorRate:false stopped:false
2026-09-20T04:45:50.157Z [endingsoon] duration:40.7s ok:true grandTotal:367 newCount:268 boostedCount:367 sites:{"maniax":311,"girls":28,"bl":28}
2026-09-20T05:36:13.982Z [newrelease] duration:60.9s ok:true grandTotal:216 sites:{"maniax":150,"girls":37,"bl":29}
2026-09-20T06:10:32.670Z [fetch] trigger:cron processed:467 priceChanges:286 errors:33 total:500 apiMissing:2 contaminated:0 fetchFail:31 storeError:0 verifiedAlive:29 autoThrottled:false rateLimit:700 concurrency:3 errorRate:0.066 highErrorRate:false duration:32.6s
2026-09-20T09:30:25.722Z [fetch] trigger:cron processed:428 priceChanges:0 errors:72 total:500 apiMissing:3 contaminated:0 fetchFail:69 storeError:0 verifiedAlive:17 autoThrottled:false rateLimit:700 concurrency:3 errorRate:0.144 highErrorRate:false duration:24.8s
2026-09-20T09:40:22.829Z [fetch] trigger:cron processed:500 priceChanges:0 errors:0 total:500 apiMissing:0 contaminated:0 fetchFail:0 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:0 highErrorRate:false duration:21.8s
2026-09-20T09:50:24.112Z [fetch] trigger:cron processed:500 priceChanges:0 errors:0 total:500 apiMissing:0 contaminated:0 fetchFail:0 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:0 highErrorRate:false duration:23.2s
2026-09-20T10:00:24.483Z [fetch] trigger:cron processed:500 priceChanges:1 errors:0 total:500 apiMissing:0 contaminated:0 fetchFail:0 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:0 highErrorRate:false duration:23.5s
2026-09-20T10:10:24.186Z [fetch] trigger:cron processed:466 priceChanges:2 errors:34 total:500 apiMissing:0 contaminated:0 fetchFail:34 storeError:0 verifiedAlive:1 autoThrottled:false rateLimit:700 concurrency:3 errorRate:0.068 highErrorRate:false duration:23.2s
2026-09-20T12:24:03.182Z [all] duration:2061.6s ok:true discovered:2782 processed:156750 priceChanges:2878 errors:28 total:156778 apiMissing:4 contaminated:0 fetchFail:24 storeError:0 verifiedAlive:24 autoThrottled:false rateLimit:700 concurrency:3 errorRate:0 highErrorRate:false stopped:false
2026-09-20T14:10:24.557Z [fetch] trigger:cron processed:500 priceChanges:0 errors:0 total:500 apiMissing:0 contaminated:0 fetchFail:0 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:0 highErrorRate:false duration:24.5s
```

## 直近のWARN/ERROR（最大60件・同種メッセージは集約済み）
```
2026-09-20T23:33:55.939Z [ERROR] [detail] API fetch error HTTP 503 maniax 50件
2026-09-20T23:33:55.939Z [WARN] [detail] batch fail, splitting 50
2026-09-20T23:34:26.695Z [WARN] [fetch] 503 throttle – wait 1500ms https://www.dlsite.com/maniax/product/info/ajax?product_id%5B%5D=RJ004224&product_id%5B%5D=RJ016414&product_id%5B%5D=RJ016413&product_id%5B%5D=RJ016412&product_id%5B%5D=RJ016411&product_id%5B%5D=RJ016410&product_id%5B%5D=RJ016409&product_id%5B%5D=RJ016508&product_i
2026-09-20T23:34:26.695Z [WARN] [fetch] network pause (系統:detail): waiting 30s
2026-09-20T23:34:56.902Z [WARN] [fetch] 503 throttle – wait 2726ms https://www.dlsite.com/maniax/product/info/ajax?product_id%5B%5D=RJ017601&product_id%5B%5D=RJ017612&product_id%5B%5D=RJ017600&product_id%5B%5D=RJ017599&product_id%5B%5D=RJ017593&product_id%5B%5D=RJ017541&product_id%5B%5D=RJ004494&product_id%5B%5D=RJ004495&product_i
2026-09-20T23:34:56.903Z [WARN] [fetch] network pause (系統:detail): waiting 30s
2026-09-20T23:35:27.019Z [WARN] [fetch] 503 throttle – wait 5383ms https://www.dlsite.com/maniax/product/info/ajax?product_id%5B%5D=RJ020985&product_id%5B%5D=RJ020943&product_id%5B%5D=RJ019335&product_id%5B%5D=RJ004905&product_id%5B%5D=RJ004904&product_id%5B%5D=RJ004885&product_id%5B%5D=RJ019248&product_id%5B%5D=RJ004882&product_i
2026-09-20T23:35:27.019Z [WARN] [fetch] network pause (系統:detail): waiting 30s
2026-09-20T23:35:57.068Z [WARN] [fetch] 503 throttle – wait 14322ms https://www.dlsite.com/maniax/product/info/ajax?product_id%5B%5D=RJ004224&product_id%5B%5D=RJ016414&product_id%5B%5D=RJ016413&product_id%5B%5D=RJ016412&product_id%5B%5D=RJ016411&product_id%5B%5D=RJ016410&product_id%5B%5D=RJ016409&product_id%5B%5D=RJ016508&product_
2026-09-20T23:35:57.068Z [ERROR] [detail] API fetch error HTTP 503 maniax 25件
2026-09-20T23:35:57.086Z [ERROR] [detail] API fetch error HTTP 503 maniax 25件
2026-09-20T23:35:57.096Z [ERROR] [detail] API fetch error HTTP 503 maniax 25件
2026-09-20T23:35:57.792Z [WARN] [fetch] network pause (系統:detail): waiting 30s
2026-09-20T23:36:27.764Z [WARN] [fetch] 503 throttle – wait 1724ms https://www.dlsite.com/maniax/product/info/ajax?product_id%5B%5D=RJ016992&product_id%5B%5D=RJ004371&product_id%5B%5D=RJ016963&product_id%5B%5D=RJ016926&product_id%5B%5D=RJ004359&product_id%5B%5D=RJ016861&product_id%5B%5D=RJ016855&product_id%5B%5D=RJ016836&product_i
2026-09-20T23:36:27.764Z [WARN] [fetch] network pause (系統:detail): waiting 30s
2026-09-20T23:36:58.066Z [WARN] [fetch] 503 throttle – wait 2729ms https://www.dlsite.com/maniax/product/info/ajax?product_id%5B%5D=RJ016992&product_id%5B%5D=RJ004371&product_id%5B%5D=RJ016963&product_id%5B%5D=RJ016926&product_id%5B%5D=RJ004359&product_id%5B%5D=RJ016861&product_id%5B%5D=RJ016855&product_id%5B%5D=RJ016836&product_i
2026-09-20T23:36:58.067Z [WARN] [fetch] network pause (系統:detail): waiting 30s
2026-09-20T23:37:28.148Z [WARN] [fetch] 503 throttle – wait 5455ms https://www.dlsite.com/maniax/product/info/ajax?product_id%5B%5D=RJ016992&product_id%5B%5D=RJ004371&product_id%5B%5D=RJ016963&product_id%5B%5D=RJ016926&product_id%5B%5D=RJ004359&product_id%5B%5D=RJ016861&product_id%5B%5D=RJ016855&product_id%5B%5D=RJ016836&product_i
2026-09-20T23:37:28.148Z [WARN] [fetch] network pause (系統:detail): waiting 30s
2026-09-20T23:37:58.241Z [WARN] [fetch] 503 throttle – wait 10048ms https://www.dlsite.com/maniax/product/info/ajax?product_id%5B%5D=RJ018828&product_id%5B%5D=RJ018780&product_id%5B%5D=RJ018771&product_id%5B%5D=RJ018755&product_id%5B%5D=RJ004775&product_id%5B%5D=RJ004774&product_id%5B%5D=RJ018634&product_id%5B%5D=RJ018518&product_
2026-09-20T23:37:58.242Z [ERROR] [detail] API fetch error HTTP 503 maniax 25件
2026-09-20T23:37:58.291Z [ERROR] [detail] API fetch error HTTP 503 maniax 25件
2026-09-20T23:37:58.303Z [ERROR] [detail] API fetch error HTTP 503 maniax 25件
2026-09-20T23:37:58.931Z [WARN] [fetch] network pause (系統:detail): waiting 30s
2026-09-20T23:38:29.180Z [WARN] [fetch] 503 throttle – wait 1649ms https://www.dlsite.com/maniax/product/info/ajax?product_id%5B%5D=RJ015515&product_id%5B%5D=RJ015362&product_id%5B%5D=RJ015293&product_id%5B%5D=RJ015270&product_id%5B%5D=RJ015198&product_id%5B%5D=RJ015140&product_id%5B%5D=RJ015074&product_id%5B%5D=RJ015023&product_i
2026-09-20T23:38:29.180Z [WARN] [fetch] network pause (系統:detail): waiting 30s
2026-09-20T23:38:59.240Z [WARN] [fetch] 503 throttle – wait 2801ms https://www.dlsite.com/maniax/product/info/ajax?product_id%5B%5D=RJ015515&product_id%5B%5D=RJ015362&product_id%5B%5D=RJ015293&product_id%5B%5D=RJ015270&product_id%5B%5D=RJ015198&product_id%5B%5D=RJ015140&product_id%5B%5D=RJ015074&product_id%5B%5D=RJ015023&product_i
2026-09-20T23:38:59.240Z [WARN] [fetch] network pause (系統:detail): waiting 30s
2026-09-20T23:39:29.316Z [WARN] [fetch] 503 throttle – wait 7093ms https://www.dlsite.com/maniax/product/info/ajax?product_id%5B%5D=RJ015515&product_id%5B%5D=RJ015362&product_id%5B%5D=RJ015293&product_id%5B%5D=RJ015270&product_id%5B%5D=RJ015198&product_id%5B%5D=RJ015140&product_id%5B%5D=RJ015074&product_id%5B%5D=RJ015023&product_i
2026-09-20T23:39:29.316Z [WARN] [fetch] network pause (系統:detail): waiting 30s
2026-09-20T23:39:59.368Z [WARN] [fetch] 503 throttle – wait 12727ms https://www.dlsite.com/maniax/product/info/ajax?product_id%5B%5D=RJ015515&product_id%5B%5D=RJ015362&product_id%5B%5D=RJ015293&product_id%5B%5D=RJ015270&product_id%5B%5D=RJ015198&product_id%5B%5D=RJ015140&product_id%5B%5D=RJ015074&product_id%5B%5D=RJ015023&product_
2026-09-20T23:39:59.368Z [ERROR] [detail] API fetch error HTTP 503 maniax 34件
2026-09-20T23:40:00.080Z [WARN] [fetch] network pause (系統:detail): waiting 30s
2026-09-20T23:40:29.427Z [WARN] [fetch] 503 throttle – wait 1215ms https://www.dlsite.com/maniax/product/info/ajax?product_id%5B%5D=RJ015515&product_id%5B%5D=RJ015362&product_id%5B%5D=RJ015293&product_id%5B%5D=RJ015270&product_id%5B%5D=RJ015198&product_id%5B%5D=RJ015140&product_id%5B%5D=RJ015074&product_id%5B%5D=RJ015023&product_i
2026-09-20T23:40:29.428Z [WARN] [fetch] network pause (系統:detail): waiting 30s
2026-09-20T23:40:59.478Z [WARN] [fetch] 503 throttle – wait 3035ms https://www.dlsite.com/maniax/product/info/ajax?product_id%5B%5D=RJ015515&product_id%5B%5D=RJ015362&product_id%5B%5D=RJ015293&product_id%5B%5D=RJ015270&product_id%5B%5D=RJ015198&product_id%5B%5D=RJ015140&product_id%5B%5D=RJ015074&product_id%5B%5D=RJ015023&product_i
2026-09-20T23:40:59.478Z [WARN] [fetch] network pause (系統:detail): waiting 30s
2026-09-20T23:41:29.646Z [WARN] [fetch] 503 throttle – wait 5817ms https://www.dlsite.com/maniax/product/info/ajax?product_id%5B%5D=RJ015515&product_id%5B%5D=RJ015362&product_id%5B%5D=RJ015293&product_id%5B%5D=RJ015270&product_id%5B%5D=RJ015198&product_id%5B%5D=RJ015140&product_id%5B%5D=RJ015074&product_id%5B%5D=RJ015023&product_i
2026-09-20T23:41:29.647Z [WARN] [fetch] network pause (系統:detail): waiting 30s
2026-09-20T23:41:59.726Z [WARN] [fetch] 503 throttle – wait 12459ms https://www.dlsite.com/maniax/product/info/ajax?product_id%5B%5D=RJ015515&product_id%5B%5D=RJ015362&product_id%5B%5D=RJ015293&product_id%5B%5D=RJ015270&product_id%5B%5D=RJ015198&product_id%5B%5D=RJ015140&product_id%5B%5D=RJ015074&product_id%5B%5D=RJ015023&product_
2026-09-20T23:41:59.727Z [ERROR] [detail] API fetch error HTTP 503 maniax 34件
2026-09-20T23:41:59.727Z [WARN] [detail] batch fail, splitting 34
2026-09-20T23:41:59.729Z [WARN] [fetch] network pause (系統:detail): waiting 30s
2026-09-20T23:42:30.494Z [WARN] [fetch] 503 throttle – wait 1202ms https://www.dlsite.com/maniax/product/info/ajax?product_id%5B%5D=RJ015515&product_id%5B%5D=RJ015362&product_id%5B%5D=RJ015293&product_id%5B%5D=RJ015270&product_id%5B%5D=RJ015198&product_id%5B%5D=RJ015140&product_id%5B%5D=RJ015074&product_id%5B%5D=RJ015023&product_i
2026-09-20T23:42:30.494Z [WARN] [fetch] network pause (系統:detail): waiting 30s
2026-09-20T23:43:00.564Z [WARN] [fetch] 503 throttle – wait 2841ms https://www.dlsite.com/maniax/product/info/ajax?product_id%5B%5D=RJ015515&product_id%5B%5D=RJ015362&product_id%5B%5D=RJ015293&product_id%5B%5D=RJ015270&product_id%5B%5D=RJ015198&product_id%5B%5D=RJ015140&product_id%5B%5D=RJ015074&product_id%5B%5D=RJ015023&product_i
2026-09-20T23:43:00.564Z [WARN] [fetch] network pause (系統:detail): waiting 30s
2026-09-20T23:43:30.621Z [WARN] [fetch] 503 throttle – wait 7049ms https://www.dlsite.com/maniax/product/info/ajax?product_id%5B%5D=RJ015515&product_id%5B%5D=RJ015362&product_id%5B%5D=RJ015293&product_id%5B%5D=RJ015270&product_id%5B%5D=RJ015198&product_id%5B%5D=RJ015140&product_id%5B%5D=RJ015074&product_id%5B%5D=RJ015023&product_i
2026-09-20T23:43:30.622Z [WARN] [fetch] network pause (系統:detail): waiting 30s
2026-09-20T23:44:00.681Z [WARN] [fetch] 503 throttle – wait 10044ms https://www.dlsite.com/maniax/product/info/ajax?product_id%5B%5D=RJ015515&product_id%5B%5D=RJ015362&product_id%5B%5D=RJ015293&product_id%5B%5D=RJ015270&product_id%5B%5D=RJ015198&product_id%5B%5D=RJ015140&product_id%5B%5D=RJ015074&product_id%5B%5D=RJ015023&product_
2026-09-20T23:44:00.681Z [ERROR] [detail] API fetch error HTTP 503 maniax 17件
2026-09-20T23:44:01.397Z [WARN] [fetch] network pause (系統:detail): waiting 30s
2026-09-20T23:44:31.228Z [WARN] [fetch] 503 throttle – wait 1612ms https://www.dlsite.com/maniax/product/info/ajax?product_id%5B%5D=RJ014707&product_id%5B%5D=RJ014660&product_id%5B%5D=RJ014680&product_id%5B%5D=RJ014626&product_id%5B%5D=RJ014603&product_id%5B%5D=RJ014560&product_id%5B%5D=RJ014513&product_id%5B%5D=RJ014434&product_i
2026-09-20T23:44:31.229Z [WARN] [fetch] network pause (系統:detail): waiting 30s
2026-09-20T23:45:01.276Z [WARN] [fetch] 503 throttle – wait 3275ms https://www.dlsite.com/maniax/product/info/ajax?product_id%5B%5D=RJ014707&product_id%5B%5D=RJ014660&product_id%5B%5D=RJ014680&product_id%5B%5D=RJ014626&product_id%5B%5D=RJ014603&product_id%5B%5D=RJ014560&product_id%5B%5D=RJ014513&product_id%5B%5D=RJ014434&product_i
2026-09-20T23:45:01.276Z [WARN] [fetch] network pause (系統:detail): waiting 30s
2026-09-20T23:45:31.321Z [WARN] [fetch] 503 throttle – wait 5393ms https://www.dlsite.com/maniax/product/info/ajax?product_id%5B%5D=RJ014707&product_id%5B%5D=RJ014660&product_id%5B%5D=RJ014680&product_id%5B%5D=RJ014626&product_id%5B%5D=RJ014603&product_id%5B%5D=RJ014560&product_id%5B%5D=RJ014513&product_id%5B%5D=RJ014434&product_i
2026-09-20T23:45:31.321Z [WARN] [fetch] network pause (系統:detail): waiting 30s
2026-09-20T23:46:01.382Z [WARN] [fetch] 503 throttle – wait 13688ms https://www.dlsite.com/maniax/product/info/ajax?product_id%5B%5D=RJ014707&product_id%5B%5D=RJ014660&product_id%5B%5D=RJ014680&product_id%5B%5D=RJ014626&product_id%5B%5D=RJ014603&product_id%5B%5D=RJ014560&product_id%5B%5D=RJ014513&product_id%5B%5D=RJ014434&product_
2026-09-20T23:46:01.382Z [ERROR] [detail] API fetch error HTTP 503 maniax 17件
```

## さらに詳しく調べるには
- `latest.log` — 全ログ末尾（時系列で追いたい時）
- `latest-error.log` — WARN/ERRORのみ末尾
- `digest-recent.log` — ジョブ実行ごとの1行要約
- `events-recent.jsonl` — 構造化ログ(JSON Lines)。level/job/msgで機械的にgrep・フィルタ可能
- `price-issues.json` — 定価が信頼できる形で取得できなかった作品一覧
- `api-trace-recent.json` — 異常APIレスポンス(空応答/severely-partial/CDN汚染/非200)の生サンプル直近50件
- `warmup-history-recent.json` — 年齢確認セッション再確立(warmUp)の直近30回分の履歴（周期性の確認用）
- `locks-snapshot.json` — push時点でのジョブロック/中断シグナルの状態
