import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { archiveDate } from "../src/archive";
import { setCamFileFlickrId, upsertCamFile } from "../src/d1";
import { collectDailyStats } from "../src/stats";

const db = () => env.CAM_DB;
const bucket = () => env.CAM_ARCHIVE;

beforeEach(async () => {
  await db().prepare("DELETE FROM cam_files").run();
  const listed = await bucket().list();
  await Promise.all(listed.objects.map((o) => bucket().delete(o.key)));
});

/** `date` に `files` 件入れ、先頭 `uploaded` 件だけ upload 済みにする。 */
async function seedDay(date: string, files: number, uploaded: number): Promise<void> {
  for (let i = 0; i < files; i++) {
    const name = `Event${date}_${String(i).padStart(6, "0")}.jpg`;
    await upsertCamFile(db(), name, date, String(i).padStart(6, "0"), "jpg", 1000);
    if (i < uploaded) await setCamFileFlickrId(db(), name, `${date}${i}`);
  }
}

describe("collectDailyStats", () => {
  it("returns an empty window when there is no data at all", async () => {
    expect(await collectDailyStats(env, 20)).toEqual({ days: [], pending: 0 });
  });

  it("counts D1 rows (当日/未アーカイブ分) and the pending upload backlog", async () => {
    await seedDay("20260110", 3, 1);

    expect(await collectDailyStats(env, 20)).toEqual({
      days: [{ date: "20260110", files: 3, uploaded: 1 }],
      pending: 2,
    });
  });

  it("counts archived days from R2 and leaves pending to D1 only", async () => {
    await seedDay("20260108", 4, 3);
    await archiveDate(db(), bucket(), "20260108", 5000);

    // アーカイブ済みの取り残し (4-3=1) は pending には含めず days に出す
    expect(await collectDailyStats(env, 20)).toEqual({
      days: [{ date: "20260108", files: 4, uploaded: 3 }],
      pending: 0,
    });
  });

  it("merges D1 and R2 into one window, newest date first", async () => {
    await seedDay("20260108", 2, 2);
    await archiveDate(db(), bucket(), "20260108", 5000);
    await seedDay("20260109", 5, 5);
    await archiveDate(db(), bucket(), "20260109", 5000);
    await seedDay("20260110", 3, 1); // D1 に残る当日分

    const stats = await collectDailyStats(env, 20);
    expect(stats.days).toEqual([
      { date: "20260110", files: 3, uploaded: 1 },
      { date: "20260109", files: 5, uploaded: 5 },
      { date: "20260108", files: 2, uploaded: 2 },
    ]);
    expect(stats.pending).toBe(2);
  });

  it("does not double-count a date that exists in both D1 and R2", async () => {
    await seedDay("20260110", 2, 2);
    await archiveDate(db(), bucket(), "20260110", 5000);
    // アーカイブ後に同じ日の続きが D1 へ入り直したケース (当日中の再 scrape)
    await seedDay("20260110", 3, 0);

    const stats = await collectDailyStats(env, 20);
    expect(stats.days).toEqual([{ date: "20260110", files: 3, uploaded: 0 }]);
  });

  it("keeps the newest `days` entries and drops older ones", async () => {
    for (const date of ["20260107", "20260108", "20260109"]) {
      await seedDay(date, 1, 1);
      await archiveDate(db(), bucket(), date, 5000);
    }
    await seedDay("20260110", 1, 1);

    const stats = await collectDailyStats(env, 2);
    expect(stats.days.map((d) => d.date)).toEqual(["20260110", "20260109"]);
  });

  it("returns an empty window for days <= 0 (pending は変わらず数える)", async () => {
    await seedDay("20260110", 1, 0);
    expect(await collectDailyStats(env, 0)).toEqual({ days: [], pending: 1 });
  });
});
