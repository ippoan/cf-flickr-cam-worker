import { describe, expect, it } from "vitest";

import { md5Hex } from "../src/md5";

// RFC 1321 Appendix A.5 の既知ベクタ (MD5 実装の標準リファレンス値)。
describe("md5Hex", () => {
  it.each([
    ["", "d41d8cd98f00b204e9800998ecf8427e"],
    ["a", "0cc175b9c0f1b6a831c399e269772661"],
    ["abc", "900150983cd24fb0d6963f7d28e17f72"],
    ["message digest", "f96b697d7cb7938d525a2f31aaf161d0"],
    ["abcdefghijklmnopqrstuvwxyz", "c3fcd3d76192e4007dfb496cca67e13b"],
    [
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
      "d174ab98d277d9f5a5611c2c9f419d9f",
    ],
    [
      "12345678901234567890123456789012345678901234567890123456789012345678901234567890",
      "57edf4a22be3c955ac49da2e2107b67a",
    ],
  ])("MD5(%j) = %s (RFC 1321 known vector)", (input, expected) => {
    expect(md5Hex(input)).toBe(expected);
  });

  it("handles multi-byte UTF-8 input without throwing", () => {
    expect(md5Hex("あ")).toMatch(/^[0-9a-f]{32}$/);
  });

  it("handles input that lands exactly on a 64-byte block boundary", () => {
    // padding が block を跨ぐ境界ケース (55/56/64 byte 前後) を確認
    expect(md5Hex("a".repeat(55))).toMatch(/^[0-9a-f]{32}$/);
    expect(md5Hex("a".repeat(56))).toMatch(/^[0-9a-f]{32}$/);
    expect(md5Hex("a".repeat(64))).toMatch(/^[0-9a-f]{32}$/);
    expect(md5Hex("a".repeat(128))).toMatch(/^[0-9a-f]{32}$/);
  });
});
