# DLsite Price Tracker

DLsite の価格履歴を自動収集するデスクトップアプリ。

## ダウンロード

**[最新版 DLsiteTracker-portable.exe](https://github.com/tehuyoryu-cpu/siteruns23432/releases/latest)**

ダウンロードしてダブルクリックするだけ。インストール不要。

---

## 使い方

### 起動

`DLsiteTracker-portable.exe` をダブルクリック → ウィンドウが開く。

### 操作

| 場所 | 操作 |
|---|---|
| ツールバー | RJ収集 / 価格更新 / セール優先 / 全て巡回 / 全収集 / 全セール収集 |
| メニューバー「巡回」 | 同上（キーボードショートカット付き） |
| タスクトレイ右クリック | バックグラウンドでジョブ実行 |

### キーボードショートカット

| キー | 動作 |
|---|---|
| `Ctrl+1` | RJ収集 |
| `Ctrl+2` | 価格更新 |
| `Ctrl+3` | セール優先 |
| `Ctrl+Shift+A` | 全て巡回 |
| `Ctrl+Shift+F` | 全収集（FSR全ページ） |
| `Ctrl+Shift+S` | 全セール収集 |

### 自動巡回スケジュール

起動後は自動で動き続ける。

| 間隔 | 内容 |
|---|---|
| 6時間ごと | 新着/ランキング/セールからRJ収集 |
| 20分ごと | 期限切れ作品の価格更新 |
| 10分ごと | セール中サークルの優先度維持 |

### データ

- `dlsite.db`（exe と同じフォルダに自動生成）に蓄積
- メニュー「ファイル → データベースの場所を開く」で確認
- ツールバーの「CSV保存」「JSON保存」でエクスポート可能

### 終了

ウィンドウを閉じてもタスクトレイに常駐し続ける。  
完全終了はトレイアイコン右クリック → **終了**。

---

## 収集対象

- **maniax**（男性向け）: 全年齢 / R15 / 成人向け
- **girls**（女性向け）: 同人 / 書籍 / ドラマCD / PC
- **言語**: JPN / ENG / CHI / CHI_HANS / CHI_HANT / KO_KR / SPA / GER / FRE / IND / ITA / POR / SWE / THA / VIE / その他 / 言語不問

---

## ビルド（開発者向け）

```bash
git clone https://github.com/tehuyoryu-cpu/siteruns23432.git
cd siteruns23432
npm install
npm start          # 開発起動（Electronウィンドウ）
npm run dev        # UIのみ（ブラウザで http://127.0.0.1:7777）
```

GitHub に push すると Actions が自動で exe をビルドして Releases に上げる。
