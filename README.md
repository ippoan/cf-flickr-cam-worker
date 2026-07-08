# cf-flickr-cam-worker

カメラ SD カード scrape → Flickr upload パイプラインを**単体で完結**させる
**Cloudflare Worker**。設計の背景は
[Issue #1](https://github.com/ippoan/cf-flickr-cam-worker/issues/1) を参照。

**2026-07-08 に方針を 2 段階で転換した**:

1. 当初は「Workers runtime での MD5 (Digest認証) 対応可否」がコスト高と判断し、
   カメラ通信の実処理本体を Cloud Run (`ohishi-exp/ohishi-logi`) に切り出す
   計画だった。Flickr OAuth1.0a/upload だけを本 repo に残す設計にした
2. その後「pure-JS MD5 実装 + Workers VPC Services (Cloudflare Tunnel 越しの
   private network 接続) でカメラ通信自体も Worker で完結できる」と判断し、
   **`ohishi-logi` (Cloud Run) を廃止**。カメラ Digest 認証・SD XML 巡回も
   本 repo に統合した

## アーキテクチャ

```
Cron Trigger (*/15 分)
  → cf-flickr-cam-worker (本repo, Cloudflare Worker)
      → Workers VPC Services (env.CAM_SERVICE) 経由でカメラへ Digest 認証 + SD XML 巡回
      → Flickr へ OAuth1.0a multipart upload
      → D1 (CAM_DB, 当日分メタデータのみ) + R2 (CAM_ARCHIVE, 日次 JSON アーカイブ)
        — 画像バイナリはどこにも持たない (画像本体は Flickr が正)
      → Flickr access token は KV (FLICKR_TOKENS) に永続化

ブラウザ (人間)
  → GET /            状況確認 (Flickr 接続状態・直近の同期状況)
  → GET /oauth/start Flickr 認可フロー開始
  → GET /images      画像確認 (日付ごとのアップロード状況 + Flickr へのリンク)
```

## 現在の実装状態

| コンポーネント | 状態 |
| --- | --- |
| `src/md5.ts` (pure-JS MD5、RFC1321 既知ベクタでテスト) | ✅ |
| `src/cam.ts` (Digest認証 RFC2617 + SD XML巡回 + download、`CAM_SERVICE` 経由) | ✅ |
| `src/oauth1.ts` / `src/flickr.ts` (OAuth1.0a + upload) | ✅ |
| `src/tokens.ts` (KV: token 永続化) | ✅ |
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
  D1 スキーマ・KV key 設計の見直しが要る)

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
4. `npx wrangler kv namespace create FLICKR_TOKENS` (+ `--preview`) →
   `id`/`preview_id` を `wrangler.jsonc` の `kv_namespaces` に反映
5. `FLICKR_CONSUMER_KEY` / `FLICKR_CONSUMER_SECRET` / `CAM_DIGEST_USER` /
   `CAM_DIGEST_PASS` / `CAM_MACHINE_NAME` / `CAM_SDCARD_CGI` / `CAM_MP4_CGI` /
   `CAM_JPG_CGI` を `secret-inject` skill で CF Secrets Store に投入
   (`wrangler secret put` は使わない — secrets-inventory の drift 検知対象に
   含めるため)、`wrangler.jsonc` の `secrets_store_secrets` `store_id` を反映
6. custom domain (未確定) or `workers.dev` の URL を Flickr App の callback URL
   として登録

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
