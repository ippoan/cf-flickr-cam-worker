// カメラ scrape → cam_files (D1) UPSERT → Flickr upload のオーケストレーション。
// SOURCE-MIRROR: ippoan/rust-flickr:src/routes.rs::sync_cam_files のロジックを
// single-tenant (organization_id 無し) 前提で移植。
//
// upstream との既知の差分 (2026-07-08、意図的な変更):
// - 初回実行 (cam_files が空) は upstream では 400 で拒否するが、ここでは
//   SD 上の最古日から開始する (運用上のブートストラップ障害を避ける — D1 は
//   deploy のたびに空になり得るため、手動シード行を要求しない)。
// - upload floor は upstream 同様「SD に実在する最古日」だが、hour は明示情報が
//   無いため `000000` に固定する (date 粒度の floor で hour だけ 0 に丸める形。
//   count/list とも同じ (date,hour) 述語で一貫させている)。

import type { CamClient } from "./cam";
import { countUnuploadedCamFiles, listUnuploadedCamFiles, setCamFileFlickrId, upsertCamFile } from "./d1";
import type { FlickrClient } from "./flickr";
import type { StoredAccessToken } from "./tokens";

const SD_ZOMBIE_SENTINEL = "SD_ZOMBIE";
const UPLOAD_FLOOR_HOUR = "000000";

/** cam.rs の download エラーメッセージ形式 (`unexpected content type for
 * {name}: {content_type}`) から、SD カードローテーションで実体が消えた
 * "zombie" ファイルを判別する。text/plain (カメラの汎用エラーページ) の時だけ
 * zombie 扱いにし、他の異常 (image/png 等) は握り潰さない。 */
function isSdZombieError(message: string): boolean {
  return message.includes("unexpected content type") && message.includes("text/plain");
}

/** 数値として最小の dir 名を、入力文字列のフォーマットを保ったまま返す
 * (leading-zero を toString() で潰さないため)。 */
function minSdDir(dirs: string[]): string | null {
  let best: string | null = null;
  let bestNum = Infinity;
  for (const d of dirs) {
    const n = Number(d);
    if (!Number.isNaN(n) && n < bestNum) {
      bestNum = n;
      best = d;
    }
  }
  return best;
}

export interface SyncResult {
  processedDates: number;
  processedHours: number;
  newFiles: number;
  uploadedCount: number;
  uploadErrors: number;
  zombiedCount: number;
  remainingUnuploaded: number;
  message: string;
}

export async function syncCamFiles(
  db: D1Database,
  cam: CamClient,
  flickr: FlickrClient | null,
  accessToken: StoredAccessToken | null,
  lastPosition: { date: string; hour: string } | null,
  uploadLimit: number,
  now: number,
): Promise<SyncResult> {
  const allDates = await cam.listDates();

  // 1. 再開位置: 既存行があればそこから、無ければ SD 上の最古日から (upstream
  //    の 400 拒否からの意図的な変更、ファイル冒頭コメント参照)。
  const startDate = lastPosition?.date ?? minSdDir(allDates) ?? "";
  const startHour = lastPosition?.hour ?? "000000";

  const startDateInt = Number(startDate) || 0;
  const dates = allDates.filter((d) => (Number(d) || 0) >= startDateInt);

  const startHourInt = Number(startHour) || 0;
  const hours: [string, string][] = [];
  for (const date of dates) {
    let hourDirs: string[];
    try {
      hourDirs = await cam.listHours(date);
    } catch {
      continue; // upstream 同様 warn 相当・continue (個別失敗で全体を止めない)
    }
    for (const hour of hourDirs) {
      if (date === startDate) {
        if ((Number(hour) || 0) >= startHourInt) hours.push([date, hour]);
      } else {
        hours.push([date, hour]);
      }
    }
  }

  // 2. ファイル一覧 → UPSERT
  let newFiles = 0;
  for (const [date, hour] of hours) {
    let filenames: string[];
    try {
      filenames = await cam.listFileNames(date, hour);
    } catch {
      continue;
    }
    for (const filename of filenames) {
      const fileType = filename.includes(".mp4") ? "mp4" : "jpg";
      await upsertCamFile(db, filename, date, hour, fileType, now);
      newFiles++;
    }
  }

  // 3. Flickr アップロード (同期、upload_limit 件まで)。下限は SD に実在する
  //    最古日 (dates が空なら再開位置に fallback)。
  const uploadFloorDate = minSdDir(allDates) ?? startDate;

  let uploadedCount = 0;
  let uploadErrors = 0;
  let zombiedCount = 0;

  if (uploadLimit > 0 && flickr && accessToken) {
    const unuploaded = await listUnuploadedCamFiles(db, uploadFloorDate, UPLOAD_FLOOR_HOUR, uploadLimit);
    for (const file of unuploaded) {
      try {
        const data = await cam.download(file.name, file.date, file.hour);
        const flickrId = await flickr.uploadPhoto(accessToken.token, accessToken.secret, file.name, data);
        await setCamFileFlickrId(db, file.name, flickrId);
        uploadedCount++;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (isSdZombieError(message)) {
          // SD ローテで実体が消えた zombie。再試行ループから外す (rust-flickr#26)
          await setCamFileFlickrId(db, file.name, SD_ZOMBIE_SENTINEL);
          zombiedCount++;
        } else {
          uploadErrors++;
        }
      }
    }
  }

  const remainingUnuploaded = await countUnuploadedCamFiles(db, uploadFloorDate, UPLOAD_FLOOR_HOUR);

  return {
    processedDates: dates.length,
    processedHours: hours.length,
    newFiles,
    uploadedCount,
    uploadErrors,
    zombiedCount,
    remainingUnuploaded,
    message:
      `Synced ${dates.length} dates, ${hours.length} hours, ${newFiles} files. ` +
      `Uploaded ${uploadedCount} to Flickr (${uploadErrors} errors, ` +
      `${zombiedCount} SD-zombies marked, ${remainingUnuploaded} remaining).`,
  };
}
