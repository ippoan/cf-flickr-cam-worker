import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { archiveDate } from "../src/archive";
import { upsertCamFile } from "../src/d1";
import { createApp } from "../src/routes";

function mockFetch(responses: Response[]) {
  let i = 0;
  return (async () => responses[Math.min(i++, responses.length - 1)]) as unknown as typeof fetch;
}

beforeEach(async () => {
  await env.CAM_DB.prepare("DELETE FROM cam_files").run();
  const keys = await env.FLICKR_TOKENS.list();
  await Promise.all(keys.keys.map((k) => env.FLICKR_TOKENS.delete(k.name)));
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

  it("stores the request token secret and returns the authorization url", async () => {
    const fetchImpl = mockFetch([new Response("oauth_token=rt&oauth_token_secret=rts")]);
    const res = await createApp(fetchImpl).request("/oauth/url", {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { authorization_url: string };
    expect(body.authorization_url).toContain("oauth_token=rt");
    expect(await env.FLICKR_TOKENS.get("flickr:request_token:rt")).toBe("rts");
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

  it("stores the request token secret and 302-redirects to the Flickr authorization url", async () => {
    const fetchImpl = mockFetch([new Response("oauth_token=rt&oauth_token_secret=rts")]);
    const res = await createApp(fetchImpl).request("/oauth/start", { redirect: "manual" }, env);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("oauth_token=rt");
    expect(await env.FLICKR_TOKENS.get("flickr:request_token:rt")).toBe("rts");
  });
});

describe("GET /oauth/callback (browser redirect flow)", () => {
  it("400s when oauth_token/oauth_verifier are missing", async () => {
    const res = await createApp().request("/oauth/callback", {}, env);
    expect(res.status).toBe(400);
  });

  it("400s when the oauth_token is unknown (not previously issued via /oauth/start)", async () => {
    const res = await createApp().request("/oauth/callback?oauth_token=unknown&oauth_verifier=v", {}, env);
    expect(res.status).toBe(400);
  });

  it("exchanges the verifier, saves the access token, and redirects to / without echoing the secret", async () => {
    await env.FLICKR_TOKENS.put("flickr:request_token:rt", "rts");
    const fetchImpl = mockFetch([
      new Response("oauth_token=at&oauth_token_secret=ats&user_nsid=1%40N00&username=tester"),
    ]);
    const res = await createApp(fetchImpl).request(
      "/oauth/callback?oauth_token=rt&oauth_verifier=v",
      { redirect: "manual" },
      env,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    expect(await res.text()).not.toContain("ats");

    const saved = await env.FLICKR_TOKENS.get("flickr:access_token");
    expect(JSON.parse(saved!).secret).toBe("ats");
    // request token は 1 回きり (使い捨て)
    expect(await env.FLICKR_TOKENS.get("flickr:request_token:rt")).toBeNull();
  });
});

describe("GET /oauth/status", () => {
  it("reports unauthorized when nothing is saved", async () => {
    const res = await createApp().request("/oauth/status", {}, env);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ authorized: false, username: null });
  });

  it("reports authorized after a token is saved", async () => {
    await env.FLICKR_TOKENS.put(
      "flickr:access_token",
      JSON.stringify({ token: "at", secret: "ats", userNsid: "1", username: "tester" }),
    );
    const res = await createApp().request("/oauth/status", {}, env);
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
    await env.FLICKR_TOKENS.put(
      "flickr:access_token",
      JSON.stringify({ token: "at", secret: "ats", userNsid: "1", username: "tester" }),
    );
    await upsertCamFile(env.CAM_DB, "a.jpg", "20260101", "000000", "jpg", 1000);
    const res = await createApp().request("/", {}, env);
    const html = await res.text();
    expect(html).toContain("tester");
    expect(html).toContain("20260101");
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
    await env.FLICKR_TOKENS.put(
      "flickr:access_token",
      JSON.stringify({ token: "at", secret: "ats", userNsid: "12345", username: "tester" }),
    );
    const { setCamFileFlickrId } = await import("../src/d1");
    await upsertCamFile(env.CAM_DB, "a.jpg", "20260101", "000000", "jpg", 1000);
    await setCamFileFlickrId(env.CAM_DB, "a.jpg", "987654");

    const res = await createApp().request("/images?date=20260101", {}, env);
    const html = await res.text();
    expect(html).toContain("https://www.flickr.com/photos/12345/987654");
  });
});
