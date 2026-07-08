// cam_files (D1) アクセス層。SOURCE-MIRROR: クエリ設計は
// ippoan/rust-flickr:src/db.rs の cam_files 関連関数 (Postgres/RLS) から、
// single-tenant (organization_id 無し) 前提で TypeScript/D1 (SQLite) に移植。
//
// D1 は当日分のみを最小に保つ「作業キュー」として使い、日次確定後は
// `archive.ts` が R2 へ JSON flush してから本テーブルの行を消す
// (Refs ohishi-exp/ohishi-logi#1 2026-07-08 方針)。

export interface CamFileRow {
  name: string;
  date: string;
  hour: string;
  type: string;
  flickrId: string | null;
  createdAt: number;
}

/** 最後に scrape した (date, hour)。`name` 降順 = ファイル名の日時 prefix が
 * 辞書順=時系列順になる前提 (カメラの命名規則 `Event<date>_<time>...`)。 */
export async function lastCamFile(db: D1Database): Promise<{ date: string; hour: string } | null> {
  const row = await db.prepare("SELECT date, hour FROM cam_files ORDER BY name DESC LIMIT 1").first<{
    date: string;
    hour: string;
  }>();
  return row ?? null;
}

/** カメラ上のファイルを cam_files に UPSERT (新規なら created_at を刻む) */
export async function upsertCamFile(
  db: D1Database,
  name: string,
  date: string,
  hour: string,
  type: string,
  now: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO cam_files (name, date, hour, type, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT (name) DO UPDATE SET date = excluded.date, hour = excluded.hour, type = excluded.type`,
    )
    .bind(name, date, hour, type, now)
    .run();
}

/** Flickr 未アップロードの一覧。floor は (date, hour) 粒度
 * (`date > floor_date OR (date = floor_date AND hour >= floor_hour)`) —
 * SD に実在する最古日の途中 hour までしか残っていないケースで、その hour 未満
 * (= SD から既に消えた) の古い行を対象から外す (rust-flickr#24 と同じ理由)。
 * 古い順 (`name` 昇順、= 時系列順) に SD ローテーションと競争する。 */
export async function listUnuploadedCamFiles(
  db: D1Database,
  floorDate: string,
  floorHour: string,
  limit: number,
): Promise<CamFileRow[]> {
  const { results } = await db
    .prepare(
      `SELECT name, date, hour, type, flickr_id AS flickrId, created_at AS createdAt
       FROM cam_files
       WHERE flickr_id IS NULL AND (date > ?1 OR (date = ?1 AND hour >= ?2))
       ORDER BY name
       LIMIT ?3`,
    )
    .bind(floorDate, floorHour, limit)
    .all<CamFileRow>();
  return results;
}

/** Flickr 未アップロードの残数 ((date, hour) 粒度 floor、上と同条件) */
export async function countUnuploadedCamFiles(
  db: D1Database,
  floorDate: string,
  floorHour: string,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS count FROM cam_files
       WHERE flickr_id IS NULL AND (date > ?1 OR (date = ?1 AND hour >= ?2))`,
    )
    .bind(floorDate, floorHour)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

/** アップロード成功 (または SD_ZOMBIE sentinel) の flickr_id を記録 */
export async function setCamFileFlickrId(db: D1Database, name: string, flickrId: string): Promise<void> {
  await db.prepare("UPDATE cam_files SET flickr_id = ?1 WHERE name = ?2").bind(flickrId, name).run();
}

/** 日次アーカイブ (R2 flush) 対象の全行 (name 昇順) */
export async function listByDate(db: D1Database, date: string): Promise<CamFileRow[]> {
  const { results } = await db
    .prepare(
      `SELECT name, date, hour, type, flickr_id AS flickrId, created_at AS createdAt
       FROM cam_files WHERE date = ?1 ORDER BY name`,
    )
    .bind(date)
    .all<CamFileRow>();
  return results;
}

/** アーカイブ済みの日付を D1 から削除する (flush の最終ステップ) */
export async function deleteByDate(db: D1Database, date: string): Promise<void> {
  await db.prepare("DELETE FROM cam_files WHERE date = ?1").bind(date).run();
}

/** D1 に残っている日付一覧 (古い順、= アーカイブ flush 対象の候補) */
export async function listDates(db: D1Database): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT DISTINCT date FROM cam_files ORDER BY date")
    .all<{ date: string }>();
  return results.map((r) => r.date);
}

export interface DayStats {
  date: string;
  files: number;
  uploaded: number;
}

/** UI (ステータスページ) 向け、撮影日別の files/uploaded 件数 (新しい順) */
export async function dayStats(db: D1Database, limit: number): Promise<DayStats[]> {
  const { results } = await db
    .prepare(
      `SELECT date, COUNT(*) AS files, COUNT(flickr_id) AS uploaded
       FROM cam_files GROUP BY date ORDER BY date DESC LIMIT ?1`,
    )
    .bind(limit)
    .all<DayStats>();
  return results;
}
