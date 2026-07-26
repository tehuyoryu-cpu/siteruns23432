# DLsite Score — 配信データ (自動生成)

このブランチは DLsite Score ブラウザ拡張機能向けの価格スコアデータを配信するための
専用ブランチです。**手動編集しないでください**(毎回まるごと上書きされます)。

## 構成

- `manifest.json` — 生成日時・シャード数・スキーマ説明
- `shards/NNNN.json` — サークル単位でハッシュ分散したワークデータ本体
- `index/NN.json` — RJコード → shard番号 の対応表

## 取得方法

jsDelivr CDN 経由を推奨:
```
https://cdn.jsdelivr.net/gh/tehuyoryu-cpu/siteruns23432@data/index/{idxShard}.json
https://cdn.jsdelivr.net/gh/tehuyoryu-cpu/siteruns23432@data/shards/{shard}.json
```

shard番号の算出方法(FNV-1a 32bit)は `crawler/exportShards.js` の `fnv1a()` を参照。
