import { describe, expect, it } from "vitest";

import { FlickrClient, FlickrUpstreamError } from "../src/flickr";

function testConfig() {
  return {
    consumerKey: "ck",
    consumerSecret: "cs",
    callbackUrl: "https://example.com/cb",
  };
}

/** fetchImpl mock。呼び出しを記録しつつ response 列を順に返す */
function mockFetch(responses: Response[]) {
  const calls: { input: RequestInfo | URL; init?: RequestInit }[] = [];
  let i = 0;
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init });
    return responses[Math.min(i++, responses.length - 1)];
  }) as unknown as typeof fetch;
  return { fn, calls };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("FlickrClient.getRequestToken", () => {
  it("returns token/secret and builds the authorization url", async () => {
    const { fn, calls } = mockFetch([
      new Response("oauth_callback_confirmed=true&oauth_token=rt&oauth_token_secret=rts"),
    ]);
    const client = new FlickrClient(testConfig(), fn);
    const rt = await client.getRequestToken();
    expect(rt.token).toBe("rt");
    expect(rt.secret).toBe("rts");
    expect(rt.authorizationUrl).toContain("oauth_token=rt&perms=write");

    const auth = (calls[0].init?.headers as Record<string, string>)["Authorization"];
    expect(auth).toMatch(/^OAuth /);
    expect(auth).toContain('oauth_consumer_key="ck"');
    expect(auth).toContain('oauth_callback="https%3A%2F%2Fexample.com%2Fcb"');
    expect(auth).toContain("oauth_signature=");
  });

  it("throws FlickrUpstreamError (not a silent 200) on non-2xx upstream", async () => {
    const { fn } = mockFetch([new Response("oauth_problem=consumer_key_rejected", { status: 401 })]);
    const client = new FlickrClient(testConfig(), fn);
    await expect(client.getRequestToken()).rejects.toThrow(FlickrUpstreamError);
  });

  it("throws when oauth_token_secret is missing from the response", async () => {
    const { fn } = mockFetch([new Response("oauth_token=rt")]);
    const client = new FlickrClient(testConfig(), fn);
    await expect(client.getRequestToken()).rejects.toThrow(/oauth_token_secret/);
  });
});

describe("FlickrClient.getAccessToken", () => {
  it("exchanges verifier for an access token", async () => {
    const { fn, calls } = mockFetch([
      new Response("oauth_token=at&oauth_token_secret=ats&user_nsid=12345%40N00&username=tester"),
    ]);
    const client = new FlickrClient(testConfig(), fn);
    const at = await client.getAccessToken("rt", "verifier", "rts");
    expect(at.token).toBe("at");
    expect(at.secret).toBe("ats");
    expect(at.userNsid).toBe("12345%40N00");
    expect(at.username).toBe("tester");

    const auth = (calls[0].init?.headers as Record<string, string>)["Authorization"];
    expect(auth).toContain('oauth_token="rt"');
    expect(auth).toContain('oauth_verifier="verifier"');
  });

  it("defaults nsid/username to empty string when absent", async () => {
    const { fn } = mockFetch([new Response("oauth_token=at&oauth_token_secret=ats")]);
    const client = new FlickrClient(testConfig(), fn);
    const at = await client.getAccessToken("rt", "v", "rts");
    expect(at.userNsid).toBe("");
    expect(at.username).toBe("");
  });
});

describe("FlickrClient.photosGetInfo", () => {
  it("splits OAuth params (header) from API params (query)", async () => {
    const { fn, calls } = mockFetch([
      jsonResponse(200, { photo: { id: "5050", server: "65535", secret: "abc123" }, stat: "ok" }),
    ]);
    const client = new FlickrClient(testConfig(), fn);
    const photo = await client.photosGetInfo("5050", "at", "ats");
    expect(photo).toEqual({ id: "5050", server: "65535", secret: "abc123" });

    const url = new URL(calls[0].input as string);
    expect(url.searchParams.get("method")).toBe("flickr.photos.getInfo");
    expect(url.searchParams.get("photo_id")).toBe("5050");
    expect(url.searchParams.has("oauth_signature")).toBe(false);
    const auth = (calls[0].init?.headers as Record<string, string>)["Authorization"];
    expect(auth).toContain('oauth_token="at"');
    expect(auth).toContain("oauth_signature=");
    expect(auth).not.toContain("photo_id");
  });

  it("throws on stat=fail", async () => {
    const { fn } = mockFetch([jsonResponse(200, { stat: "fail" })]);
    const client = new FlickrClient(testConfig(), fn);
    await expect(client.photosGetInfo("404404", "at", "ats")).rejects.toThrow(/stat=fail/);
  });

  it("throws on non-2xx", async () => {
    const { fn } = mockFetch([new Response("oops", { status: 500 })]);
    const client = new FlickrClient(testConfig(), fn);
    await expect(client.photosGetInfo("1", "at", "ats")).rejects.toThrow(FlickrUpstreamError);
  });
});

describe("FlickrClient.uploadPhoto", () => {
  it("returns the photoid on success", async () => {
    const { fn, calls } = mockFetch([
      new Response('<?xml version="1.0"?><rsp stat="ok"><photoid>9876</photoid></rsp>'),
    ]);
    const client = new FlickrClient(testConfig(), fn);
    const id = await client.uploadPhoto("at", "ats", "Event20260101_000001.jpg", new Uint8Array([1, 2, 3]));
    expect(id).toBe("9876");
    expect(calls[0].init?.method).toBe("POST");
    expect(calls[0].init?.body).toBeInstanceOf(FormData);
  });

  it("does not echo the upstream body on error (avoid leaking internals)", async () => {
    const { fn } = mockFetch([new Response("secret internals", { status: 500 })]);
    const client = new FlickrClient(testConfig(), fn);
    let message = "";
    try {
      await client.uploadPhoto("at", "ats", "x.jpg", new Uint8Array([0]));
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("flickr upload failed");
    expect(message).not.toContain("secret internals");
  });

  it("throws when stat=fail (photoid missing)", async () => {
    const { fn } = mockFetch([
      new Response('<rsp stat="fail"><err code="98" msg="Invalid auth token"/></rsp>'),
    ]);
    const client = new FlickrClient(testConfig(), fn);
    await expect(client.uploadPhoto("at", "ats", "x.jpg", new Uint8Array([0]))).rejects.toThrow(
      /photoid not found/,
    );
  });
});

describe("FlickrClient default endpoints", () => {
  it("uses the real Flickr hosts when no overrides are given", async () => {
    // ネットワークは叩かず、fetchImpl 呼び出し引数の URL だけを検証する
    const { fn, calls } = mockFetch([new Response("oauth_token=rt&oauth_token_secret=rts")]);
    const client = new FlickrClient(testConfig(), fn);
    await client.getRequestToken();
    expect(calls[0].input).toBe("https://www.flickr.com/services/oauth/request_token");
  });
});
