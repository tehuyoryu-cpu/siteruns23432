# デバッグサマリ（自動生成）

- 生成日時: 2026-09-12T15:00:01.934Z
- トリガージョブ: detail
- 直近の実行結果: `{"processed":0,"priceChanges":0,"errors":0,"total":0,"apiMissing":0,"contaminated":0,"fetchFail":0,"storeError":0,"verifiedAlive":0,"autoThrottled":false,"rateLimit":700,"concurrency":3,"errorRate":null,"highErrorRate":false}`
- 実行環境: v1.0.0 / Node v20.18.0 / Electron 31.7.7 / win32-x64
- ビルド元コミット: `4dd3277d1c56fd6ce2df32a99f62c9b7eb960500`（ビルド日時: 2026-09-12T00:07:32Z / run #388）
  ⚠ 原因調査時は、まず `git log` でこのSHAがmain HEADと一致しているか確認してください。古いビルドの場合、main上では既に修正済みの不具合を調べていることがあります。

## DB統計
- 追跡作品数: 74372
- セール中: 73217
- 確認待ち(due): 0
- 価格記録数: 142553
- サークル数: 9544（うちセール中: 9406）
- 定価取得エラー件数: 412

## データ汚染サニティスキャン（works.cur_* の矛盾レコード件数）
- sale_price >= price（矛盾）: 0
- discount_rateありでsale_price無し: 0
- price=0なのにis_on_sale=1: 51
- 価格が負の値: 0
- 割引率が0〜100%の範囲外: 0
⚠ 合計51件の汚染疑いレコードが残っています。起動時に自動修復(repairContaminatedPriceData)が走るはずなので、直近に再起動していない場合はアプリの再起動を検討してください。

## warmUpセッション診断ヒストリの傾向（直近7回、プロセス起動以降）
年齢確認Cookie取得の成否をサイトごとに積算したもの。周期的なセッション切れか、単発の一時的な失敗かをここで判別できる（生データは warmup-history-recent.json）。
- maniax: 7/7回成功 (100%)
- bl: 7/7回成功 (100%)
- girls: 7/7回成功 (100%)

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
    "lastRewarmAt": "2026-09-12T13:26:47.685Z",
    "cooldownRemainingSec": 0
  },
  "autoThrottle": {
    "all": {
      "consecutiveHighErrorRuns": 0,
      "active": false,
      "lastRunFinishedAt": "2026-09-12T13:28:18.792Z"
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
2026-09-04T23:23:56.720Z [fetch] trigger:startup processed:500 priceChanges:486 errors:0 total:500 apiMissing:0 contaminated:0 fetchFail:0 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:0 highErrorRate:false duration:6.3s
2026-09-04T23:25:14.674Z [discover] trigger:startup discovered:1128 duration:89.2s
2026-09-04T23:30:09.006Z [fetch] trigger:cron processed:499 priceChanges:499 errors:1 total:500 apiMissing:1 contaminated:0 fetchFail:0 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:0.002 highErrorRate:false duration:8.7s
2026-09-04T23:40:08.616Z [fetch] trigger:cron processed:500 priceChanges:500 errors:0 total:500 apiMissing:0 contaminated:0 fetchFail:0 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:0 highErrorRate:false duration:8.1s
2026-09-04T23:41:18.296Z [fullscan] duration:1096.3s ok:true grandTotal:54616 sites:{"maniax":396,"girls":54220}
2026-09-05T00:10:09.119Z [fetch] trigger:cron processed:500 priceChanges:500 errors:0 total:500 apiMissing:0 contaminated:0 fetchFail:0 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:0 highErrorRate:false duration:8.2s
2026-09-05T00:20:05.336Z [fetch] trigger:cron processed:500 priceChanges:500 errors:0 total:500 apiMissing:0 contaminated:0 fetchFail:0 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:0 highErrorRate:false duration:4.5s
2026-09-05T00:25:07.476Z [circlegap] duration:1204.4s ok:true checked:370 totalMissing:647 missingByCircle:{"RG01000310":2,"RG01000418":3,"RG01000457":1,"RG01000772":6,"RG01000875":17,"RG01000937":20,"RG01001049":3,"RG01001128":3,"RG01001187":1,"RG01001209":2,"RG01001328":3,"RG01001631":4,"RG01001994":20,"RG01002054":3,"RG01002181":1,"RG01002381":1,"RG01002545":4,"RG01002873":3,"RG01002894":1,"RG01003004":1,"RG01003110":1,"RG01003303":3,"RG01003406":1,"RG01003486":1,"RG01003541":15,"RG01003621":2,"RG01003846":1,"RG01004049":5,"RG01004104":106,"RG01004208":6,"RG01004464":3,"RG01004534":2,"RG01004557":12,"RG01004617":20,"RG01004668":3,"RG01004777":3,"RG01005234":2,"RG01005383":1,"RG01005392":8,"RG01005421":1,"RG01005772":3,"RG01005861":3,"RG01005886":1,"RG01005939":1,"RG01005945":4,"RG01006015":1,"RG01006110":165,"RG01006146":1,"RG01006148":1,"RG01006213":8,"RG01006291":1,"RG01006300":2,"RG01006496":1,"RG01006499":1,"RG01006582":5,"RG01007156":6,"RG01007299":2,"RG01007680":16,"RG01007694":1,"RG01007939":23,"RG01007940":2,"RG01008314":1,"RG01008451":1,"RG01008542":3,"RG01008767":1,"RG01008799":1,"RG01008964":4,"RG01009019":57,"RG01009140":32,"RG01009160":1,"RG01009376":2,"RG01009393":1} skippedInvalidSite:0 totalCircles:5160 resumedFromPrevious:false timedOut:true stopped:false
2026-09-05T00:30:07.811Z [fetch] trigger:cron processed:500 priceChanges:500 errors:0 total:500 apiMissing:0 contaminated:0 fetchFail:0 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:0 highErrorRate:false duration:7.5s
2026-09-05T01:14:46.216Z [all] duration:2163.9s ok:true discovered:333 processed:52858 priceChanges:52519 errors:866 total:53724 apiMissing:866 contaminated:0 fetchFail:0 storeError:0 verifiedAlive:0 autoThrottled:false rateLimit:700 concurrency:3 errorRate:0.016 highErrorRate:false stopped:false
2026-09-05T01:23:21.579Z [pushdata] duration:6.0s ok:false error:tree create failed (chunk 0〜149件目): HTTP 401 {
  "message": "Bad credentials",
  "documentation_url": "https://docs.github.com/rest",
  "status": "401"
}
2026-09-05T01:23:25.168Z [pushdebug] duration:1.1s ok:false skipped:false error:blob create failed (latest.log): HTTP 401 {
  "message": "Bad credentials",
  "documentation_url": "https://docs.github.com/rest",
  "status": "401"
}
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
```

## 直近のWARN/ERROR（最大60件・同種メッセージは集約済み）
```
2026-09-12T13:24:28.287Z [WARN] [detail] batch issues summary {"site":"bl","batchSize":50,"ana_no_standalone_price":1}
2026-09-12T13:25:08.386Z [WARN] (集約 ×53) [detail] price issue detected RJ01162575 ana_no_standalone_price {"is_ana":true,"price_str":"0","upgrade_min_price":110}
2026-09-12T13:25:08.386Z [ERROR] (集約 ×53) [detail] price unmeasurable — skipping DB write to avoid contamination RJ01162575 {"issueType":"ana_no_standalone_price","raw":{"is_ana":true,"price_str":"0","upgrade_min_price":110}}
2026-09-12T13:25:08.386Z [WARN] (集約 ×6) [detail] batch issues summary {"site":"bl","batchSize":50,"ana_no_standalone_price":1}
2026-09-12T13:25:08.386Z [WARN] (集約 ×6) [detail] batch issues summary {"site":"girls","batchSize":50,"ana_no_standalone_price":1}
2026-09-12T13:25:08.387Z [WARN] (集約 ×10) [detail] batch issues summary {"site":"maniax","batchSize":50,"ana_no_standalone_price":2}
2026-09-12T13:25:30.309Z [WARN] [detail] price issue detected RJ01263651 ana_no_standalone_price {"is_ana":true,"price_str":"0","upgrade_min_price":110}
2026-09-12T13:25:30.309Z [ERROR] [detail] price unmeasurable — skipping DB write to avoid contamination RJ01263651 {"issueType":"ana_no_standalone_price","raw":{"is_ana":true,"price_str":"0","upgrade_min_price":110}}
2026-09-12T13:25:30.311Z [WARN] [detail] price issue detected RJ01209766 ana_no_standalone_price {"is_ana":true,"price_str":"0","upgrade_min_price":110}
2026-09-12T13:25:30.311Z [ERROR] [detail] price unmeasurable — skipping DB write to avoid contamination RJ01209766 {"issueType":"ana_no_standalone_price","raw":{"is_ana":true,"price_str":"0","upgrade_min_price":110}}
2026-09-12T13:25:30.312Z [WARN] [detail] price issue detected RJ01707390 ana_no_standalone_price {"is_ana":true,"price_str":"0","upgrade_min_price":110}
2026-09-12T13:25:30.312Z [ERROR] [detail] price unmeasurable — skipping DB write to avoid contamination RJ01707390 {"issueType":"ana_no_standalone_price","raw":{"is_ana":true,"price_str":"0","upgrade_min_price":110}}
2026-09-12T13:25:30.355Z [WARN] [detail] batch issues summary {"site":"maniax","batchSize":36,"ana_no_standalone_price":3}
2026-09-12T13:25:32.396Z [WARN] [detail] batch issues summary {"site":"bl","batchSize":50,"ana_no_standalone_price":1}
2026-09-12T13:25:34.346Z [WARN] [detail] batch issues summary {"site":"girls","batchSize":50,"ana_no_standalone_price":5}
2026-09-12T13:25:36.934Z [WARN] [detail] batch issues summary {"site":"girls","batchSize":50,"ana_no_standalone_price":2}
2026-09-12T13:25:37.339Z [WARN] [detail] batch issues summary {"site":"girls","batchSize":50,"ana_no_standalone_price":1}
2026-09-12T13:26:08.395Z [WARN] (集約 ×14) [detail] price issue detected RJ01263651 ana_no_standalone_price {"is_ana":true,"price_str":"0","upgrade_min_price":110}
2026-09-12T13:26:08.396Z [ERROR] (集約 ×14) [detail] price unmeasurable — skipping DB write to avoid contamination RJ01263651 {"issueType":"ana_no_standalone_price","raw":{"is_ana":true,"price_str":"0","upgrade_min_price":110}}
2026-09-12T13:26:08.396Z [WARN] (集約 ×5) [detail] batch issues summary {"site":"girls","batchSize":50,"ana_no_standalone_price":5}
2026-09-12T13:26:14.851Z [WARN] [detail] price issue detected RJ01716655 ana_no_standalone_price {"is_ana":true,"price_str":"0","upgrade_min_price":110}
2026-09-12T13:26:14.851Z [ERROR] [detail] price unmeasurable — skipping DB write to avoid contamination RJ01716655 {"issueType":"ana_no_standalone_price","raw":{"is_ana":true,"price_str":"0","upgrade_min_price":110}}
2026-09-12T13:26:14.864Z [WARN] [detail] batch issues summary {"site":"girls","batchSize":50,"ana_no_standalone_price":1}
2026-09-12T13:26:14.912Z [WARN] [detail] price issue detected RJ01676787 ana_no_standalone_price {"is_ana":true,"price_str":"0","upgrade_min_price":110}
2026-09-12T13:26:14.912Z [ERROR] [detail] price unmeasurable — skipping DB write to avoid contamination RJ01676787 {"issueType":"ana_no_standalone_price","raw":{"is_ana":true,"price_str":"0","upgrade_min_price":110}}
2026-09-12T13:26:14.913Z [WARN] [detail] price issue detected RJ01714731 ana_no_standalone_price {"is_ana":true,"price_str":"0","upgrade_min_price":110}
2026-09-12T13:26:14.913Z [ERROR] [detail] price unmeasurable — skipping DB write to avoid contamination RJ01714731 {"issueType":"ana_no_standalone_price","raw":{"is_ana":true,"price_str":"0","upgrade_min_price":110}}
2026-09-12T13:26:14.969Z [WARN] [detail] batch issues summary {"site":"maniax","batchSize":50,"ana_no_standalone_price":3}
2026-09-12T13:26:16.023Z [WARN] [detail] batch issues summary {"site":"bl","batchSize":38,"ana_no_standalone_price":3}
2026-09-12T13:26:16.282Z [WARN] [detail] batch issues summary {"site":"bl","batchSize":50,"ana_no_standalone_price":3}
2026-09-12T13:26:16.942Z [WARN] [detail] batch issues summary {"site":"girls","batchSize":50,"ana_no_standalone_price":8}
2026-09-12T13:26:22.074Z [WARN] [detail] batch issues summary {"site":"maniax","batchSize":50,"ana_no_standalone_price":1}
2026-09-12T13:26:38.028Z [WARN] [detail] batch issues summary {"site":"maniax","batchSize":50,"ana_no_standalone_price":1}
2026-09-12T13:26:45.308Z [WARN] [detail] API returned empty object girls requested 50件 sample: RJ01628095,RJ01040411
2026-09-12T13:26:46.044Z [WARN] [detail] API returned empty object girls requested 50件 sample: RJ01628095,RJ01040411
2026-09-12T13:26:46.045Z [WARN] [detail] batch fail, splitting 50
2026-09-12T13:26:46.112Z [WARN] [detail] API returned partial data girls got 19 / requested 50
2026-09-12T13:26:46.185Z [WARN] [detail] batch issues summary {"site":"girls","batchSize":50,"ana_no_standalone_price":5,"key_not_in_response":31}
2026-09-12T13:26:46.414Z [WARN] [detail] API response severely degraded (near-empty, discarding partial data as unreliable, counted toward recovery streak) girls got 1 / requested 50
2026-09-12T13:26:46.558Z [WARN] [detail] API returned empty object girls requested 25件 sample: RJ01628095,RJ01040411
2026-09-12T13:26:47.137Z [WARN] [detail] API response severely degraded (near-empty, discarding partial data as unreliable, counted toward recovery streak) girls got 1 / requested 50
2026-09-12T13:26:47.137Z [WARN] [detail] batch fail, splitting 50
2026-09-12T13:26:47.577Z [WARN] [detail] API response severely degraded (near-empty, discarding partial data as unreliable, counted toward recovery streak) girls got 1 / requested 25
2026-09-12T13:26:47.685Z [WARN] [detail] girls: 空応答が5回連続 — セッション再確立を試みます
2026-09-12T13:26:47.688Z [WARN] [warmUp] re-warmup triggered externally (repeated empty responses detected)
2026-09-12T13:27:08.399Z [WARN] (集約 ×29) [detail] price issue detected RJ01716655 ana_no_standalone_price {"is_ana":true,"price_str":"0","upgrade_min_price":110}
2026-09-12T13:27:08.400Z [ERROR] (集約 ×29) [detail] price unmeasurable — skipping DB write to avoid contamination RJ01716655 {"issueType":"ana_no_standalone_price","raw":{"is_ana":true,"price_str":"0","upgrade_min_price":110}}
2026-09-12T13:27:08.400Z [WARN] (集約 ×4) [detail] batch issues summary {"site":"maniax","batchSize":50,"ana_no_standalone_price":3}
2026-09-12T13:27:08.400Z [WARN] (集約 ×4) [detail] API returned empty object girls requested 50件 sample: RJ01628095,RJ01040411
2026-09-12T13:27:08.400Z [WARN] (集約 ×4) [detail] API response severely degraded (near-empty, discarding partial data as unreliable, counted toward recovery streak) girls got 1 / requested 50
2026-09-12T13:27:54.828Z [WARN] [detail] girls: 再ウォーム後も診断上はセッション健全(gate absent, cookie obtained) — セッション切れではなくレート制限の可能性が高いため、5分間このサイトへの並列度を抑制します
2026-09-12T13:28:18.790Z [WARN] [detail] all: 実行中に2ラウンド連続で高エラー率(直近ラウンド errorRate=1) を検出したため、この実行の残り分についてconcurrency/rateLimitを即座に引き下げます — concurrency 3→2 / rateLimit 700→1500ms
2026-09-12T13:50:01.292Z [WARN] [detail] API returned empty object girls requested 25件 sample: RJ01223548,RJ01121414
2026-09-12T13:50:02.021Z [WARN] [detail] API returned empty object girls requested 25件 sample: RJ01223548,RJ01121414
2026-09-12T13:50:02.025Z [WARN] [detail] batch fail, splitting 25
2026-09-12T13:50:02.438Z [WARN] [detail] API returned empty object girls requested 13件 sample: RJ01223548,RJ01121414
2026-09-12T13:50:08.574Z [WARN] (集約 ×4) [detail] API returned empty object girls requested 25件 sample: RJ01223548,RJ01121414
2026-09-12T14:45:00.293Z [WARN] [warmUp] re-warmup triggered externally (repeated empty responses detected)
2026-09-12T14:46:01.458Z [WARN] [warmUp] timeout diagnostics {"url":"https://www.dlsite.com/girls/work/=/product_id/RJ01137521.html/?translation=RJ01137522","title":"【簡体中文版】何でも知りたい研究員は我慢できない～教えてください、あなたの全てを～ [みんなで翻訳] | DLsite がるまに","readyState":"complete","bodyLen":394298,"isLoading":false}
2026-09-12T14:46:17.787Z [WARN] [warmUp] timeout diagnostics {"url":"https://www.dlsite.com/girls/work/=/product_id/RJ01137521.html/?translation=RJ01137522&locale=ja_JP","title":"【簡体中文版】何でも知りたい研究員は我慢できない～教えてください、あなたの全てを～ [みんなで翻訳] | DLsite がるまに","readyState":"complete","bodyLen":447965,"isLoading":false}
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
