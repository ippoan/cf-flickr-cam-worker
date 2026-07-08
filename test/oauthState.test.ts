import { describe, expect, it } from "vitest";

import { signState, verifyState } from "../src/oauthState";

describe("signState / verifyState", () => {
  it("round-trips a signed state", async () => {
    const signed = await signState({ token: "rt", secret: "rts" }, "test-secret");
    expect(await verifyState(signed, "test-secret")).toEqual({ token: "rt", secret: "rts" });
  });

  it("rejects a tampered payload", async () => {
    const signed = await signState({ token: "rt", secret: "rts" }, "test-secret");
    const [payload, signature] = signed.split(".");
    const tamperedPayload = payload.slice(0, -1) + (payload.at(-1) === "A" ? "B" : "A");
    expect(await verifyState(`${tamperedPayload}.${signature}`, "test-secret")).toBeNull();
  });

  it("rejects a signature made with a different secret", async () => {
    const signed = await signState({ token: "rt", secret: "rts" }, "test-secret");
    expect(await verifyState(signed, "wrong-secret")).toBeNull();
  });

  it("rejects malformed cookie values", async () => {
    expect(await verifyState("not-a-valid-cookie", "test-secret")).toBeNull();
  });

  it("rejects a validly-signed payload missing required fields", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const signed = await signState({ token: "rt" } as any, "test-secret");
    expect(await verifyState(signed, "test-secret")).toBeNull();
  });
});
