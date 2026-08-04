# デバッグブランチ (自動生成)

このブランチは DLsite Price Tracker が巡回ジョブ完了ごとに自動でpushする、
直近ログ・DB統計・エラー一覧です。**手動編集しないでください**(毎回まるごと上書きされます)。

このブランチが存在する目的は、ユーザーがログファイルの中身をコピペしなくても、
Claude（または他のAIアシスタント／開発者）がリポジトリを `git fetch origin debug`
するだけで直近の実行状態を把握できるようにすることです。

## まず読むファイル

**`debug-summary.md`** — 直近状態の要約。まずこれを読めば大枠が分かります。

## 詳細ファイル

| ファイル | 内容 |
|---|---|
| `latest.log` | 全ログ末尾500行 |
| `latest-error.log` | WARN/ERRORのみ末尾300行 |
| `digest-recent.log` | ジョブ実行ごとの1行要約、末尾200行 |
| `events-recent.jsonl` | 構造化ログ(JSON Lines)、末尾800行。level/job/msgで機械的にフィルタ可能 |
| `price-issues.json` / `price-issues-count.txt` | 定価が信頼できる形で取得できなかった作品一覧・件数 |
| `api-trace-recent.json` | 異常APIレスポンス(空応答/severely-partial/CDN汚染/非200)の生サンプル直近50件 |
| `warmup-history-recent.json` | 年齢確認セッション再確立(warmUp)の直近30回分の履歴（周期性の確認用） |
| `locks-snapshot.json` | push時点のジョブロック/中断シグナルの状態 |
| `meta.json` | pushトリガー・DB統計・実行環境情報 |

## 更新タイミング

discovery / detail(価格更新) / fullscan / endingsoon / circlegap / newrelease / compScan の
各ジョブが完了するたびに自動push されます（成功・失敗どちらでも記録されます）。

## Claudeが参照する手順の例

```bash
git fetch origin debug
git show origin/debug:debug-summary.md
```
