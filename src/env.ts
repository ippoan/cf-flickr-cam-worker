import type { SecretBinding } from "@ippoan/mcp-cf-workers/auth/secret";

export interface Env {
  // OAuth 完了後に運用者が secret-inject skill で手動投入する access token
  // (`{token,secret,userNsid,username}` の JSON、Refs #1 2026-07-08 KVから移行)。
  // secrets_store_secrets binding のため SecretBinding (Refs #6 と同じ理由 —
  // SecretsStoreSecret オブジェクトを直読みしないよう resolveSecret() 経由で使う)。
  FLICKR_ACCESS_TOKEN_JSON?: SecretBinding;
  // OAuth ハンドシェイク中の request_token_secret を載せる署名付き cookie の署名鍵。
  // secrets_store_secrets binding のため SecretBinding (Refs #6: string 直読みで
  // SecretsStoreSecret オブジェクトがそのまま渡っていたバグを修正)。
  OAUTH_STATE_SECRET: SecretBinding;
  FLICKR_CONSUMER_KEY: SecretBinding;
  FLICKR_CONSUMER_SECRET: SecretBinding;
  FLICKR_CALLBACK_URL: string;
  // カメラは Cloudflare Tunnel 越しの private network 上にあり、Workers VPC
  // Services 経由で到達する (Refs ohishi-exp/ohishi-logi#1 2026-07-08 方針転換)。
  CAM_SERVICE: Fetcher;
  CAM_DIGEST_USER: SecretBinding;
  CAM_DIGEST_PASS: SecretBinding;
  CAM_MACHINE_NAME: SecretBinding;
  // カメラの内部 IP のみ secret 化 (rust-flickr-staging 廃止後に導入、Refs #17)。
  // CGI パス (下記 3 つ) はカメラのベンダー仕様で秘匿性が無いため plain var。
  CAM_HOST: SecretBinding;
  CAM_SDCARD_CGI_PATH: string;
  CAM_MP4_CGI_PATH: string;
  CAM_JPG_CGI_PATH: string;
  // 本 worker は workers_dev:false で完全非公開で、到達経路は auth-worker の
  // `/cf-flickr-cam-worker-proxy/*` proxy のみ。proxy は prefix を剥がして
  // forward するため worker 自身は prefix を知らない。HTML ページの内部リンク
  // (nav / form / img / a) にこの prefix を付けないとブラウザが prefix 無しで
  // 辿り not found になる (Refs #30)。未設定なら空 (直アクセス/テスト用)。
  PUBLIC_PATH_PREFIX?: string;
  CAM_CF_ACCESS_CLIENT_ID?: string;
  CAM_CF_ACCESS_CLIENT_SECRET?: string;
  // cam_files 相当の当日分メタデータ (状態管理の主体、Refs ohishi-exp/ohishi-logi#1)
  CAM_DB: D1Database;
  // 日次確定後の cam_files メタデータ JSON アーカイブ (画像バイナリは置かない)
  CAM_ARCHIVE: R2Bucket;
}
