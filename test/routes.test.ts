import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { archiveDate } from "../src/archive";
import { upsertCamFile } from "../src/d1";
import { createApp } from "../src/routes";

function mockFetch(responses: Response[]) {
  let i = 0;
  return (async () => responses[Math.min(i++, responses.length - 1)]) as unknown as typeof fetch;
}

/** Set-Cookie ヘッダ (`name=value; Path=/; ...`) から `name=value` だけを抜き出し、
 * 次のリクエストの Cookie ヘッダとして使えるようにする。 */
function cookieHeaderFrom(res: Response): string {
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error("no set-cookie header on response");
  return setCookie.split(";")[0];
}

function accessTokenJson(overrides: Partial<Record<"token" | "secret" | "userNsid" | "username", string>> = {}) {
  return JSON.stringify({ token: "at", secret: "ats", userNsid: "1", username: "tester", ...overrides });
}

beforeEach(async () => {
  await env.CAM_DB.prepare("DELETE FROM cam_files").run();
  const objects = await env.CAM_ARCHIVE.list();
  await Promise.all(objects.objects.map((o) => env.CAM_ARCHIVE.delete(o.key)));
});

describe("GET /health", () => {
  it("returns ok status", async () => {
    const res = await createApp().request("/health", {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("ok");
    expect(body.service).toBe("cf-flickr-cam-worker");
  });
});

describe("unknown routes", () => {
  it("returns 404 for unmatched path", async () => {
    const res = await createApp().request("/nope", {}, env);
    expect(res.status).toBe(404);
  });
});

describe("GET /oauth/url", () => {
  it("returns 503 when FLICKR_* is not configured", async () => {
    const res = await createApp().request("/oauth/url", {}, { ...env, FLICKR_CONSUMER_KEY: "" });
    expect(res.status).toBe(503);
  });

  it("returns 503 when OAUTH_STATE_SECRET is not configured", async () => {
    const res = await createApp().request("/oauth/url", {}, { ...env, OAUTH_STATE_SECRET: "" });
    expect(res.status).toBe(503);
  });

  it("sets the oauth_state cookie and returns the authorization url", async () => {
    const fetchImpl = mockFetch([new Response("oauth_token=rt&oauth_token_secret=rts")]);
    const res = await createApp(fetchImpl).request("/oauth/url", {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { authorization_url: string };
    expect(body.authorization_url).toContain("oauth_token=rt");
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("oauth_state=");
    expect(setCookie).toContain("HttpOnly");
  });

  it("propagates upstream failure as 424, not a silent 200", async () => {
    const fetchImpl = mockFetch([new Response("oauth_problem=x", { status: 401 })]);
    const res = await createApp(fetchImpl).request("/oauth/url", {}, env);
    expect(res.status).toBe(424);
  });
});

describe("GET /oauth/start (browser redirect flow)", () => {
  it("503s when FLICKR_* is not configured", async () => {
    const res = await createApp().request("/oauth/start", {}, { ...env, FLICKR_CONSUMER_KEY: "" });
    expect(res.status).toBe(503);
  });

  it("sets the oauth_state cookie and 302-redirects to the Flickr authorization url", async () => {
    const fetchImpl = mockFetch([new Response("oauth_token=rt&oauth_token_secret=rts")]);
    const res = await createApp(fetchImpl).request("/oauth/start", { redirect: "manual" }, env);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("oauth_token=rt");
    expect(res.headers.get("set-cookie") ?? "").toContain("oauth_state=");
  });
});

describe("GET /oauth/callback (browser redirect flow)", () => {
  it("400s when oauth_token/oauth_verifier are missing", async () => {
    const res = await createApp().request("/oauth/callback", {}, env);
    expect(res.status).toBe(400);
  });

  it("400s when there is no oauth_state cookie (not previously issued via /oauth/start)", async () => {
    const res = await createApp().request("/oauth/callback?oauth_token=rt&oauth_verifier=v", {}, env);
    expect(res.status).toBe(400);
  });

  it("400s when the cookie's token doesn't match the query's oauth_token", async () => {
    const startRes = await createApp(mockFetch([new Response("oauth_token=rt&oauth_token_secret=rts")])).request(
      "/oauth/start",
      { redirect: "manual" },
      env,
    );
    const cookie = cookieHeaderFrom(startRes);

    const res = await createApp().request(
      "/oauth/callback?oauth_token=different&oauth_verifier=v",
      { headers: { Cookie: cookie } },
      env,
    );
    expect(res.status).toBe(400);
  });

  it("exchanges the verifier and shows the one-time access token page without redirecting", async () => {
    const startRes = await createApp(mockFetch([new Response("oauth_token=rt&oauth_token_secret=rts")])).request(
      "/oauth/start",
      { redirect: "manual" },
      env,
    );
    const cookie = cookieHeaderFrom(startRes);

    const fetchImpl = mockFetch([
      new Response("oauth_token=at&oauth_token_secret=ats&user_nsid=1%40N00&username=tester"),
    ]);
    const res = await createApp(fetchImpl).request(
      "/oauth/callback?oauth_token=rt&oauth_verifier=v",
      { headers: { Cookie: cookie } },
      env,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("tester");
    expect(html).toContain("ats"); // 一度きりの表示ページなので、この画面には出す
    expect(html).toContain("secret-inject");
    // 使い捨て cookie は破棄される
    expect(res.headers.get("set-cookie") ?? "").toContain("oauth_state=;");
  });
});

// 注: KV 版では request_token_secret を取得と同時に削除して「1回きり」を
// サーバー側で強制していたが、署名付き cookie はステートレスなため同じ cookie
// を TTL 内に複数回提示すること自体は妨げない。実際の一度きり性は Flickr 側の
// oauth_token/oauth_verifier 交換が一度使うと無効化される (再利用は upstream が
// 424 で拒否する) ことに委ねている。

describe("GET /oauth/status", () => {
  it("reports unauthorized when nothing is saved", async () => {
    const res = await createApp().request("/oauth/status", {}, env);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ authorized: false, username: null });
  });

  it("reports authorized when FLICKR_ACCESS_TOKEN_JSON is set", async () => {
    const res = await createApp().request("/oauth/status", {}, { ...env, FLICKR_ACCESS_TOKEN_JSON: accessTokenJson() });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ authorized: true, username: "tester" });
  });
});

describe("GET / (status page)", () => {
  it("renders a connect prompt when not authorized", async () => {
    const res = await createApp().request("/", {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("未接続");
    expect(html).toContain("/oauth/start");
  });

  it("renders the connected username and day stats when authorized and synced", async () => {
    await upsertCamFile(env.CAM_DB, "a.jpg", "20260101", "000000", "jpg", 1000);
    const res = await createApp().request("/", {}, { ...env, FLICKR_ACCESS_TOKEN_JSON: accessTokenJson() });
    const html = await res.text();
    expect(html).toContain("tester");
    expect(html).toContain("20260101");
  });

  it("shows deploy time (JST) and version from version_metadata (#32)", async () => {
    const res = await createApp().request(
      "/",
      {},
      {
        ...env,
        CF_VERSION_METADATA: { id: "abcdef1234567890", tag: "", timestamp: "2026-07-08T03:15:00Z" },
      },
    );
    const html = await res.text();
    expect(html).toContain("2026-07-08 12:15:00 JST"); // UTC+9
    expect(html).toContain("version abcdef12"); // id 先頭8桁
  });

  it("falls back to 'unknown' deploy info when version_metadata is absent (#32)", async () => {
    const res = await createApp().request("/", {}, { ...env, CF_VERSION_METADATA: undefined });
    const html = await res.text();
    expect(html).toContain("deploy: unknown");
    expect(html).toContain("version unknown");
  });

  it("prefixes nav/form links with PUBLIC_PATH_PREFIX so they route through the proxy (#30)", async () => {
    const res = await createApp().request("/", {}, env);
    const html = await res.text();
    // nav・接続ボタン・同期フォームが proxy prefix 付きで出る
    expect(html).toContain(`href="/cf-flickr-cam-worker-proxy/"`);
    expect(html).toContain(`href="/cf-flickr-cam-worker-proxy/images"`);
    expect(html).toContain(`href="/cf-flickr-cam-worker-proxy/oauth/start"`);
    expect(html).toContain(`action="/cf-flickr-cam-worker-proxy/admin/sync"`);
    // prefix 抜きの裸リンクが残っていない (nav の href="/" 等)
    expect(html).not.toContain(`href="/images"`);
  });

  it("omits the prefix when PUBLIC_PATH_PREFIX is unset (direct access / tests)", async () => {
    const res = await createApp().request("/", {}, { ...env, PUBLIC_PATH_PREFIX: "" });
    const html = await res.text();
    expect(html).toContain(`href="/images"`);
    expect(html).toContain(`action="/admin/sync"`);
  });
});

describe("GET /images (image browsing page)", () => {
  it("shows a message when there is no data yet", async () => {
    const res = await createApp().request("/images", {}, env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("まだデータがありません");
  });

  it("lists live (D1) files for the current date with upload status badges", async () => {
    await upsertCamFile(env.CAM_DB, "Event20260101_000000.jpg", "20260101", "000000", "jpg", 1000);
    await upsertCamFile(env.CAM_DB, "Event20260101_010000.jpg", "20260101", "010000", "jpg", 1000);
    const { setCamFileFlickrId } = await import("../src/d1");
    await setCamFileFlickrId(env.CAM_DB, "Event20260101_010000.jpg", "SD_ZOMBIE");

    const res = await createApp().request("/images?date=20260101", {}, env);
    const html = await res.text();
    expect(html).toContain("Event20260101_000000.jpg");
    expect(html).toContain("未アップロード");
    expect(html).toContain("SD消失");
  });

  it("falls back to an archived (R2) date when it is no longer in D1", async () => {
    await upsertCamFile(env.CAM_DB, "Event20260101_000000.jpg", "20260101", "000000", "jpg", 1000);
    await archiveDate(env.CAM_DB, env.CAM_ARCHIVE, "20260101", 5000);

    const res = await createApp().request("/images?date=20260101", {}, env);
    const html = await res.text();
    expect(html).toContain("Event20260101_000000.jpg");
  });

  it("defaults to the most recent available date when none is requested", async () => {
    await upsertCamFile(env.CAM_DB, "a.jpg", "20260101", "000000", "jpg", 1000);
    await upsertCamFile(env.CAM_DB, "b.jpg", "20260102", "000000", "jpg", 1000);
    const res = await createApp().request("/images", {}, env);
    const html = await res.text();
    expect(html).toContain("b.jpg");
  });

  it("links uploaded files to the Flickr photo page using the authorized user's nsid", async () => {
    const { setCamFileFlickrId } = await import("../src/d1");
    await upsertCamFile(env.CAM_DB, "a.jpg", "20260101", "000000", "jpg", 1000);
    await setCamFileFlickrId(env.CAM_DB, "a.jpg", "987654");

    const res = await createApp().request(
      "/images?date=20260101",
      {},
      { ...env, FLICKR_ACCESS_TOKEN_JSON: accessTokenJson({ userNsid: "12345" }) },
    );
    const html = await res.text();
    expect(html).toContain("https://www.flickr.com/photos/12345/987654");
  });

  it("renders an inline thumbnail via /images/photo for uploaded files", async () => {
    const { setCamFileFlickrId } = await import("../src/d1");
    await upsertCamFile(env.CAM_DB, "a.jpg", "20260101", "000000", "jpg", 1000);
    await setCamFileFlickrId(env.CAM_DB, "a.jpg", "987654");

    const res = await createApp().request("/images?date=20260101", {}, env);
    const html = await res.text();
    // proxy prefix 付き。Hono JSX は属性内の & を &amp; にエスケープする (#30)
    expect(html).toContain(`src="/cf-flickr-cam-worker-proxy/images/photo/987654?date=20260101&amp;size=m"`);
    expect(html).toContain(`href="/cf-flickr-cam-worker-proxy/images/photo/987654?date=20260101&amp;size=b"`);
  });

  it("does not render a thumbnail for SD_ZOMBIE (no real photo)", async () => {
    const { setCamFileFlickrId } = await import("../src/d1");
    await upsertCamFile(env.CAM_DB, "z.jpg", "20260101", "000000", "jpg", 1000);
    await setCamFileFlickrId(env.CAM_DB, "z.jpg", "SD_ZOMBIE");

    const res = await createApp().request("/images?date=20260101", {}, env);
    const html = await res.text();
    expect(html).not.toContain("/images/photo/SD_ZOMBIE");
  });
});

describe("POST /admin/sync", () => {
  it("returns 503 when CAM_* is not configured", async () => {
    const camService = { fetch: mockFetch([new Response("<List></List>")]) } as unknown as Fetcher;
    const res = await createApp().request(
      "/admin/sync",
      { method: "POST" },
      { ...env, CAM_DIGEST_USER: "", CAM_SERVICE: camService },
    );
    expect(res.status).toBe(503);
  });

  it("runs the scrape/upload and returns the sync result", async () => {
    const camService = { fetch: mockFetch([new Response("<List></List>")]) } as unknown as Fetcher;
    const res = await createApp().request(
      "/admin/sync",
      { method: "POST" },
      { ...env, CAM_SERVICE: camService },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toHaveProperty("message");
    expect(body).toHaveProperty("processedDates");
  });

  it("accepts a valid ?date=YYYYMMDD override and runs the sync", async () => {
    const camService = { fetch: mockFetch([new Response("<List></List>")]) } as unknown as Fetcher;
    const res = await createApp().request(
      "/admin/sync?date=20260101",
      { method: "POST" },
      { ...env, CAM_SERVICE: camService },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toHaveProperty("processedDates");
  });

  it("rejects a malformed ?date with 400 before touching the camera", async () => {
    const camService = { fetch: mockFetch([new Response("<List></List>")]) } as unknown as Fetcher;
    const res = await createApp().request(
      "/admin/sync?date=2026-01-01",
      { method: "POST" },
      { ...env, CAM_SERVICE: camService },
    );
    expect(res.status).toBe(400);
  });
});

describe("GET /admin/debug/cam", () => {
  it("returns 503 when CAM_* is not configured", async () => {
    const camService = { fetch: mockFetch([new Response("<List></List>")]) } as unknown as Fetcher;
    const res = await createApp().request(
      "/admin/debug/cam",
      {},
      { ...env, CAM_DIGEST_USER: "", CAM_SERVICE: camService },
    );
    expect(res.status).toBe(503);
  });

  it("returns the raw SD-card root response alongside the parsed dates", async () => {
    const camService = {
      fetch: mockFetch([new Response(`<List><Dir name="20260101"/></List>`, { status: 200 })]),
    } as unknown as Fetcher;
    const res = await createApp().request("/admin/debug/cam", {}, { ...env, CAM_SERVICE: camService });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe(200);
    expect(body.body).toBe(`<List><Dir name="20260101"/></List>`);
    expect(body.parsedDates).toEqual(["20260101"]);
    expect(body).toHaveProperty("url");
  });
});

describe("GET /images/list", () => {
  it("returns availableDates and files as JSON", async () => {
    await upsertCamFile(env.CAM_DB, "Event20260101_000000.jpg", "20260101", "000000", "jpg", 1000);
    const res = await createApp().request("/images/list?date=20260101", {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { date: string; availableDates: string[]; files: unknown[] };
    expect(body.date).toBe("20260101");
    expect(body.availableDates).toContain("20260101");
    expect(body.files).toHaveLength(1);
  });

  it("attaches photoUrl to uploaded photos and null otherwise", async () => {
    await upsertCamFile(env.CAM_DB, "Event20260101_000000.jpg", "20260101", "000000", "jpg", 1000);
    await upsertCamFile(env.CAM_DB, "Event20260101_010000.jpg", "20260101", "010000", "jpg", 1000);
    const { setCamFileFlickrId } = await import("../src/d1");
    await setCamFileFlickrId(env.CAM_DB, "Event20260101_000000.jpg", "12345");
    await setCamFileFlickrId(env.CAM_DB, "Event20260101_010000.jpg", "SD_ZOMBIE");

    const res = await createApp().request("/images/list?date=20260101", {}, env);
    const body = (await res.json()) as { files: { name: string; flickrId: string | null; photoUrl: string | null }[] };
    const uploaded = body.files.find((f) => f.name === "Event20260101_000000.jpg");
    const zombie = body.files.find((f) => f.name === "Event20260101_010000.jpg");
    // proxy prefix (wrangler vars 由来) + date 付きで archive も引ける (#28/#30)
    expect(uploaded?.photoUrl).toBe("/cf-flickr-cam-worker-proxy/images/photo/12345?date=20260101");
    expect(zombie?.photoUrl).toBeNull(); // SD_ZOMBIE は実写真ではない
  });

  it("rejects a malformed date with 400", async () => {
    const res = await createApp().request("/images/list?date=2026-01-01", {}, env);
    expect(res.status).toBe(400);
  });
});

describe("GET /images/photo/:flickrId", () => {
  async function seedUploaded(flickrId: string) {
    await upsertCamFile(env.CAM_DB, "Event20260101_000000.jpg", "20260101", "000000", "jpg", 1000);
    const { setCamFileFlickrId } = await import("../src/d1");
    await setCamFileFlickrId(env.CAM_DB, "Event20260101_000000.jpg", flickrId);
  }

  it("400s for a non-numeric id", async () => {
    const res = await createApp().request("/images/photo/abc", {}, env);
    expect(res.status).toBe(400);
  });

  it("400s for an unknown size", async () => {
    await seedUploaded("12345");
    const res = await createApp().request(
      "/images/photo/12345?size=huge",
      {},
      { ...env, FLICKR_ACCESS_TOKEN_JSON: accessTokenJson() },
    );
    expect(res.status).toBe(400);
  });

  it("404s when the id is not a known (D1-recorded) photo", async () => {
    const res = await createApp().request(
      "/images/photo/999",
      {},
      { ...env, FLICKR_ACCESS_TOKEN_JSON: accessTokenJson() },
    );
    expect(res.status).toBe(404);
  });

  it("503s when not authorized with Flickr", async () => {
    await seedUploaded("12345");
    const res = await createApp().request("/images/photo/12345", {}, env);
    expect(res.status).toBe(503);
  });

  it("302-redirects to the Flickr static CDN url for a known photo (default size b)", async () => {
    await seedUploaded("12345");
    const fetchImpl = mockFetch([
      new Response(JSON.stringify({ stat: "ok", photo: { id: "12345", server: "65535", secret: "abcdef" } })),
    ]);
    const res = await createApp(fetchImpl).request(
      "/images/photo/12345",
      { redirect: "manual" },
      { ...env, FLICKR_ACCESS_TOKEN_JSON: accessTokenJson() },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://live.staticflickr.com/65535/12345_abcdef_b.jpg");
  });

  it("honors an explicit ?size=", async () => {
    await seedUploaded("12345");
    const fetchImpl = mockFetch([
      new Response(JSON.stringify({ stat: "ok", photo: { id: "12345", server: "65535", secret: "abcdef" } })),
    ]);
    const res = await createApp(fetchImpl).request(
      "/images/photo/12345?size=z",
      { redirect: "manual" },
      { ...env, FLICKR_ACCESS_TOKEN_JSON: accessTokenJson() },
    );
    expect(res.headers.get("location")).toBe("https://live.staticflickr.com/65535/12345_abcdef_z.jpg");
  });

  it("resolves an archived (D1-deleted) photo via ?date= and 302-redirects", async () => {
    // アップロード済み→archive→D1 削除、という日次フローを再現する
    await upsertCamFile(env.CAM_DB, "Event20260101_000000.jpg", "20260101", "000000", "jpg", 1000);
    const { setCamFileFlickrId } = await import("../src/d1");
    await setCamFileFlickrId(env.CAM_DB, "Event20260101_000000.jpg", "12345");
    const { archiveDate } = await import("../src/archive");
    await archiveDate(env.CAM_DB, env.CAM_ARCHIVE, "20260101", 2000); // D1 から消え R2 へ

    const fetchImpl = mockFetch([
      new Response(JSON.stringify({ stat: "ok", photo: { id: "12345", server: "65535", secret: "abcdef" } })),
    ]);
    const res = await createApp(fetchImpl).request(
      "/images/photo/12345?date=20260101",
      { redirect: "manual" },
      { ...env, FLICKR_ACCESS_TOKEN_JSON: accessTokenJson() },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://live.staticflickr.com/65535/12345_abcdef_b.jpg");
  });

  it("still 404s for an archived id when ?date= is omitted", async () => {
    await upsertCamFile(env.CAM_DB, "Event20260101_000000.jpg", "20260101", "000000", "jpg", 1000);
    const { setCamFileFlickrId } = await import("../src/d1");
    await setCamFileFlickrId(env.CAM_DB, "Event20260101_000000.jpg", "12345");
    const { archiveDate } = await import("../src/archive");
    await archiveDate(env.CAM_DB, env.CAM_ARCHIVE, "20260101", 2000);

    const res = await createApp().request(
      "/images/photo/12345",
      {},
      { ...env, FLICKR_ACCESS_TOKEN_JSON: accessTokenJson() },
    );
    expect(res.status).toBe(404);
  });

  it("502s when the Flickr getInfo call fails", async () => {
    await seedUploaded("12345");
    const fetchImpl = mockFetch([new Response("boom", { status: 500 })]);
    const res = await createApp(fetchImpl).request(
      "/images/photo/12345",
      {},
      { ...env, FLICKR_ACCESS_TOKEN_JSON: accessTokenJson() },
    );
    expect(res.status).toBe(502);
  });
});
