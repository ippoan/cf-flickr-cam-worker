import { describe, expect, it } from "vitest";

import { getAccessToken } from "../src/tokens";

describe("getAccessToken", () => {
  it("returns null when the secret is not set", () => {
    expect(getAccessToken(undefined)).toBeNull();
  });

  it("parses a well-formed FLICKR_ACCESS_TOKEN_JSON", () => {
    const json = JSON.stringify({ token: "at", secret: "ats", userNsid: "1@N00", username: "tester" });
    expect(getAccessToken(json)).toEqual({ token: "at", secret: "ats", userNsid: "1@N00", username: "tester" });
  });

  it("returns null for invalid JSON", () => {
    expect(getAccessToken("not json")).toBeNull();
  });

  it("returns null when a required field is missing", () => {
    expect(getAccessToken(JSON.stringify({ token: "at", secret: "ats" }))).toBeNull();
  });
});
