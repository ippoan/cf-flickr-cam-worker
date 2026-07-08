import { describe, expect, it } from "vitest";

import type { Env } from "../src/env";
import { handleRequest } from "../src/routes";
import { createFakeKV } from "./kv-fake";

function testEnv(overrides: Partial<Env> = {}): Env {
  return {
    FLICKR_TOKENS: createFakeKV() as unknown as Env["FLICKR_TOKENS"],
    FLICKR_CONSUMER_KEY: "ck",
    FLICKR_CONSUMER_SECRET: "cs",
    FLICKR_CALLBACK_URL: "https://example.com/oauth/callback",
    ...overrides,
  };
}

function mockFetch(responses: Response[]) {
  let i = 0;
  return (async () => responses[Math.min(i++, responses.length - 1)]) as unknown as typeof fetch;
}

describe("GET /health", () => {
  it("returns ok status", async () => {
    const res = await handleRequest(new Request("https://worker.example/health"), testEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("ok");
    expect(body.service).toBe("cf-flickr-cam-worker");
  });
});

describe("unknown routes", () => {
  it("returns 404 for unmatched path", async () => {
    const res = await handleRequest(new Request("https://worker.example/nope"), testEnv());
    expect(res.status).toBe(404);
  });
});

describe("GET /oauth/url", () => {
  it("returns 503 when FLICKR_* is not configured", async () => {
    const env = testEnv({ FLICKR_CONSUMER_KEY: "" });
    const res = await handleRequest(new Request("https://worker.example/oauth/url"), env);
    expect(res.status).toBe(503);
  });

  it("stores the request token secret and returns the authorization url", async () => {
    const env = testEnv();
    const fetchImpl = mockFetch([new Response("oauth_token=rt&oauth_token_secret=rts")]);
    const res = await handleRequest(new Request("https://worker.example/oauth/url"), env, fetchImpl);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { authorization_url: string };
    expect(body.authorization_url).toContain("oauth_token=rt");
    expect(await env.FLICKR_TOKENS.get("flickr:request_token:rt")).toBe("rts");
  });

  it("propagates upstream failure as 424, not a silent 200", async () => {
    const env = testEnv();
    const fetchImpl = mockFetch([new Response("oauth_problem=x", { status: 401 })]);
    const res = await handleRequest(new Request("https://worker.example/oauth/url"), env, fetchImpl);
    expect(res.status).toBe(424);
  });
});

describe("GET /oauth/callback", () => {
  it("400s when oauth_token/oauth_verifier are missing", async () => {
    const res = await handleRequest(new Request("https://worker.example/oauth/callback"), testEnv());
    expect(res.status).toBe(400);
  });

  it("400s when the oauth_token is unknown (not previously issued via /oauth/url)", async () => {
    const env = testEnv();
    const res = await handleRequest(
      new Request("https://worker.example/oauth/callback?oauth_token=unknown&oauth_verifier=v"),
      env,
    );
    expect(res.status).toBe(400);
  });

  it("exchanges the verifier, saves the access token, and does not echo the secret", async () => {
    const env = testEnv();
    await env.FLICKR_TOKENS.put("flickr:request_token:rt", "rts");
    const fetchImpl = mockFetch([
      new Response("oauth_token=at&oauth_token_secret=ats&user_nsid=1%40N00&username=tester"),
    ]);
    const res = await handleRequest(
      new Request("https://worker.example/oauth/callback?oauth_token=rt&oauth_verifier=v"),
      env,
      fetchImpl,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ user_nsid: "1%40N00", username: "tester", saved: true });
    expect(JSON.stringify(body)).not.toContain("ats");

    const saved = await env.FLICKR_TOKENS.get("flickr:access_token");
    expect(JSON.parse(saved!).secret).toBe("ats");
    // request token は 1 回きり (使い捨て)
    expect(await env.FLICKR_TOKENS.get("flickr:request_token:rt")).toBeNull();
  });
});

describe("GET /oauth/status", () => {
  it("reports unauthorized when nothing is saved", async () => {
    const res = await handleRequest(new Request("https://worker.example/oauth/status"), testEnv());
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ authorized: false, username: null });
  });

  it("reports authorized after a token is saved", async () => {
    const env = testEnv();
    await env.FLICKR_TOKENS.put(
      "flickr:access_token",
      JSON.stringify({ token: "at", secret: "ats", userNsid: "1", username: "tester" }),
    );
    const res = await handleRequest(new Request("https://worker.example/oauth/status"), env);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ authorized: true, username: "tester" });
  });
});
