// Flickr access token の読み出し。
//
// 2026-07-08 方針転換: 当初は KV (`FLICKR_TOKENS`) に永続化していたが、
// single-tenant (1 カメラ) 運用で OAuth 認可は実質 1 回きりであること、かつ
// CF Secrets Store の binding は read-only (Worker からの write 不可) である
// ことから、access token 自体は「OAuth 完了後に運用者が secret-inject skill で
// 手動投入する secret (`FLICKR_ACCESS_TOKEN_JSON`)」に置き換えた。
// OAuth ハンドシェイク中の request_token_secret (短命 TTL) は `oauthState.ts`
// の署名付き cookie に置き換え、KV namespace 自体を廃止した。

import type { AccessToken } from "./flickr";

export type StoredAccessToken = AccessToken;

/** `FLICKR_ACCESS_TOKEN_JSON` (secret, `{token,secret,userNsid,username}` の JSON)
 * をパースする。未設定・不正な JSON は null (= 未接続扱い)。 */
export function getAccessToken(json: string | undefined): StoredAccessToken | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as Partial<StoredAccessToken>;
    if (
      typeof parsed.token !== "string" ||
      typeof parsed.secret !== "string" ||
      typeof parsed.userNsid !== "string" ||
      typeof parsed.username !== "string"
    ) {
      return null;
    }
    return parsed as StoredAccessToken;
  } catch {
    return null;
  }
}
