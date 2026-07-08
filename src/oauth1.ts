// SOURCE-MIRROR: ippoan/rust-flickr:src/oauth1.rs (2026-07-08 TypeScript 移植)
//
// OAuth 1.0a 署名ヘルパ。MD5 (Digest 認証) と違い HMAC-SHA1 は Web Crypto API
// (`crypto.subtle`) が Workers runtime で native support しているため、ここは
// Cloud Run (ohishi-logi) ではなく本 Worker 側に実装する (2026-07-08 方針決定、
// Refs ohishi-exp/ohishi-logi#1)。

/** パーセントエンコード (RFC 5849 §3.6)。バイト単位でエンコードするため
 * マルチバイト UTF-8 文字も個々のバイトごとに %XX になる
 * (rust-flickr の `percent_encode("あ") == "%E3%81%82"` と同じ挙動)。 */
export function percentEncode(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let result = "";
  for (const byte of bytes) {
    const ch = String.fromCharCode(byte);
    if (/^[A-Za-z0-9\-._~]$/.test(ch)) {
      result += ch;
    } else {
      result += "%" + byte.toString(16).toUpperCase().padStart(2, "0");
    }
  }
  return result;
}

function base64Encode(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

async function hmacSha1Base64(key: string, message: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(message));
  return base64Encode(signature);
}

/** OAuth 1.0a 署名 (HMAC-SHA1) を生成 */
export async function sign(
  method: string,
  url: string,
  params: Record<string, string>,
  consumerSecret: string,
  tokenSecret: string | undefined,
): Promise<string> {
  const sortedKeys = Object.keys(params).sort();
  const paramString = sortedKeys
    .map((k) => `${percentEncode(k)}=${percentEncode(params[k])}`)
    .join("&");

  const signatureBase = [method.toUpperCase(), percentEncode(url), percentEncode(paramString)].join(
    "&",
  );

  const signingKey = `${percentEncode(consumerSecret)}&${tokenSecret ? percentEncode(tokenSecret) : ""}`;

  return hmacSha1Base64(signingKey, signatureBase);
}

/** ノンス生成 (UUIDv4 のハイフン抜き) */
export function nonce(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

/** UNIX 秒タイムスタンプ */
export function timestamp(): string {
  return Math.floor(Date.now() / 1000).toString();
}

/** `Authorization: OAuth ...` ヘッダ値 (の OAuth 以降) を構築 */
export function authHeader(params: Record<string, string>): string {
  return Object.keys(params)
    .sort()
    .map((k) => `${percentEncode(k)}="${percentEncode(params[k])}"`)
    .join(", ");
}

/** `k1=v1&k2=v2` 形式の form-encoded レスポンスをパース */
export function parseForm(body: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const pair of body.split("&")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    result[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return result;
}

/** OAuth パラメータ (`oauth_*`) と API パラメータを分離する
 * (flickr.photos.getInfo 等、OAuth ヘッダとクエリを分けて送る呼び出し用)。 */
const OAUTH_KEYS = new Set([
  "oauth_consumer_key",
  "oauth_nonce",
  "oauth_signature_method",
  "oauth_timestamp",
  "oauth_token",
  "oauth_version",
  "oauth_signature",
]);

export function oauthSignedParams(params: Record<string, string>): {
  authParams: Record<string, string>;
  queryParams: Record<string, string>;
} {
  const authParams: Record<string, string> = {};
  const queryParams: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    if (OAUTH_KEYS.has(k)) authParams[k] = v;
    else queryParams[k] = v;
  }
  return { authParams, queryParams };
}
