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
