import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { listByDate, listDates, upsertCamFile } from "../src/d1";
import { camConfigFrom, flickrConfigFrom, runScheduled, todayUtc } from "../src/scheduled";

// runScheduled は既定で env.CAM_SERVICE.fetch を使うが、vitest-pool-workers は
// vpc_services binding を未対応 (env.CAM_SERVICE は undefined) なので、全テスト
// で camFetch を明示的に DI する。
function noopCamFetch(): typeof fetch {
  return (async () => new Response("<List></List>")) as unknown as typeof fetch;
}

beforeEach(async () => {
  await env.CAM_DB.prepare("DELETE FROM cam_files").run();
  const objects = await env.CAM_ARCHIVE.list();
  await Promise.all(objects.objects.map((o) => env.CAM_ARCHIVE.delete(o.key)));
});

describe("todayUtc", () => {
  it("formats as YYYYMMDD in UTC", () => {
    expect(todayUtc(Date.parse("2026-07-08T12:34:56Z"))).toBe("20260708");
  });
});

describe("camConfigFrom", () => {
  it("returns null when any CAM_* field is missing", () => {
    expect(camConfigFrom({ ...env, CAM_DIGEST_USER: "" })).toBeNull();
  });

  it("builds a full config when all fields are set", () => {
    const config = camConfigFrom(env);
    expect(config).toMatchObject({ digestUser: "test-user", machineName: "cam1" });
  });
});

describe("flickrConfigFrom", () => {
  it("returns null when FLICKR_* is not fully set", () => {
    expect(flickrConfigFrom({ ...env, FLICKR_CONSUMER_KEY: "" })).toBeNull();
  });

  it("builds a config when FLICKR_* is set", () => {
    expect(flickrConfigFrom(env)).toMatchObject({ consumerKey: "test-consumer-key" });
  });
});

describe("runScheduled", () => {
  it("skips (logs a warning) when CAM_* is not configured", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await runScheduled({ ...env, CAM_DIGEST_USER: "" }, Date.now(), noopCamFetch());
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("CAM_*"));
    warn.mockRestore();
  });

  it("syncs new camera files into D1", async () => {
    const camFetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/Event")) return new Response(`<List><Dir name="20260101"/></List>`);
      if (url.endsWith("/Event/20260101")) return new Response(`<List><Dir name="000000"/></List>`);
      return new Response(`<List><File><Name>Event20260101_000000.jpg</Name></File></List>`);
    }) as unknown as typeof fetch;

    // "今日" を 20260101 に合わせ、sync 直後に archive ループで即座に消えないようにする
    await runScheduled(env, Date.parse("2026-01-01T00:00:00Z"), camFetch);
    const rows = await listByDate(env.CAM_DB, "20260101");
    expect(rows.map((r) => r.name)).toEqual(["Event20260101_000000.jpg"]);
  });

  it("archives dates other than today, but keeps today's date in D1", async () => {
    await upsertCamFile(env.CAM_DB, "Event20260101_000000.jpg", "20260101", "000000", "jpg", 1000);
    await upsertCamFile(env.CAM_DB, "Event20260102_000000.jpg", "20260102", "000000", "jpg", 1000);

    // 20260102 を「今日」とする — カメラは何も返さない (SD 側は空)
    await runScheduled(env, Date.parse("2026-01-02T12:00:00Z"), noopCamFetch());

    const dates = await listDates(env.CAM_DB);
    // 20260101 はアーカイブされ D1 から消え、今日 (20260102) だけが残る。
    // R2 に実際に書けたことは archiveDate 自体の専用テスト (archive.test.ts) で
    // 検証済みなので、ここでは D1 側の状態 (= archiveDate が呼ばれた結果) だけ見る。
    expect(dates).toEqual(["20260102"]);
  });
});
