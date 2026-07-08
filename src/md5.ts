// Pure-JS MD5 (RFC 1321)。Web Crypto API (`crypto.subtle`) は SHA-1/256/384/512
// のみ対応で MD5 を持たないため、カメラの HTTP Digest 認証 (RFC 2617、MD5 必須)
// に使う分だけ自前実装する。既知ベクタでピンしてあるので改変時は必ずテストを通す。

const S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14,
  20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10,
  15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);

function leftRotate(x: number, c: number): number {
  return ((x << c) | (x >>> (32 - c))) >>> 0;
}

/** input を MD5 pad 済みの 512bit ブロック列 (Uint32Array, little-endian word) に変換 */
function toBlocks(input: Uint8Array): Uint32Array {
  const bitLen = input.length * 8;
  const padded = new Uint8Array(Math.ceil((input.length + 9) / 64) * 64);
  padded.set(input);
  padded[input.length] = 0x80;
  const view = new DataView(padded.buffer);
  // MD5 は 64bit length を little-endian で末尾 8 byte に書く (2^32 未満の入力しか
  // 扱わないので上位 32bit は常に 0)
  view.setUint32(padded.length - 8, bitLen >>> 0, true);
  view.setUint32(padded.length - 4, 0, true);

  const words = new Uint32Array(padded.length / 4);
  for (let i = 0; i < words.length; i++) {
    words[i] = view.getUint32(i * 4, true);
  }
  return words;
}

/** MD5 digest を計算し、生の 16 byte を返す */
export function md5(input: Uint8Array): Uint8Array {
  const words = toBlocks(input);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  for (let chunk = 0; chunk < words.length; chunk += 16) {
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;

    for (let i = 0; i < 64; i++) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      f = (f + a + K[i] + words[chunk + g]) >>> 0;
      a = d;
      d = c;
      c = b;
      b = (b + leftRotate(f, S[i])) >>> 0;
    }

    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }

  const out = new Uint8Array(16);
  const view = new DataView(out.buffer);
  view.setUint32(0, a0, true);
  view.setUint32(4, b0, true);
  view.setUint32(8, c0, true);
  view.setUint32(12, d0, true);
  return out;
}

/** MD5 digest を小文字 hex で返す (Rust `format!("{:x}", Md5::digest(..))` と同じ形) */
export function md5Hex(input: string): string {
  const bytes = md5(new TextEncoder().encode(input));
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
