# cf-flickr-cam-worker

カメラ SD カード scrape パイプラインの **Cloudflare Worker** 側。設計の背景は
[Issue #1](https://github.com/ippoan/cf-flickr-cam-worker/issues/1) (最初は
Worker で実処理全体を持つ計画だったが、Supabase 直接接続と Workers runtime での
MD5 対応可否がコスト高だったため、実処理本体を Cloud Run
([ohishi-exp/ohishi-logi](https://github.com/ohishi-exp/ohishi-logi)) に切り出し、
本 repo は cron trigger + 薄い proxy 役に縮小した経緯) を参照。

## アーキテクチャ (2026-07-08 時点、一部未確定)

```
Cloud Scheduler (cron trigger)
  → cf-flickr-cam-worker (本repo, Cloudflare Worker)
      → Flickr OAuth1.0a 認可フロー・multipart upload (HMAC-SHA1、Workers runtime で可)
      → Flickr access token を KV (FLICKR_TOKENS) に永続化
      → ohishi-logi (Cloud Run) から写真データを取得 ← 認証方式・呼び出し方は未確定
```

**Flickr OAuth1.0a・upload・token 永続化はこちら側の責務**。MD5 (Digest 認証) と
違い OAuth1.0a の HMAC-SHA1 署名は Workers runtime (`crypto.subtle`) で問題なく
動くため、ohishi-logi 側 (`SOURCE-MIRROR` で一時的に持っていた `oauth1.rs` /
`flickr.rs`) から移した。

## 現在の実装状態

| コンポーネント | 状態 | 備考 |
| --- | --- | --- |
| `src/oauth1.ts` (OAuth1.0a HMAC-SHA1 署名、Web Crypto) | ✅ 実装済 | `ippoan/rust-flickr:src/oauth1.rs` から SOURCE-MIRROR、テスト込み (既知ベクタ含む) |
| `src/flickr.ts` (Flickr API クライアント、token 取得 + multipart upload) | ✅ 実装済 | `ippoan/rust-flickr:src/flickr.rs` から SOURCE-MIRROR。`fetchImpl` DI でテスト可能 |
| `src/tokens.ts` (KV: request token 短命保存 + access token 永続化) | ✅ 実装済 | single-tenant (1 カメラ) 前提の固定 key |
| `GET /health` | ✅ | 死活監視 |
| `GET /oauth/url` / `GET /oauth/callback` / `GET /oauth/status` | ✅ | Flickr 認可フロー一式 |
| cron `scheduled()` (カメラ scrape ループ) | ❌ 未着手 | ohishi-logi 呼び出しの認証方式が未確定のため |
| ohishi-logi からのカメラデータ取得 (RPC 呼び出し) | ❌ 未着手 | 認証方式・データ層設計が未確定 (下記) |

## 未確定事項 (次に着手する前に確認が必要)

以下は fable-advisor に相談中/相談済みだが、**まだ確定していない**:

- **cf-flickr-cam-worker → ohishi-logi の認証方式**。候補: auth-worker の
  `device-data-proxy` パターン (OIDC mint + Cloud Run IAM lockdown +
  role→path allowlist) を multi-backend に一般化。fable の助言では
  「tenant_id 検証だけ」への単純化は不十分 (Cloud Run への到達制御は RLS の
  代替にならない) — role 検証・OIDC mint・IAM lockdown は引き続き必要という見立て
- **カメラ写真データの永続化層**: 当初計画 (ohishi-logi 側 Supabase 新 schema) か、
  代替案 (Cloudflare D1 で当日分のみ保持 + R2 に日次 JSON アーカイブ、1 カメラ・
  日付単位検索のみという前提) か。後者を採る場合、状態管理の主体が本 Worker 側
  (D1/R2) に移り、ohishi-logi は無状態の camera fetcher になる可能性がある
- 「ohishi-data db」(将来的に auth-worker 認証を入れたいと user が言及) の実体
- 上記が決まってからの `auth-worker` 側の変更 (新 route / role 追加) と
  ohishi-logi 側の RPC endpoint 実装

## ローカル開発

```sh
npm install
npx tsc --noEmit
npx vitest run --coverage
npx wrangler dev
```

## One-time setup (deploy 前に必要、user 手動)

CI (`frontend-ci.yml`) は PR / tag push のたびに `wrangler deploy` を走らせる
(single-env、下記)。**以下が完了するまで初回 deploy は `kv_namespaces` /
`secrets_store_secrets` の placeholder id で fail する**:

1. `npx wrangler kv namespace create FLICKR_TOKENS` (+ `--preview`) を実行し、
   出力された `id` / `preview_id` を `wrangler.jsonc` の `kv_namespaces` に反映
2. `FLICKR_CONSUMER_KEY` / `FLICKR_CONSUMER_SECRET` を `secret-inject` skill で
   CF Secrets Store に投入 (`wrangler secret put` は使わない — secrets-inventory
   の drift 検知対象に含めるため)、`wrangler.jsonc` の `secrets_store_secrets`
   `store_id` を実 store id に反映
3. custom domain (未確定) or `workers.dev` の URL を Flickr App の callback URL
   として登録

## CI

`ippoan/ci-workflows` の `frontend-ci.yml` (project_type: worker)。**single-env
運用 (staging = prod)** — PR (non-draft) の deploy-staging job と tag push
(`v*`) の deploy-release job はどちらも同じ root `wrangler.jsonc` に対して
`npx wrangler deploy` を実行する (cf-flickr-proxy / security-notification-app
と同パターン)。
