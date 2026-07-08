export interface Env {
  // OAuth 完了後に運用者が secret-inject skill で手動投入する access token
  // (`{token,secret,userNsid,username}` の JSON、Refs #1 2026-07-08 KVから移行)
  FLICKR_ACCESS_TOKEN_JSON?: string;
  // OAuth ハンドシェイク中の request_token_secret を載せる署名付き cookie の署名鍵
  OAUTH_STATE_SECRET: string;
  FLICKR_CONSUMER_KEY: string;
  FLICKR_CONSUMER_SECRET: string;
  FLICKR_CALLBACK_URL: string;
  // カメラは Cloudflare Tunnel 越しの private network 上にあり、Workers VPC
  // Services 経由で到達する (Refs ohishi-exp/ohishi-logi#1 2026-07-08 方針転換)。
  CAM_SERVICE: Fetcher;
  CAM_DIGEST_USER: string;
  CAM_DIGEST_PASS: string;
  CAM_MACHINE_NAME: string;
  CAM_SDCARD_CGI: string;
  CAM_MP4_CGI: string;
  CAM_JPG_CGI: string;
  CAM_CF_ACCESS_CLIENT_ID?: string;
  CAM_CF_ACCESS_CLIENT_SECRET?: string;
  // cam_files 相当の当日分メタデータ (状態管理の主体、Refs ohishi-exp/ohishi-logi#1)
  CAM_DB: D1Database;
  // 日次確定後の cam_files メタデータ JSON アーカイブ (画像バイナリは置かない)
  CAM_ARCHIVE: R2Bucket;
}
