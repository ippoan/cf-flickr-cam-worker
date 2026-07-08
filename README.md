# cf-flickr-cam-worker

カメラ SD カード scrape → Flickr upload パイプラインを**単体で完結**させる
**Cloudflare Worker**。設計の背景は
[Issue #1](https://github.com/ippoan/cf-flickr-cam-worker/issues/1) を参照。

**2026-07-08 に方針を 3 段階で転換した**:

1. 当初は「Workers runtime での MD5 (Digest認証) 対応可否」がコスト高と判断し、
   カメラ通信の実処理本体を Cloud Run (`ohishi-exp/ohishi-logi`) に切り出す
   計画だった。Flickr OAuth1.0a/upload だけを本 repo に残す設計にした
2. その後「pure-JS MD5 実装 + Workers VPC Services (Cloudflare Tunnel 越しの
   private network 接続) でカメラ通信自体も Worker で完結できる」と判断し、
   **`ohishi-logi` (Cloud Run) を廃止**。カメラ Digest 認証・SD XML 巡回も
   本 repo に統合した
3. さらに「single-tenant 運用では OAuth 認可は実質 1 回きり」という前提から、
   Flickr access token の永続化に使っていた **KV (`FLICKR_TOKENS`) を廃止**。
   CF Secrets Store の binding は read-only (Worker からの write 不可) なので、
   OAuth 完了後は運用者が `secret-inject` skill で access token を手動投入する
   運用に変更した。OAuth ハンドシェイク中の request_token_secret は署名付き
   HttpOnly cookie (`OAUTH_STATE_SECRET`) に置き換えた

## アーキテクチャ

```
Cron Trigger (*/15 分)
  → cf-flickr-cam-worker (本repo, Cloudflare Worker)
      → Workers VPC Services (env.CAM_SERVICE) 経由でカメラへ Digest 認証 + SD XML 巡回
      → Flickr へ OAuth1.0a multipart upload
      → D1 (CAM_DB, 当日分メタデータのみ) + R2 (CAM_ARCHIVE, 日次 JSON アーカイブ)
        — 画像バイナリはどこにも持たない (画像本体は Flickr が正)
      → Flickr access token は secret (FLICKR_ACCESS_TOKEN_JSON) から読むのみ
        (OAuth 完了後に運用者が secret-inject skill で手動投入、Worker は書けない)

ブラウザ (人間)
  → GET /            状況確認 (Flickr 接続状態・直近の同期状況)
  → GET /oauth/start Flickr 認可フロー開始 (request_token_secret は署名付き
                      HttpOnly cookie に一時保存)
  → GET /oauth/callback  認可完了 → access token を一度だけ表示 (secret-inject
                      で手動投入するため)
  → GET /images      画像確認 (日付ごとのアップロード状況 + Flickr へのリンク)
```

## 現在の実装状態

| コンポーネント | 状態 |
| --- | --- |
| `src/md5.ts` (pure-JS MD5、RFC1321 既知ベクタでテスト) | ✅ |
| `src/cam.ts` (Digest認証 RFC2617 + SD XML巡回 + download、`CAM_SERVICE` 経由) | ✅ |
| `src/oauth1.ts` / `src/flickr.ts` (OAuth1.0a + upload) | ✅ |
| `src/tokens.ts` (`FLICKR_ACCESS_TOKEN_JSON` secret からの読み出し) | ✅ |
| `src/oauthState.ts` (署名付き cookie: request_token_secret 一時保存) | ✅ |
| `src/d1.ts` / `src/archive.ts` (D1 当日分 + R2 日次アーカイブ) | ✅ |
| `src/sync.ts` (scrape→UPSERT→upload オーケストレーション、SD_ZOMBIE判定) | ✅ |
| `src/scheduled.ts` (cron エントリポイント) | ✅ |
| `src/routes.tsx` + `src/pages.tsx` (Hono + JSX: 状況/画像確認ページ + JSON API) | ✅ |

upstream (`ippoan/rust-flickr` の `sync_cam_files`) との既知の意図的差分は
`src/sync.ts` 冒頭コメント参照 (初回実行時のブートストラップ挙動を変更)。

## 未確定事項

- カメラの Cloudflare Tunnel + VPC Service の実 service_id (下記 one-time setup)
- custom domain (未確定、`workers.dev` で暫定運用)
- single-tenant (1 カメラ) 前提を超える将来の拡張 (multi-camera 化する場合は
  D1 スキーマ・access token secret 設計の見直しが要る)

## ローカル開発

```sh
npm install
npx tsc --noEmit
npx vitest run --coverage   # D1/R2 は @cloudflare/vitest-pool-workers (Miniflare) 上で実行
npx wrangler dev
```

## One-time setup (deploy 前に必要、user 手動)

CI (`frontend-ci.yml`) は PR / tag push のたびに `wrangler deploy` を走らせる
(single-env)。**以下が完了するまで初回 deploy は placeholder id で fail する**:

1. Cloudflare Tunnel をカメラの private network に接続し (既存の cloudflared
   接続を再利用可)、Workers VPC Service を作成 (要 Connectivity Directory Admin
   ロール)。出力された `service_id` を `wrangler.jsonc` の `vpc_services` に反映
   ([Workers VPC Services docs](https://developers.cloudflare.com/workers-vpc/configuration/vpc-services/))
2. `npx wrangler d1 create cf-flickr-cam-worker-db` → `database_id` を
   `wrangler.jsonc` の `d1_databases` に反映
3. `npx wrangler r2 bucket create cf-flickr-cam-worker-archive`
4. secrets 投入 (`wrangler secret put` は使わない — secrets-inventory の drift
   検知対象に含めるため):
   - `FLICKR_CONSUMER_KEY` / `FLICKR_CONSUMER_SECRET` / `CAM_DIGEST_USER` /
     `CAM_DIGEST_PASS` / `CAM_MACHINE_NAME` / `CAM_SDCARD_CGI` / `CAM_MP4_CGI` /
     `CAM_JPG_CGI` の 8 つは、同じカメラ・同じ Flickr App を使う
     `ippoan/rust-flickr` が既に GCP に持っている `rust-flickr-*` secret を
     `sync_from_gcp` MCP tool で CF Secrets Store にミラーするだけで済む
     (値の再入力不要、投入済み)
   - `OAUTH_STATE_SECRET` のみ本 repo 固有の新規 secret。
     `openssl rand -hex 32` を `secret-inject` skill に渡し `--targets gcp,cf`
     で投入済み
   - `wrangler.jsonc` の `secrets_store_secrets` に store_id/secret_name 反映済み
5. custom domain (未確定) or `workers.dev` の URL を Flickr App の callback URL
   として登録
6. 上記までで deploy (secret-verify green) → `/oauth/start` にアクセスして
   Flickr 認可を完了させる → `/oauth/callback` が access token を **一度だけ**
   表示するので、その場で `secret-inject` skill を使い
   `FLICKR_ACCESS_TOKEN_JSON` として投入する (値は必ず stdin 経由、この画面は
   再表示されない — 失敗したら `/oauth/start` からやり直す)
7. `wrangler.jsonc` の `secrets_store_secrets` に `FLICKR_ACCESS_TOKEN_JSON` の
   binding を追記して再 deploy する (初回 deploy 時点ではまだ存在しないため、
   最初から binding に含めると解決できず deploy が落ちる — chicken-egg)

## CI

`ippoan/ci-workflows` の `frontend-ci.yml` (project_type: worker)。**single-env
運用 (staging = prod)** — PR (non-draft) の deploy-staging job と tag push
(`v*`) の deploy-release job はどちらも同じ root `wrangler.jsonc` に対して
`npx wrangler deploy` を実行する。

`@cloudflare/vitest-pool-workers@^0.5.41` (+ vitest 2.x) は `npm audit` 上
9 件の脆弱性 (miniflare/wrangler/esbuild/vite/undici、いずれも local dev/test
実行時のみ使う transitive tooling、production へは出荷されない) を含む。
`security-notification-app` と同じバージョン組で、より新しい
`@cloudflare/vitest-pool-workers@0.18.2` は vitest 4 系への破壊的 API 変更が
必要なため今回は追随しなかった。
