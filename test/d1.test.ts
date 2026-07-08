import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import {
  countUnuploadedCamFiles,
  dayStats,
  deleteByDate,
  lastCamFile,
  listByDate,
  listDates,
  listUnuploadedCamFiles,
  setCamFileFlickrId,
  upsertCamFile,
} from "../src/d1";

const db = () => env.CAM_DB;

beforeEach(async () => {
  await db().prepare("DELETE FROM cam_files").run();
});

describe("upsertCamFile / lastCamFile", () => {
  it("returns null when the table is empty", async () => {
    expect(await lastCamFile(db())).toBeNull();
  });

  it("inserts a new row and lastCamFile returns it", async () => {
    await upsertCamFile(db(), "Event20260101_000001.jpg", "20260101", "000000", "jpg", 1000);
    expect(await lastCamFile(db())).toEqual({ date: "20260101", hour: "000000" });
  });

  it("picks the lexicographically-last name (= latest by camera naming convention)", async () => {
    await upsertCamFile(db(), "Event20260101_000001.jpg", "20260101", "000000", "jpg", 1000);
    await upsertCamFile(db(), "Event20260102_120000.jpg", "20260102", "120000", "jpg", 2000);
    expect(await lastCamFile(db())).toEqual({ date: "20260102", hour: "120000" });
  });

  it("upserting an existing name updates date/hour/type without erroring", async () => {
    await upsertCamFile(db(), "Event20260101_000001.jpg", "20260101", "000000", "jpg", 1000);
    await upsertCamFile(db(), "Event20260101_000001.jpg", "20260102", "010000", "mp4", 1000);
    const rows = await listByDate(db(), "20260102");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ date: "20260102", hour: "010000", type: "mp4" });
  });
});

describe("listUnuploadedCamFiles / countUnuploadedCamFiles", () => {
  beforeEach(async () => {
    await upsertCamFile(db(), "Event20260101_000001.jpg", "20260101", "000000", "jpg", 1000);
    await upsertCamFile(db(), "Event20260101_120000.jpg", "20260101", "120000", "jpg", 1000);
    await upsertCamFile(db(), "Event20260102_000001.jpg", "20260102", "000000", "jpg", 1000);
    await setCamFileFlickrId(db(), "Event20260101_000001.jpg", "flickr-1");
  });

  it("excludes already-uploaded files and orders by name ascending (oldest first)", async () => {
    const rows = await listUnuploadedCamFiles(db(), "20260101", "000000", 10);
    expect(rows.map((r) => r.name)).toEqual(["Event20260101_120000.jpg", "Event20260102_000001.jpg"]);
  });

  it("applies the (date,hour) floor: excludes rows below the floor hour on the floor date", async () => {
    const rows = await listUnuploadedCamFiles(db(), "20260101", "130000", 10);
    expect(rows.map((r) => r.name)).toEqual(["Event20260102_000001.jpg"]);
  });

  it("respects the limit", async () => {
    const rows = await listUnuploadedCamFiles(db(), "20260101", "000000", 1);
    expect(rows).toHaveLength(1);
  });

  it("countUnuploadedCamFiles matches the same floor predicate", async () => {
    expect(await countUnuploadedCamFiles(db(), "20260101", "000000")).toBe(2);
    expect(await countUnuploadedCamFiles(db(), "20260101", "130000")).toBe(1);
  });
});

describe("setCamFileFlickrId", () => {
  it("records the flickr id (or SD_ZOMBIE sentinel) and removes the row from unuploaded listing", async () => {
    await upsertCamFile(db(), "a.jpg", "20260101", "000000", "jpg", 1000);
    await setCamFileFlickrId(db(), "a.jpg", "SD_ZOMBIE");
    expect(await countUnuploadedCamFiles(db(), "20260101", "000000")).toBe(0);
  });
});

describe("listByDate / deleteByDate (archive flush support)", () => {
  it("lists all rows for a date in name order and deleteByDate removes them", async () => {
    await upsertCamFile(db(), "Event20260101_000001.jpg", "20260101", "000000", "jpg", 1000);
    await upsertCamFile(db(), "Event20260101_010000.mp4", "20260101", "010000", "mp4", 1000);
    await upsertCamFile(db(), "Event20260102_000001.jpg", "20260102", "000000", "jpg", 1000);

    const rows = await listByDate(db(), "20260101");
    expect(rows.map((r) => r.name)).toEqual(["Event20260101_000001.jpg", "Event20260101_010000.mp4"]);

    await deleteByDate(db(), "20260101");
    expect(await listByDate(db(), "20260101")).toEqual([]);
    expect(await listByDate(db(), "20260102")).toHaveLength(1);
  });
});

describe("listDates", () => {
  it("returns distinct dates in ascending order", async () => {
    await upsertCamFile(db(), "a.jpg", "20260102", "000000", "jpg", 1000);
    await upsertCamFile(db(), "b.jpg", "20260101", "000000", "jpg", 1000);
    await upsertCamFile(db(), "c.jpg", "20260101", "010000", "jpg", 1000);
    expect(await listDates(db())).toEqual(["20260101", "20260102"]);
  });
});

describe("dayStats", () => {
  it("aggregates files/uploaded counts per date, newest first, limited", async () => {
    await upsertCamFile(db(), "a.jpg", "20260101", "000000", "jpg", 1000);
    await upsertCamFile(db(), "b.jpg", "20260101", "010000", "jpg", 1000);
    await setCamFileFlickrId(db(), "a.jpg", "flickr-a");
    await upsertCamFile(db(), "c.jpg", "20260102", "000000", "jpg", 1000);

    const stats = await dayStats(db(), 10);
    expect(stats).toEqual([
      { date: "20260102", files: 1, uploaded: 0 },
      { date: "20260101", files: 2, uploaded: 1 },
    ]);
  });

  it("respects the limit", async () => {
    await upsertCamFile(db(), "a.jpg", "20260101", "000000", "jpg", 1000);
    await upsertCamFile(db(), "b.jpg", "20260102", "000000", "jpg", 1000);
    expect(await dayStats(db(), 1)).toHaveLength(1);
  });
});
