# CLAUDE.md

`cf-flickr-cam-worker` — カメラ SD カード scrape パイプラインの Cloudflare Worker
側。Cloud Scheduler の cron trigger を受け、`ohishi-exp/ohishi-logi` (Cloud Run)
から写真データを取得して Flickr へアップロードする想定。設計の背景・現状・未確定
事項は [README.md](./README.md) と
[Issue #1](https://github.com/ippoan/cf-flickr-cam-worker/issues/1) を参照。

移植元: `ippoan/rust-flickr` (OAuth1.0a 認可フローの実装元)。

## repo 固有の invariant

- **Flickr OAuth1.0a 認可フロー・multipart upload・access token 永続化 (KV) は
  本 repo の責務** — MD5 (Digest 認証) と違い HMAC-SHA1 は Workers runtime で
  動くため (`ohishi-logi` 側ではなくこちらに実装、2026-07-08 方針決定)。
- **access token / secret はレスポンス・ログに echo しない**。
- **CI は single-env (staging = prod)**。`frontend-ci.yml` の deploy-staging /
  deploy-release は同じ root `wrangler.jsonc` に `wrangler deploy` する。初回は
  KV / Secrets Store の one-time setup (README) が先。

## ビルド / テスト

```sh
npm install
npx tsc --noEmit
npx vitest run --coverage
```

## GitHub 自動化

- `main` に直接 push しない。PR を作る。
- PR / commit は `Refs #N` を使う (`Closes/Fixes/Resolves` は禁止 — auto-close 防止)。

---

_共通項を直すときは [`ippoan/claude-md`](https://github.com/ippoan/claude-md) の
`CLAUDE.md.template` を更新すること。_
