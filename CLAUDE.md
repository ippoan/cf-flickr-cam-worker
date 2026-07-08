# CLAUDE.md

`cf-flickr-cam-worker` — カメラ SD カード scrape パイプライン全体を単体で完結
させる Cloudflare Worker (2026-07-08 方針転換: `ohishi-exp/ohishi-logi` Cloud Run
は廃止、pure-JS MD5 + Workers VPC Services でカメラ通信も本 repo に集約)。設計の
背景・現状・未確定事項は [README.md](./README.md) と
[Issue #1](https://github.com/ippoan/cf-flickr-cam-worker/issues/1) を参照。

移植元: `ippoan/rust-flickr` (Digest認証・SD XML巡回・OAuth1.0a・upload の実装元)。

## repo 固有の invariant

- **カメラは Workers VPC Services (`env.CAM_SERVICE`) 経由のみ**。公開 URL
  (旧 cloudflared 公開ルート) は使わない。
- **Digest 認証は pure-JS MD5 (`src/md5.ts`)** — Web Crypto API は MD5 を持たない。
  改変時は RFC1321 既知ベクタ + RFC2617 既知ベクタのテストを両方通すこと。
- **D1 (`CAM_DB`) は当日分のみ最小に保つ**。日次確定後は R2 (`CAM_ARCHIVE`) へ
  メタデータ JSON archive し D1 から削除する。**画像バイナリはどこにも持たない**
  (画像本体は Flickr が正)。
- **access token / secret はレスポンス・ログに echo しない**。
- **CI は single-env (staging = prod)**。deploy-staging/release は同じ root
  `wrangler.jsonc` に deploy。初回は KV/D1/R2/VPC/Secrets の setup (README) が先。

## ビルド / テスト

```sh
npm install
npx tsc --noEmit
npx vitest run --coverage
```

D1/R2 を実際に叩くテストは `@cloudflare/vitest-pool-workers` (Miniflare) 上で動く。

## GitHub 自動化

- `main` に直接 push しない。PR を作る。
- PR / commit は `Refs #N` を使う (`Closes/Fixes/Resolves` は禁止 — auto-close 防止)。

---

_共通項を直すときは [`ippoan/claude-md`](https://github.com/ippoan/claude-md) の
`CLAUDE.md.template` を更新すること。_
