import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { CamClient } from "../src/cam";
import { lastCamFile, listByDate } from "../src/d1";
import { FlickrClient } from "../src/flickr";
import { syncCamFiles } from "../src/sync";

const db = () => env.CAM_DB;

const CAM_CONFIG = {
  digestUser: "u",
  digestPass: "p",
  machineName: "cam1",
  sdcardCgi: "https://cam.internal/sd/",
  mp4Cgi: "https://cam.internal/mp4/",
  jpgCgi: "https://cam.internal/jpg/",
};

const FLICKR_CONFIG = { consumerKey: "ck", consumerSecret: "cs", callbackUrl: "https://x/cb" };
const ACCESS_TOKEN = { token: "at", secret: "ats", userNsid: "1", username: "tester" };

beforeEach(async () => {
  await db().prepare("DELETE FROM cam_files").run();
});

/** SD カード応答を date -> hours -> files の固定テーブルから返す fetch mock。
 * download 呼び出しは downloadHandler に委譲する (SD_ZOMBIE テスト等で使う)。 */
function camFetchFrom(
  tree: Record<string, Record<string, string[]>>,
  downloadHandler?: (url: string) => Response,
): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    const m = url.match(/\/sd\/cam1\/Event(?:\/(\d+))?(?:\/(\d+))?$/);
    if (m) {
      const [, date, hour] = m;
      if (!date) {
        return new Response(
          `<List>${Object.keys(tree)
            .map((d) => `<Dir name="${d}"/>`)
            .join("")}</List>`,
        );
      }
      if (!hour) {
        const hours = Object.keys(tree[date] ?? {});
        return new Response(`<List>${hours.map((h) => `<Dir name="${h}"/>`).join("")}</List>`);
      }
      const files = tree[date]?.[hour] ?? [];
      return new Response(`<List>${files.map((f) => `<File><Name>${f}</Name></File>`).join("")}</List>`);
    }
    if (downloadHandler) return downloadHandler(url);
    return new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { "content-type": "application/octet-stream" },
    });
  }) as unknown as typeof fetch;
}

describe("syncCamFiles — first run bootstrap", () => {
  it("starts from the earliest SD date when no cam_files rows exist yet (deviates from upstream 400)", async () => {
    const cam = new CamClient(
      CAM_CONFIG,
      camFetchFrom({ "20260102": { "000000": ["Event20260102_000001.jpg"] } }),
    );
    const result = await syncCamFiles(db(), cam, null, null, null, 0, 1000);
    expect(result.newFiles).toBe(1);
    expect(await lastCamFile(db())).toEqual({ date: "20260102", hour: "000000" });
  });
});

describe("syncCamFiles — resume position", () => {
  it("only processes hours >= start_hour on the start_date, but all hours on later dates", async () => {
    const cam = new CamClient(
      CAM_CONFIG,
      camFetchFrom({
        "20260101": {
          "090000": ["Event20260101_090000.jpg"], // start_date と同日、start_hour 未満 → 除外
          "150000": ["Event20260101_150000.jpg"], // start_date と同日、start_hour 以上 → 含む
        },
        "20260102": {
          "000000": ["Event20260102_000000.jpg"], // 翌日は hour 無条件で含む
        },
      }),
    );
    const result = await syncCamFiles(db(), cam, null, null, { date: "20260101", hour: "120000" }, 0, 1000);
    expect(result.newFiles).toBe(2);
    const day1 = await listByDate(db(), "20260101");
    expect(day1.map((r) => r.name)).toEqual(["Event20260101_150000.jpg"]);
  });

  it("ignores SD dates older than the resume position", async () => {
    const cam = new CamClient(
      CAM_CONFIG,
      camFetchFrom({
        "20251231": { "000000": ["Event20251231_000000.jpg"] },
        "20260101": { "000000": ["Event20260101_000000.jpg"] },
      }),
    );
    const result = await syncCamFiles(db(), cam, null, null, { date: "20260101", hour: "000000" }, 0, 1000);
    expect(result.processedDates).toBe(1);
    expect(result.newFiles).toBe(1);
  });
});

describe("syncCamFiles — upload loop", () => {
  it("uploads unuploaded files to Flickr and records the flickr id", async () => {
    const cam = new CamClient(
      CAM_CONFIG,
      camFetchFrom({ "20260101": { "000000": ["Event20260101_000000.jpg"] } }),
    );
    let uploadCalled = false;
    const flickr = new FlickrClient(FLICKR_CONFIG, (async (input: RequestInfo | URL) => {
      uploadCalled = true;
      expect(String(input)).toBe("https://up.flickr.com/services/upload/");
      return new Response('<rsp stat="ok"><photoid>999</photoid></rsp>');
    }) as unknown as typeof fetch);

    const result = await syncCamFiles(db(), cam, flickr, ACCESS_TOKEN, null, 10, 1000);
    expect(uploadCalled).toBe(true);
    expect(result.uploadedCount).toBe(1);
    expect(result.uploadErrors).toBe(0);
    expect(result.remainingUnuploaded).toBe(0);
    const rows = await listByDate(db(), "20260101");
    expect(rows[0].flickrId).toBe("999");
  });

  it("does not upload when uploadLimit is 0", async () => {
    const cam = new CamClient(
      CAM_CONFIG,
      camFetchFrom({ "20260101": { "000000": ["Event20260101_000000.jpg"] } }),
    );
    let uploadCalled = false;
    const flickr = new FlickrClient(FLICKR_CONFIG, (async () => {
      uploadCalled = true;
      return new Response('<rsp stat="ok"><photoid>999</photoid></rsp>');
    }) as unknown as typeof fetch);

    const result = await syncCamFiles(db(), cam, flickr, ACCESS_TOKEN, null, 0, 1000);
    expect(uploadCalled).toBe(false);
    expect(result.uploadedCount).toBe(0);
    expect(result.remainingUnuploaded).toBe(1);
  });

  it("does not upload when flickr client or access token is absent (not yet authorized)", async () => {
    const cam = new CamClient(
      CAM_CONFIG,
      camFetchFrom({ "20260101": { "000000": ["Event20260101_000000.jpg"] } }),
    );
    const result = await syncCamFiles(db(), cam, null, null, null, 10, 1000);
    expect(result.uploadedCount).toBe(0);
    expect(result.remainingUnuploaded).toBe(1);
  });

  it("marks SD_ZOMBIE when the camera returns text/plain for a download (file rotated off SD) instead of counting it as an error", async () => {
    const cam = new CamClient(
      CAM_CONFIG,
      camFetchFrom(
        { "20260101": { "000000": ["Event20260101_000000.jpg"] } },
        () => new Response("gone", { status: 200, headers: { "content-type": "text/plain" } }),
      ),
    );
    const flickr = new FlickrClient(FLICKR_CONFIG, (async () => {
      throw new Error("should not be called — download failed first");
    }) as unknown as typeof fetch);

    const result = await syncCamFiles(db(), cam, flickr, ACCESS_TOKEN, null, 10, 1000);
    expect(result.zombiedCount).toBe(1);
    expect(result.uploadErrors).toBe(0);
    expect(result.uploadedCount).toBe(0);
    expect(result.remainingUnuploaded).toBe(0); // SD_ZOMBIE も flickr_id が付くので unuploaded から外れる
    const rows = await listByDate(db(), "20260101");
    expect(rows[0].flickrId).toBe("SD_ZOMBIE");
  });

  it("counts genuine upload failures as uploadErrors without marking SD_ZOMBIE", async () => {
    const cam = new CamClient(
      CAM_CONFIG,
      camFetchFrom({ "20260101": { "000000": ["Event20260101_000000.jpg"] } }),
    );
    const flickr = new FlickrClient(FLICKR_CONFIG, (async () => new Response("server error", { status: 500 })) as unknown as typeof fetch);

    const result = await syncCamFiles(db(), cam, flickr, ACCESS_TOKEN, null, 10, 1000);
    expect(result.uploadErrors).toBe(1);
    expect(result.zombiedCount).toBe(0);
    expect(result.remainingUnuploaded).toBe(1); // 未アップロードのまま残る = 次回再試行対象
  });

  it("uploads in oldest-first (name ascending) order, competing with SD rotation", async () => {
    const cam = new CamClient(
      CAM_CONFIG,
      camFetchFrom({
        "20260101": {
          "000000": ["Event20260101_000000.jpg"],
          "120000": ["Event20260101_120000.jpg"],
        },
      }),
    );
    const uploadedOrder: string[] = [];
    const flickr = new FlickrClient(FLICKR_CONFIG, (async (_input, init) => {
      const form = init?.body as FormData;
      uploadedOrder.push(form.get("title") as string);
      return new Response('<rsp stat="ok"><photoid>1</photoid></rsp>');
    }) as unknown as typeof fetch);

    await syncCamFiles(db(), cam, flickr, ACCESS_TOKEN, null, 10, 1000);
    expect(uploadedOrder).toEqual(["Event20260101_000000.jpg", "Event20260101_120000.jpg"]);
  });
});

describe("syncCamFiles — message summary", () => {
  it("includes counts in the human-readable message", async () => {
    const cam = new CamClient(
      CAM_CONFIG,
      camFetchFrom({ "20260101": { "000000": ["Event20260101_000000.jpg"] } }),
    );
    const result = await syncCamFiles(db(), cam, null, null, null, 0, 1000);
    expect(result.message).toContain("1 dates");
    expect(result.message).toContain("1 hours");
    expect(result.message).toContain("1 files");
  });
});
