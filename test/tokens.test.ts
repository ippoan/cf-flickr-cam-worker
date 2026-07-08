import { describe, expect, it } from "vitest";

import { getAccessToken, saveAccessToken, saveRequestTokenSecret, takeRequestTokenSecret } from "../src/tokens";
import { createFakeKV } from "./kv-fake";

describe("request token secret", () => {
  it("round-trips and is consumed on take (one-shot)", async () => {
    const kv = createFakeKV();
    await saveRequestTokenSecret(kv, "rt", "rts");
    expect(await takeRequestTokenSecret(kv, "rt")).toBe("rts");
    // 2 回目は無い (削除済み)
    expect(await takeRequestTokenSecret(kv, "rt")).toBeNull();
  });

  it("returns null for an unknown oauth_token", async () => {
    const kv = createFakeKV();
    expect(await takeRequestTokenSecret(kv, "unknown")).toBeNull();
  });

  it("stores with an expirationTtl so stale handshakes don't linger", async () => {
    const kv = createFakeKV();
    let capturedTtl: number | undefined;
    const spyKv = {
      ...kv,
      put: async (key: string, value: string, options?: { expirationTtl?: number }) => {
        capturedTtl = options?.expirationTtl;
        await kv.put(key, value, options);
      },
    };
    await saveRequestTokenSecret(spyKv, "rt", "rts");
    expect(capturedTtl).toBe(600);
  });
});

describe("access token", () => {
  it("round-trips the full token payload", async () => {
    const kv = createFakeKV();
    const token = { token: "at", secret: "ats", userNsid: "1@N00", username: "tester" };
    await saveAccessToken(kv, token);
    expect(await getAccessToken(kv)).toEqual(token);
  });

  it("returns null when nothing is saved yet", async () => {
    const kv = createFakeKV();
    expect(await getAccessToken(kv)).toBeNull();
  });
});
