// Flickr access token (永続) + OAuth handshake 中の request_token_secret (短命)
// を KV に保存する。single-tenant (大石運輸倉庫株式会社の 1 カメラ) 運用のため
// 固定 key を使う — マルチテナント化する場合はここに tenant key を差し込む。
//
// 実 `KVNamespace` は `get`/`put`/`delete` を持つので、テストでは同じ形の
// in-memory fake (test/kv-fake.ts) を注入できる (cf-flickr-proxy の fetchImpl DI
// と同じ流儀)。

export interface KVLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

const ACCESS_TOKEN_KEY = "flickr:access_token";
const REQUEST_TOKEN_PREFIX = "flickr:request_token:";
// OAuth1.0a handshake (request token 取得 → ブラウザ認可 → callback) が
// この時間内に終わらなければ request token は捨てる
const REQUEST_TOKEN_TTL_SECONDS = 600;

export interface StoredAccessToken {
  token: string;
  secret: string;
  userNsid: string;
  username: string;
}

export async function saveRequestTokenSecret(kv: KVLike, oauthToken: string, secret: string): Promise<void> {
  await kv.put(REQUEST_TOKEN_PREFIX + oauthToken, secret, { expirationTtl: REQUEST_TOKEN_TTL_SECONDS });
}

/** 取得と同時に削除する (request token は 1 回きりの使い捨て) */
export async function takeRequestTokenSecret(kv: KVLike, oauthToken: string): Promise<string | null> {
  const key = REQUEST_TOKEN_PREFIX + oauthToken;
  const secret = await kv.get(key);
  if (secret !== null) await kv.delete(key);
  return secret;
}

export async function saveAccessToken(kv: KVLike, token: StoredAccessToken): Promise<void> {
  await kv.put(ACCESS_TOKEN_KEY, JSON.stringify(token));
}

export async function getAccessToken(kv: KVLike): Promise<StoredAccessToken | null> {
  const raw = await kv.get(ACCESS_TOKEN_KEY);
  if (raw === null) return null;
  return JSON.parse(raw) as StoredAccessToken;
}
