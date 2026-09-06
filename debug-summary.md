# デバッグサマリ（自動生成）

- 生成日時: 2026-09-06T13:40:02.811Z
- トリガージョブ: detail
- 直近の実行結果: `{"processed":0,"priceChanges":0,"errors":2,"total":2,"apiMissing":0,"contaminated":0,"fetchFail":2,"storeError":0,"verifiedAlive":0,"autoThrottled":false,"rateLimit":700,"concurrency":3,"errorRate":null,"highErrorRate":false}`
- 実行環境: v1.0.0 / Node v20.18.0 / Electron 31.7.7 / win32-x64
- ビルド元コミット: `46b670a66df77d72541ed6cea5a2e5fcb4f389dc`（ビルド日時: 2026-09-06T12:47:02Z / run #376）
  ⚠ 原因調査時は、まず `git log` でこのSHAがmain HEADと一致しているか確認してください。古いビルドの場合、main上では既に修正済みの不具合を調べていることがあります。

## DB統計
- 追跡作品数: 59554
- セール中: 58508
- 確認待ち(due): 0
- 価格記録数: 103247
- サークル数: 6576（うちセール中: 6492）
- 定価取得エラー件数: 381

## warmUpセッション診断ヒストリの傾向（直近1回、プロセス起動以降）
年齢確認Cookie取得の成否をサイトごとに積算したもの。周期的なセッション切れか、単発の一時的な失敗かをここで判別できる（生データは warmup-history-recent.json）。
- maniax: 1/1回成功 (100%)
- bl: 1/1回成功 (100%)
- girls: 1/1回成功 (100%)

## セッション健全性スナップショット（サーキットブレーカー/自動スロットル）
これまでのWARN/ERRORログの文面だけからでは分からない「今まさにどういう抑制状態か」をそのままダンプしたもの。エラー急増の原因調査はまずここを見ると早い。
```json
{
  "perSite": {
    "girls": {
      "emptyStreak": 2,
      "circuitOpen": false,
      "rewarmInProgress": false,
      "rateLimitBackoffRemainingSec": 0,
      "rateLimitBackoffLevel": 0
    },
    "maniax": {
      "emptyStreak": 2,
      "circuitOpen": false,
      "rewarmInProgress": false,
      "rateLimitBackoffRemainingSec": 0,
      "rateLimitBackoffLevel": 0
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
    "lastRewarmAt": null,
    "cooldownRemainingSec": 0
  },
  "autoThrottle": {
    "all": {
      "consecutiveHighErrorRuns": 0,
      "active": false,
      "lastRunFinishedAt": "2026-09-06T13:29:30.163Z"
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
```

## 直近のWARN/ERROR（最大60件・同種メッセージは集約済み）
```
2026-09-06T13:23:42.460Z [WARN] [discovery] monthly: 疑わしい短ページ、次ページで確認します {"site":"maniax","date":"2026-09-01","page":1,"parsed":99}
2026-09-06T13:23:44.070Z [WARN] [discovery] monthly: 疑わしい短ページ、次ページで確認します {"site":"bl","date":"2026-09-01","page":1,"parsed":98}
2026-09-06T13:23:45.131Z [WARN] [discovery] monthly: 疑わしい短ページ、次ページで確認します {"site":"girls","date":"2026-09-01","page":1,"parsed":99}
2026-09-06T13:24:30.570Z [WARN] [warmUp] timeout diagnostics {"url":"https://www.dlsite.com/girls/work/=/product_id/RJ405853.html/?translation=RJ405854","title":"【55%OFF】【簡体中文版】片端の桜 [みんなで翻訳] | DLsite がるまに","readyState":"complete","bodyLen":324185,"isLoading":false}
2026-09-06T13:24:50.634Z [WARN] [scheduler] initial discovery skipped (already running)
2026-09-06T13:24:55.645Z [WARN] [scheduler] initial detail run skipped (already running)
2026-09-06T13:25:47.471Z [WARN] [db] slow transaction (transactionNoSave): 375ms {"dbSizeMB":28.4}
2026-09-06T13:25:57.398Z [WARN] [db] slow transaction (transactionNoSave): 322ms {"dbSizeMB":28.4}
2026-09-06T13:26:00.459Z [WARN] [detail] batch issues summary {"site":"bl","batchSize":50,"ana_no_standalone_price":1}
2026-09-06T13:26:03.367Z [WARN] [detail] batch issues summary {"site":"girls","batchSize":50,"ana_no_standalone_price":1}
2026-09-06T13:26:06.977Z [WARN] [detail] batch issues summary {"site":"girls","batchSize":50,"ana_no_standalone_price":1}
2026-09-06T13:26:07.907Z [WARN] [detail] batch issues summary {"site":"girls","batchSize":50,"ana_no_standalone_price":1}
2026-09-06T13:26:09.493Z [WARN] [detail] batch issues summary {"site":"bl","batchSize":50,"ana_no_standalone_price":1}
2026-09-06T13:26:18.373Z [WARN] [detail] batch issues summary {"site":"bl","batchSize":50,"ana_no_standalone_price":1}
2026-09-06T13:26:28.235Z [WARN] (集約 ×4) [detail] batch issues summary {"site":"bl","batchSize":50,"ana_no_standalone_price":1}
2026-09-06T13:26:28.236Z [WARN] (集約 ×6) [detail] batch issues summary {"site":"girls","batchSize":50,"ana_no_standalone_price":1}
2026-09-06T13:26:32.983Z [WARN] [detail] batch issues summary {"site":"girls","batchSize":50,"ana_no_standalone_price":1}
2026-09-06T13:26:47.259Z [WARN] [detail] batch issues summary {"site":"girls","batchSize":50,"ana_no_standalone_price":1}
2026-09-06T13:26:52.191Z [WARN] [detail] batch issues summary {"site":"girls","batchSize":50,"ana_no_standalone_price":1}
2026-09-06T13:27:00.484Z [WARN] [detail] batch issues summary {"site":"bl","batchSize":50,"ana_no_standalone_price":1}
2026-09-06T13:27:01.423Z [WARN] [detail] batch issues summary {"site":"bl","batchSize":50,"ana_no_standalone_price":1}
2026-09-06T13:27:28.240Z [WARN] (集約 ×6) [detail] batch issues summary {"site":"girls","batchSize":50,"ana_no_standalone_price":1}
2026-09-06T13:27:28.963Z [WARN] [detail] batch issues summary {"site":"girls","batchSize":50,"ana_no_standalone_price":1}
2026-09-06T13:27:30.764Z [WARN] [detail] batch issues summary {"site":"girls","batchSize":50,"ana_no_standalone_price":1}
2026-09-06T13:27:40.840Z [WARN] [detail] batch issues summary {"site":"girls","batchSize":50,"ana_no_standalone_price":1}
2026-09-06T13:27:45.907Z [WARN] [detail] batch issues summary {"site":"bl","batchSize":50,"ana_no_standalone_price":1}
2026-09-06T13:27:48.347Z [WARN] [db] slow transaction (transactionNoSave): 356ms {"dbSizeMB":28.4}
2026-09-06T13:27:59.258Z [WARN] [detail] batch issues summary {"site":"bl","batchSize":50,"ana_no_standalone_price":1}
2026-09-06T13:28:00.834Z [WARN] [detail] batch issues summary {"site":"bl","batchSize":25,"ana_no_standalone_price":1}
2026-09-06T13:28:28.247Z [WARN] (集約 ×8) [detail] batch issues summary {"site":"girls","batchSize":50,"ana_no_standalone_price":1}
2026-09-06T13:28:28.249Z [WARN] (集約 ×4) [detail] batch issues summary {"site":"bl","batchSize":50,"ana_no_standalone_price":1}
2026-09-06T13:28:29.070Z [WARN] [detail] batch issues summary {"site":"girls","batchSize":50,"ana_no_standalone_price":1}
2026-09-06T13:28:29.343Z [WARN] [detail] batch issues summary {"site":"bl","batchSize":50,"ana_no_standalone_price":1}
2026-09-06T13:28:35.554Z [WARN] [detail] batch issues summary {"site":"bl","batchSize":50,"ana_no_standalone_price":1}
2026-09-06T13:28:35.613Z [WARN] [detail] batch issues summary {"site":"maniax","batchSize":42,"ana_no_standalone_price":1}
2026-09-06T13:28:36.185Z [WARN] [detail] batch issues summary {"site":"girls","batchSize":50,"ana_no_standalone_price":1}
2026-09-06T13:28:38.672Z [WARN] [detail] batch issues summary {"site":"maniax","batchSize":50,"ana_no_standalone_price":2}
2026-09-06T13:28:38.849Z [WARN] [detail] batch issues summary {"site":"girls","batchSize":50,"ana_no_standalone_price":1}
2026-09-06T13:28:39.213Z [WARN] [detail] batch issues summary {"site":"maniax","batchSize":50,"ana_no_standalone_price":3}
2026-09-06T13:28:43.513Z [WARN] [detail] batch issues summary {"site":"bl","batchSize":50,"ana_no_standalone_price":1}
2026-09-06T13:29:15.628Z [WARN] [detail] batch issues summary {"site":"maniax","batchSize":50,"key_not_in_response":1,"ana_no_standalone_price":3}
2026-09-06T13:29:16.912Z [WARN] [db] slow transaction (transactionNoSave): 475ms {"dbSizeMB":28.5}
2026-09-06T13:29:17.227Z [WARN] [detail] batch issues summary {"site":"bl","batchSize":50,"ana_no_standalone_price":1,"key_not_in_response":2}
2026-09-06T13:29:18.433Z [WARN] [db] slow transaction (transactionNoSave): 442ms {"dbSizeMB":28.5}
2026-09-06T13:29:28.252Z [WARN] (集約 ×8) [detail] batch issues summary {"site":"girls","batchSize":50,"ana_no_standalone_price":1}
2026-09-06T13:29:28.252Z [WARN] (集約 ×6) [detail] batch issues summary {"site":"bl","batchSize":50,"ana_no_standalone_price":1}
2026-09-06T13:29:28.253Z [WARN] (集約 ×8) [detail] batch issues summary {"site":"maniax","batchSize":42,"ana_no_standalone_price":1}
2026-09-06T13:29:29.385Z [WARN] [detail] batch issues summary {"site":"girls","batchSize":50,"ana_no_standalone_price":2}
2026-09-06T13:40:01.246Z [WARN] [detail] API returned empty object girls requested 1件 sample: RJ01693390
2026-09-06T13:40:01.614Z [WARN] [detail] API returned empty object maniax requested 1件 sample: RJ01688730
2026-09-06T13:40:01.995Z [WARN] [detail] API returned empty object girls requested 1件 sample: RJ01693390
2026-09-06T13:40:02.347Z [WARN] [detail] API returned empty object maniax requested 1件 sample: RJ01688730
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
