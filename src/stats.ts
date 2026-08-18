// 日次メール (ippoan/cf-billing-monitor の `[Flickr]` レポート) 向けの
// 撮影日別サマリ。Refs #38
//
// 状態は 2 箇所に分かれている (Refs #1 の「D1 は当日分のみ最小に保つ」方針):
//   - D1 (`cam_files`)   … 当日 + まだアーカイブしていない日
//   - R2 (`{date}.json`) … 日次確定後の過去日
// レポートは両方をまたいだ窓が要るので、ここで 1 本にマージする。
//
// 供給元だった `ippoan/rust-flickr` の `GET /stats` は 2026-07-08 の本 repo への
// 移行で廃止済み。旧レポートにあった「検証済 / 未検証残」は、本パイプラインに
// verify 相当の工程が無く D1/R2 にも列が無いため持たない。

import { getArchive, listArchivedDates } from "./archive";
import { countUnuploadedCamFiles, dayStats } from "./d1";
import type { Env } from "./env";

/** 1 撮影日ぶんの登録/アップロード件数。`uploaded` は `flickr_id` が入った件数
 * (`SD_ZOMBIE` sentinel を含む — D1 の `COUNT(flickr_id)` と同じ数え方)。 */
export interface DailyStat {
  date: string;
  files: number;
  uploaded: number;
}

export interface DailyStats {
  /** 撮影日の新しい順。要求 `days` 件を上限に、データがある日だけ返す。 */
  days: DailyStat[];
  /** D1 に残っている未アップロード件数 (= 次回以降の cron が拾う残作業)。
   * アーカイブ済みの日に取り残された分は含まない (そちらは `days` の
   * `files - uploaded` に出る)。 */
  pending: number;
}

export async function collectDailyStats(env: Env, days: number): Promise<DailyStats> {
  const limit = Math.max(0, Math.floor(days));

  // D1 側 (当日/未アーカイブ分)。最も新しい日はここにしか無い。
  const live = await dayStats(env.CAM_DB, limit);
  const liveDates = new Set(live.map((d) => d.date));

  // R2 側 (確定済みの過去日)。D1 に残っている日は二重計上しない。
  //
  // 引くのは `limit` 件で足りる: アーカイブ側を新しい順に辿ると 1 件ごとに
  // 「merged に足す」か「live と重複でスキップ」のどちらかで、スキップは
  // live.length 回までしか起きない。必要な追加は (limit - live.length) 件なので
  // 消費は合計 limit 件を超えない。
  // (#40 の修正前は `limit` を渡すと **古い方**が返ってきたため、暫定で 1000 を
  //  渡して回避していた。今は listArchivedDates が新しい順に切ってくれる。)
  const merged: DailyStat[] = [...live];
  for (const date of await listArchivedDates(env.CAM_ARCHIVE, limit)) {
    if (merged.length >= limit) break;
    if (liveDates.has(date)) continue;
    const archive = await getArchive(env.CAM_ARCHIVE, date);
    if (!archive) continue;
    merged.push({
      date,
      files: archive.files.length,
      uploaded: archive.files.filter((f) => f.flickrId !== null).length,
    });
  }

  merged.sort((a, b) => (a.date < b.date ? 1 : -1));

  // floor を最小値にして D1 の未アップロードを全部数える (D1 には元々当日
  // 付近しか残っていないので、floor による古い行の除外は要らない)。
  const pending = await countUnuploadedCamFiles(env.CAM_DB, "00000000", "000000");

  return { days: merged.slice(0, limit), pending };
}
