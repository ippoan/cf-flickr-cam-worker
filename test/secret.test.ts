import { describe, expect, it } from "vitest";

import { resolveSecret } from "../src/secret";

describe("resolveSecret", () => {
  it("returns null for undefined", async () => {
    expect(await resolveSecret(undefined)).toBeNull();
  });

  it("returns the value as-is for a plain string (vitest / wrangler dev)", async () => {
    expect(await resolveSecret("plain-value")).toBe("plain-value");
  });

  it("resolves a SecretsStoreSecret via .get() (production binding)", async () => {
    const binding = { get: async () => "resolved-value" } as unknown as SecretsStoreSecret;
    expect(await resolveSecret(binding)).toBe("resolved-value");
  });

  it("returns null when .get() resolves to an empty string", async () => {
    const binding = { get: async () => "" } as unknown as SecretsStoreSecret;
    expect(await resolveSecret(binding)).toBeNull();
  });

  it("returns null when .get() throws", async () => {
    const binding = {
      get: async () => {
        throw new Error("boom");
      },
    } as unknown as SecretsStoreSecret;
    expect(await resolveSecret(binding)).toBeNull();
  });
});
