import { describe, expect, it } from "vitest";

import { authHeader, nonce, parseForm, percentEncode, sign, timestamp } from "../src/oauth1";

describe("percentEncode", () => {
  it("passes unreserved characters through unchanged", () => {
    expect(percentEncode("AZaz09-._~")).toBe("AZaz09-._~");
  });

  it("percent-encodes reserved characters and UTF-8 byte-wise", () => {
    expect(percentEncode("a b&c")).toBe("a%20b%26c");
    expect(percentEncode("Ladies + Gentlemen")).toBe("Ladies%20%2B%20Gentlemen");
    // マルチバイト UTF-8 はバイト単位でエンコードされる
    expect(percentEncode("あ")).toBe("%E3%81%82");
  });
});

describe("sign", () => {
  // 既知ベクトル: Twitter "Creating a signature" docs と同系の入力。
  // rust-flickr の sign_known_vector と同じ期待値 (python oauthlib 3.2.2 で
  // 独立計算 = sort → base string → signing key → HMAC-SHA1 → base64)。
  it("matches the known vector", async () => {
    const params: Record<string, string> = {
      status: "Hello Ladies + Gentlemen, a signed OAuth request!",
      include_entities: "true",
      oauth_consumer_key: "xvz1evFS4wEEPTGEFPHBog",
      oauth_nonce: "kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg",
      oauth_signature_method: "HMAC-SHA1",
      oauth_timestamp: "1318622958",
      oauth_token: "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb",
      oauth_version: "1.0",
    };
    const signature = await sign(
      "POST",
      "https://api.twitter.com/1.1/statuses/update.json",
      params,
      "kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw",
      "LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE",
    );
    expect(signature).toBe("hCtSmYh+iHYCEqBWrE7C7hYmtUk=");
  });

  it("treats missing token secret the same as an empty one", async () => {
    const params = { oauth_consumer_key: "key" };
    const withUndefined = await sign("GET", "https://example.com/", params, "secret", undefined);
    const withEmpty = await sign("GET", "https://example.com/", params, "secret", "");
    expect(withUndefined).toBe(withEmpty);
  });
});

describe("nonce", () => {
  it("is unique and contains no hyphens", () => {
    const a = nonce();
    const b = nonce();
    expect(a).not.toBe(b);
    expect(a).not.toContain("-");
    expect(a.length).toBe(32);
  });
});

describe("timestamp", () => {
  it("is a numeric unix seconds string", () => {
    const ts = Number(timestamp());
    expect(ts).toBeGreaterThan(1_700_000_000);
  });
});

describe("authHeader", () => {
  it("sorts keys and quotes/encodes values", () => {
    const header = authHeader({ b: "2 2", a: "1" });
    expect(header).toBe('a="1", b="2%202"');
  });
});

describe("parseForm", () => {
  it("parses basic key=value pairs", () => {
    const parsed = parseForm("oauth_token=abc&oauth_token_secret=def&ok=true");
    expect(parsed.oauth_token).toBe("abc");
    expect(parsed.oauth_token_secret).toBe("def");
    expect(parsed.ok).toBe("true");
  });

  it("skips malformed pairs without an =", () => {
    const parsed = parseForm("novalue&k=v");
    expect(Object.keys(parsed)).toEqual(["k"]);
    expect(parsed.k).toBe("v");
  });
});
