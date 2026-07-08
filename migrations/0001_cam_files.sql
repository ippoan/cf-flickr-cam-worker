-- cam_files: カメラ SD カード上のファイルの scrape/upload 状態。
-- single-tenant (1 カメラ) 運用のため organization_id は持たない
-- (ippoan/rust-flickr の cam_files テーブルとの違い)。
-- 当日分のみ保持し、日次確定後は R2 に JSON アーカイブして本テーブルから削除する
-- (D1 を常に最小に保つ、Refs ohishi-exp/ohishi-logi#1 2026-07-08 方針)。

CREATE TABLE IF NOT EXISTS cam_files (
  name TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  hour TEXT NOT NULL,
  type TEXT NOT NULL,
  flickr_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cam_files_date_hour ON cam_files (date, hour);
CREATE INDEX IF NOT EXISTS idx_cam_files_unuploaded ON cam_files (flickr_id) WHERE flickr_id IS NULL;
