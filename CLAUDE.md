# Chatone PWA — プロジェクト概要

kintone上で動いていたチャットアプリ（カスタマイズJS）を、Firebase Realtime Database
を使ったスタンドアロンPWAへ移植したもの。目的は kintone API 呼び出し回数の削減と、
スマートフォンでネイティブアプリのように使えるようにすること。

## アーキテクチャ

- **チャットデータ本体（rooms/messages/fcm_tokens）**: Firebase Realtime Database に
  直接読み書き（リアルタイムリスナー）。ここが kintone API 削減の核心 —
  メッセージの送受信は kintone を経由しない。
- **kintone連携が必要な部分だけ** Cloud Functions 経由でプロキシ:
  - `kintoneProxy`: 汎用REST GET/POST/PUT中継（認証・ユーザー検索・スタンプ/アバターアプリ参照など）
  - `kintoneFileUpload` / `kintoneFileDownload`: 添付ファイルの授受
  - フロント側の呼び出し元は `chatone-pwa.js` の `api._proxy()` 系
- **認証**: kintoneの `X-Cybozu-Authorization` を検証後、IndexedDB (`chatone-pwa` DB,
  `settings` store) に base64難読化して保存。フォールバックで localStorage も使用。
- **プッシュ通知**: `firebase-messaging-sw.js` が実質的に唯一稼働する Service Worker。
  FCMのバックグラウンド受信 + アプリシェルのキャッシュ(PWAオフライン起動)を兼務している。
- **⚠️ 既知のクセ**: リポジトリには `sw.js` も残っているが、`chatone-pwa-hotfix.js` が
  `navigator.serviceWorker.register` をパッチして `/sw.js` への登録を横取りし、実際には
  登録させない仕組みになっている（統合前の名残）。`sw.js` を編集しても効果が出ない可能性が
  高いので、SW関連の修正は基本的に `firebase-messaging-sw.js` 側に対して行うこと。
- **キャッシュバージョン**: `sw.js` は `CACHE_NAME = 'chatone-pwa-v12'`、
  `firebase-messaging-sw.js` は `'chatone-pwa-v17'` と乖離している。アセット
  (`chatone-pwa.js`/`.css`/hotfix等) を変更した場合は `firebase-messaging-sw.js` の
  `CACHE_NAME` を必ずインクリメントすること（さもないと端末に古いJSがキャッシュされ続ける）。
- **ホットフィックス運用**: `chatone-pwa-hotfix.js` は本体 `chatone-pwa.js` の不具合を
  都度パッチする運用ファイル。`index.html` で `chatone-pwa.js` の後に
  `?v=YYYYMMDD-N` というクエリ付きで読み込まれる。中身を変更したらこのバージョン文字列も
  更新してキャッシュを効かせないようにする（`firebase-messaging-sw.js` の `ASSETS` 配列内の
  参照パスとも一致させること）。

## ファイル構成

| ファイル | 役割 |
|---|---|
| `index.html` | エントリポイント。Firebase SDK(compat版)・本体・hotfixを読み込む |
| `chatone-pwa.js` | 本体ロジック（約2,800行）。`CONFIG`定数に環境固有設定を集約 |
| `chatone-pwa-hotfix.js` | 本体に対する運用パッチ集（上記参照） |
| `chatone-pwa.css` | スタイル |
| `firebase-messaging-sw.js` | 実質的なService Worker本体（FCM + キャッシュ） |
| `sw.js` | 旧Service Worker。hotfixにより実際には登録されない（レガシー） |
| `manifest.json` | PWAマニフェスト |
| `firebase.json` | Firebase Hosting/Functionsのデプロイ設定 |
| `functions/index.js` | Cloud Functions（kintoneプロキシ3種 + 新着メッセージのFCM送信） |
| `icons/` | PWAアイコン一式 |

## 設定値の場所

- フロント側の環境設定: `chatone-pwa.js` 先頭の `CONFIG` オブジェクト
  （kintoneサブドメイン、Cloud FunctionsのURL、Firebase設定、kintoneアプリID等）
- Firebase設定はフロント3箇所（`chatone-pwa.js` / `firebase-messaging-sw.js`）に
  重複して直書きされている。変更時は両方を同期させること。
- Cloud Functionsのリージョンは `asia-northeast1`（`functions/index.js` の
  `setGlobalOptions`）。

## この環境でできないこと

- Firebase CLI 未インストール・認証情報なし。`firebase deploy` 等の実デプロイ確認は
  このリモート実行環境からは行えない。コード変更の妥当性はロジック確認・静的チェックに
  留める。実機/実環境での動作確認はユーザー側で実施してもらう。

## 作業時の指針（トークン節約）

- `chatone-pwa.js`（約2,800行・100KB超）を丸ごと `Read` しない。まず `Grep` で
  該当シンボル/関数名を検索し、必要な範囲だけ `offset`/`limit` 付きで読む。
- 大規模・横断的な調査（「〇〇を使っている箇所を全部探して」等）は `Explore` エージェントに
  委任し、結果の要約だけを受け取る。
- 同じファイルを何度も読み直さない。直前に読んだ内容やEditの結果は会話内に残っているので
  再読込しない（Editツールは失敗時にエラーを返すため、成功確認のための再読込は不要）。
- 修正は要求されたスコープに留める。ホットフィックスファイルへの継ぎ足しが増えている経緯が
  あるため、本体側で直接直せるものは本体を直し、hotfixへの追加は最小限にする。
- 差分は `git diff` で確認し、必要な範囲だけを見る。ログ全件表示など大きい出力は
  `head_limit` / `-n` で絞る。

## ブランチ運用

- 現行の作業ブランチ: `claude/kintone-firebase-chat-review-y1ss15`
- 過去の作業ブランチ例: `codex/write-check-20260629`
- ベースブランチ: `main`
