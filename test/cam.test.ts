import { describe, expect, it } from "vitest";

import type { CamConfig } from "../src/cam";
import { CamClient, CamUpstreamError, digestResponse, parseDirNames, parseFileNames } from "../src/cam";

function testConfig(overrides: Partial<CamConfig> = {}): CamConfig {
  return {
    digestUser: "user",
    digestPass: "pass",
    machineName: "cam1",
    sdcardCgi: "https://cam.internal/sd/",
    mp4Cgi: "https://cam.internal/mp4/",
    jpgCgi: "https://cam.internal/jpg/",
    cfAccessClientId: "cf-id",
    cfAccessClientSecret: "cf-secret",
    ...overrides,
  };
}

function mockFetch(responses: Response[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  let i = 0;
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return responses[Math.min(i++, responses.length - 1)];
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe("parseDirNames", () => {
  it("extracts the name attribute case-insensitively", () => {
    const xml = `<List><Dir name="20260101"/><Dir Name="20260102"/><Other name="x"/></List>`;
    expect(parseDirNames(xml)).toEqual(["20260101", "20260102"]);
  });

  it("returns empty for malformed input without throwing", () => {
    expect(parseDirNames("<unclosed")).toEqual([]);
  });
});

describe("parseFileNames", () => {
  it("skips camera temp files containing _!", () => {
    const xml = `<List>
      <File><Name>Event20260101_000001.jpg</Name></File>
      <File><Name>Event20260101_!tmp.jpg</Name></File>
      <File><Name>Event20260101_000002.mp4</Name></File>
    </List>`;
    expect(parseFileNames(xml)).toEqual(["Event20260101_000001.jpg", "Event20260101_000002.mp4"]);
  });

  it("returns empty for non-xml input without throwing", () => {
    expect(parseFileNames("not xml at all")).toEqual([]);
  });

  it("decodes basic XML entities", () => {
    const xml = `<Name>a &amp; b.jpg</Name>`;
    expect(parseFileNames(xml)).toEqual(["a & b.jpg"]);
  });
});

describe("digestResponse", () => {
  // RFC 2617 §3.5 の既知ベクタ (qop=auth)。ippoan/rust-flickr /
  // ohishi-exp/ohishi-logi の digest_response_rfc2617_known_vector と同じ値。
  it("matches the RFC 2617 known vector", () => {
    const response = digestResponse(
      "Mufasa",
      "Circle Of Life",
      "GET",
      "/dir/index.html",
      "testrealm@host.com",
      "dcd98b7102dd2f0e8b11d0f600bfb0c093",
      "auth",
      "00000001",
      "0a4f113b",
    );
    expect(response).toBe("6629fae49393a05397450978507c4ef1");
  });

  it("without qop uses the 3-element ha1:nonce:ha2 form (RFC 2069 compat, differs from qop form)", () => {
    const withQop = digestResponse("u", "p", "GET", "/x", "r", "n", "auth", "00000001", "cnonce");
    const withoutQop = digestResponse("u", "p", "GET", "/x", "r", "n", undefined, "0", "0");
    expect(withQop).not.toBe(withoutQop);
    expect(withoutQop).toHaveLength(32);
  });
});

describe("CamClient digest auth retry", () => {
  it("retries with Authorization on 401 Digest challenge, sending CF Access headers on both requests", async () => {
    const { fn, calls } = mockFetch([
      new Response(undefined, {
        status: 401,
        headers: { "www-authenticate": 'Digest realm="cam", nonce="abc123", qop="auth"' },
      }),
      new Response(`<List><Dir name="20260101"/></List>`, { status: 200 }),
    ]);
    const client = new CamClient(testConfig(), fn);
    const dates = await client.listDates();
    expect(dates).toEqual(["20260101"]);
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe("https://cam.internal/sd/cam1/Event");
    expect((calls[0].init?.headers as Record<string, string>)["CF-Access-Client-Id"]).toBe("cf-id");
    const retryHeaders = calls[1].init?.headers as Record<string, string>;
    expect(retryHeaders["CF-Access-Client-Id"]).toBe("cf-id");
    expect(retryHeaders["CF-Access-Client-Secret"]).toBe("cf-secret");
    expect(retryHeaders["Authorization"]).toMatch(/^Digest username="user"/);
  });

  it("propagates non-digest 401 (e.g. Basic) as an upstream error without retrying", async () => {
    const { fn, calls } = mockFetch([
      new Response(undefined, { status: 401, headers: { "www-authenticate": 'Basic realm="cam"' } }),
    ]);
    const client = new CamClient(testConfig(), fn);
    await expect(client.listDates()).rejects.toThrow(CamUpstreamError);
    expect(calls).toHaveLength(1);
  });

  it("list_hours and list_file_names hit nested paths", async () => {
    const responses = [
      new Response(`<List><Dir name="120000"/></List>`, { status: 200 }),
      new Response(`<List><File><Name>Event20260101_120000.jpg</Name></File></List>`, { status: 200 }),
    ];
    let i = 0;
    const seqFn = (async () => responses[i++]) as unknown as typeof fetch;
    const client = new CamClient(testConfig(), seqFn);
    expect(await client.listHours("20260101")).toEqual(["120000"]);
    expect(await client.listFileNames("20260101", "120000")).toEqual(["Event20260101_120000.jpg"]);
  });
});

describe("CamClient.debugListRoot", () => {
  it("returns the raw status/body alongside the same url listDates() would hit", async () => {
    const { fn, calls } = mockFetch([new Response(`<List><Dir name="20260101"/></List>`, { status: 200 })]);
    const client = new CamClient(testConfig(), fn);
    const result = await client.debugListRoot();
    expect(result).toEqual({
      url: "https://cam.internal/sd/cam1/Event",
      status: 200,
      body: `<List><Dir name="20260101"/></List>`,
    });
    expect(calls).toHaveLength(1);
  });

  it("does not throw on a non-ok status — returns it for inspection instead", async () => {
    const { fn } = mockFetch([new Response("not found", { status: 404 })]);
    const client = new CamClient(testConfig(), fn);
    const result = await client.debugListRoot();
    expect(result.status).toBe(404);
    expect(result.body).toBe("not found");
  });
});

describe("CamClient.download", () => {
  it("selects jpg/mp4 CGI by extension and returns bytes for octet-stream", async () => {
    const responses = [
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      }),
    ];
    let i = 0;
    const fn = (async () => responses[i++]) as unknown as typeof fetch;
    const client = new CamClient(testConfig(), fn);
    const bytes = await client.download("a.jpg", "20260101", "120000");
    expect(Array.from(bytes)).toEqual([1, 2, 3]);
  });

  it("rejects non-octet-stream content type (e.g. camera login page)", async () => {
    const responses = [
      new Response("<html>login</html>", { status: 200, headers: { "content-type": "text/html" } }),
    ];
    let i = 0;
    const fn = (async () => responses[i++]) as unknown as typeof fetch;
    const client = new CamClient(testConfig(), fn);
    await expect(client.download("b.mp4", "20260101", "120000")).rejects.toThrow(/unexpected content type/);
  });

  it("uses the mp4 CGI for .mp4 names and jpg CGI otherwise", async () => {
    const calls: string[] = [];
    const fn = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response(new Uint8Array([0]), {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      });
    }) as unknown as typeof fetch;
    const client = new CamClient(testConfig(), fn);
    await client.download("a.jpg", "20260101", "120000");
    await client.download("b.mp4", "20260101", "120000");
    expect(calls[0]).toBe("https://cam.internal/jpg/cam1/Event/20260101/120000/a.jpg");
    expect(calls[1]).toBe("https://cam.internal/mp4/cam1/Event/20260101/120000/b.mp4");
  });
});

describe("CamClient listing error handling", () => {
  it("throws CamUpstreamError when the listing request fails", async () => {
    const fn = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const client = new CamClient(testConfig(), fn);
    await expect(client.listDates()).rejects.toThrow(CamUpstreamError);
  });
});

describe("CamClient.machineName", () => {
  it("exposes the configured machine name", () => {
    const client = new CamClient(testConfig({ machineName: "cam42" }));
    expect(client.machineName).toBe("cam42");
  });
});
