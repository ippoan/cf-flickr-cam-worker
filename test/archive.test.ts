import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { archiveDate, getArchive, listArchivedDates } from "../src/archive";
import { lastCamFile, listByDate, upsertCamFile } from "../src/d1";

const db = () => env.CAM_DB;
const bucket = () => env.CAM_ARCHIVE;

beforeEach(async () => {
  await db().prepare("DELETE FROM cam_files").run();
  const listed = await bucket().list();
  await Promise.all(listed.objects.map((o) => bucket().delete(o.key)));
});

describe("archiveDate", () => {
  it("returns 0 and writes nothing when there are no rows for the date", async () => {
    const count = await archiveDate(db(), bucket(), "20260101", 5000);
    expect(count).toBe(0);
    expect(await bucket().get("20260101.json")).toBeNull();
  });

  it("puts a JSON archive to R2 and deletes the rows from D1", async () => {
    await upsertCamFile(db(), "Event20260101_000001.jpg", "20260101", "000000", "jpg", 1000);
    await upsertCamFile(db(), "Event20260101_010000.mp4", "20260101", "010000", "mp4", 1000);
    await upsertCamFile(db(), "Event20260102_000001.jpg", "20260102", "000000", "jpg", 1000);

    const count = await archiveDate(db(), bucket(), "20260101", 5000);
    expect(count).toBe(2);

    // D1 側: アーカイブした日付の行だけ消える
    expect(await listByDate(db(), "20260101")).toEqual([]);
    expect(await listByDate(db(), "20260102")).toHaveLength(1);

    // R2 側: JSON で読める
    const archive = await getArchive(bucket(), "20260101");
    expect(archive?.date).toBe("20260101");
    expect(archive?.archivedAt).toBe(5000);
    expect(archive?.files.map((f) => f.name)).toEqual([
      "Event20260101_000001.jpg",
      "Event20260101_010000.mp4",
    ]);
  });

  it("does not persist image binaries — only cam_files metadata (name/date/hour/type/flickrId)", async () => {
    await upsertCamFile(db(), "a.jpg", "20260101", "000000", "jpg", 1000);
    await archiveDate(db(), bucket(), "20260101", 5000);
    const archive = await getArchive(bucket(), "20260101");
    const keys = Object.keys(archive!.files[0]);
    expect(keys.sort()).toEqual(["createdAt", "date", "flickrId", "hour", "name", "type"]);
  });
});

describe("getArchive", () => {
  it("returns null for a date with no archive", async () => {
    expect(await getArchive(bucket(), "19990101")).toBeNull();
  });
});

/** `20260101` から連番で `count` 日ぶんの日付を古い順に作る (月跨ぎを含む)。 */
function archivedDateRange(count: number): string[] {
  const dates: string[] = [];
  const start = Date.UTC(2026, 0, 1);
  for (let i = 0; i < count; i++) {
    const d = new Date(start + i * 86_400_000);
    dates.push(
      `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`,
    );
  }
  return dates;
}

/** D1 を経由せず R2 に直接アーカイブ JSON を置く (件数を稼ぐため)。 */
async function putArchives(dates: string[]): Promise<void> {
  // 1000 件超のケースがあるので 50 件ずつ並行で置く
  for (let i = 0; i < dates.length; i += 50) {
    await Promise.all(
      dates
        .slice(i, i + 50)
        .map((date) => bucket().put(`${date}.json`, JSON.stringify({ date, archivedAt: 1000, files: [] }))),
    );
  }
}

describe("listArchivedDates", () => {
  it("returns archived dates newest first", async () => {
    await upsertCamFile(db(), "a.jpg", "20260101", "000000", "jpg", 1000);
    await archiveDate(db(), bucket(), "20260101", 5000);
    await upsertCamFile(db(), "b.jpg", "20260103", "000000", "jpg", 1000);
    await archiveDate(db(), bucket(), "20260103", 6000);
    await upsertCamFile(db(), "c.jpg", "20260102", "000000", "jpg", 1000);
    await archiveDate(db(), bucket(), "20260102", 7000);

    expect(await listArchivedDates(bucket())).toEqual(["20260103", "20260102", "20260101"]);
  });

  it("returns an empty list when nothing is archived yet", async () => {
    expect(await listArchivedDates(bucket())).toEqual([]);
  });

  // Refs #40: R2 の list は key の辞書順 (昇順) で先頭から返すので、`limit` を
  // そのまま bucket.list() に渡すと **古い方** だけが返る。60 日を超えた時点で
  // 最近の日付がナビから消えていた。
  it("returns the NEWEST limit dates when there are more archives than limit", async () => {
    const dates = archivedDateRange(65); // > 既定 limit 60
    await putArchives(dates);

    const listed = await listArchivedDates(bucket());

    expect(listed).toHaveLength(60);
    // 新しい順 = 末尾 60 件を反転したもの
    expect(listed).toEqual(dates.slice(-60).reverse());
    // 最新日が含まれる (バグ時はここが 60 件目の古い日になっていた)
    expect(listed[0]).toBe(dates[dates.length - 1]);
    // 溢れたぶんは古い方から落ちる
    expect(listed).not.toContain(dates[0]);
    expect(listed).not.toContain(dates[4]);
  });

  it("pages past the R2 list page size (1000 objects) and still returns the newest", async () => {
    // cursor ループが無いと、ここで返るのは辞書順で先頭 1000 件 = 一番古い方。
    const dates = archivedDateRange(1005);
    await putArchives(dates);

    expect(await listArchivedDates(bucket())).toEqual(dates.slice(-60).reverse());
    expect(await listArchivedDates(bucket(), 3)).toEqual(dates.slice(-3).reverse());
  }, 60_000);

  it("returns every archived date when limit exceeds the number of archives", async () => {
    const dates = archivedDateRange(120);
    await putArchives(dates);

    expect(await listArchivedDates(bucket(), 120)).toEqual(dates.slice().reverse());
    expect(await listArchivedDates(bucket(), 500)).toEqual(dates.slice().reverse());
  });

  it("returns an empty list for a non-positive limit", async () => {
    await putArchives(archivedDateRange(3));
    expect(await listArchivedDates(bucket(), 0)).toEqual([]);
    expect(await listArchivedDates(bucket(), -1)).toEqual([]);
  });

  it("ignores keys that are not {YYYYMMDD}.json", async () => {
    await putArchives(["20260101", "20260102"]);
    await bucket().put("zzz-not-an-archive", "x");
    await bucket().put("20260103.json.bak", "x");

    expect(await listArchivedDates(bucket())).toEqual(["20260102", "20260101"]);
  });
});

describe("archiveDate idempotency (D1 delete only after successful R2 put)", () => {
  it("re-archiving an already-flushed date (no rows left) is a safe no-op", async () => {
    await upsertCamFile(db(), "a.jpg", "20260101", "000000", "jpg", 1000);
    expect(await archiveDate(db(), bucket(), "20260101", 5000)).toBe(1);
    expect(await archiveDate(db(), bucket(), "20260101", 6000)).toBe(0);
    // 最初の archive の内容が上書きされていないことも確認
    const archive = await getArchive(bucket(), "20260101");
    expect(archive?.archivedAt).toBe(5000);
  });
});

// lastCamFile を明示 import しているのは、d1.test.ts と重複しない
// archive 特有の「flush 後は resume 位置計算に影響しない」ことを確認するため。
describe("archiving does not affect resume position for other dates", () => {
  it("lastCamFile still reflects the most recent remaining row after a flush", async () => {
    await upsertCamFile(db(), "Event20260101_000001.jpg", "20260101", "000000", "jpg", 1000);
    await upsertCamFile(db(), "Event20260102_000001.jpg", "20260102", "000000", "jpg", 1000);
    await archiveDate(db(), bucket(), "20260101", 5000);
    expect(await lastCamFile(db())).toEqual({ date: "20260102", hour: "000000" });
  });
});
