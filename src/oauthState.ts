// OAuth1.0a ハンドシェイク中 (`/oauth/start` → Flickr 認可画面 → `/oauth/callback`)
// の request_token_secret を、KV を使わず署名付き HttpOnly cookie に載せるための
// ヘルパ。CF Secrets Store の binding は read-only (Worker からの write 不可) の
// ため、この短命ハンドシェイク用の一時ストレージにも Secrets Store は使えない
// (2026-07-08 方針転換、KV から移行 — 詳細は tokens.ts 冒頭コメント参照)。
//
// cookie 値の形式: `base64url(JSON payload).base64url(HMAC-SHA256 signature)`

export interface OAuthState {
  token: string;
  secret: string;
}

// OAuth1.0a handshake (request token 取得 → ブラウザ認可 → callback) が
// この時間内に終わらなければ cookie ごと失効させる
export const REQUEST_TOKEN_TTL_SECONDS = 600;

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(input: string): Uint8Array {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(input.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/** state を署名して cookie 値を組み立てる */
export async function signState(state: OAuthState, secret: string): Promise<string> {
  const payload = base64UrlEncode(new TextEncoder().encode(JSON.stringify(state)));
  const key = await hmacKey(secret);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return `${payload}.${base64UrlEncode(new Uint8Array(signature))}`;
}

/** cookie 値を検証し、正当なら state を返す (改竄・期限切れ・形式不正は null) */
export async function verifyState(cookieValue: string, secret: string): Promise<OAuthState | null> {
  const dot = cookieValue.indexOf(".");
  if (dot === -1) return null;
  const payload = cookieValue.slice(0, dot);
  const signature = cookieValue.slice(dot + 1);

  const key = await hmacKey(secret);
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    base64UrlDecode(signature),
    new TextEncoder().encode(payload),
  );
  if (!valid) return null;

  try {
    const state = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload))) as OAuthState;
    if (typeof state.token !== "string" || typeof state.secret !== "string") return null;
    return state;
  } catch {
    return null;
  }
}
