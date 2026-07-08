// SOURCE-MIRROR: ippoan/rust-flickr:src/flickr.rs (2026-07-08 TypeScript 移植、
// DB 連携部分は除く)
//
// Flickr API クライアント。access token の永続化は `tokens.ts` (KV) が担当し、
// このモジュールは取得/使用のみを担う。`fetchImpl` を DI することで
// テスト時に upstream を差し替えられる (`cf-flickr-proxy` の `handleRequest`
// と同じ流儀)。

import { authHeader, nonce, oauthSignedParams, parseForm, sign, timestamp } from "./oauth1";

const REQUEST_TOKEN_URL = "https://www.flickr.com/services/oauth/request_token";
const ACCESS_TOKEN_URL = "https://www.flickr.com/services/oauth/access_token";
const AUTHORIZE_URL = "https://www.flickr.com/services/oauth/authorize";
const REST_URL = "https://www.flickr.com/services/rest/";
const UPLOAD_URL = "https://up.flickr.com/services/upload/";

export interface FlickrConfig {
  consumerKey: string;
  consumerSecret: string;
  callbackUrl: string;
}

export interface RequestToken {
  token: string;
  secret: string;
  authorizationUrl: string;
}

export interface AccessToken {
  token: string;
  secret: string;
  userNsid: string;
  username: string;
}

export interface PhotoInfo {
  id: string;
  server: string;
  secret: string;
}

export class FlickrUpstreamError extends Error {}

interface Endpoints {
  requestTokenUrl: string;
  accessTokenUrl: string;
  authorizeUrl: string;
  restUrl: string;
  uploadUrl: string;
}

export class FlickrClient {
  private readonly config: FlickrConfig;
  private readonly endpoints: Endpoints;
  private readonly fetchImpl: typeof fetch;

  constructor(config: FlickrConfig, fetchImpl: typeof fetch = fetch, endpoints?: Partial<Endpoints>) {
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.endpoints = {
      requestTokenUrl: endpoints?.requestTokenUrl ?? REQUEST_TOKEN_URL,
      accessTokenUrl: endpoints?.accessTokenUrl ?? ACCESS_TOKEN_URL,
      authorizeUrl: endpoints?.authorizeUrl ?? AUTHORIZE_URL,
      restUrl: endpoints?.restUrl ?? REST_URL,
      uploadUrl: endpoints?.uploadUrl ?? UPLOAD_URL,
    };
  }

  private oauthBaseParams(): Record<string, string> {
    return {
      oauth_consumer_key: this.config.consumerKey,
      oauth_nonce: nonce(),
      oauth_signature_method: "HMAC-SHA1",
      oauth_timestamp: timestamp(),
      oauth_version: "1.0",
    };
  }

  private async signedGetForm(
    url: string,
    params: Record<string, string>,
    tokenSecret: string | undefined,
    what: string,
  ): Promise<Record<string, string>> {
    const signature = await sign("GET", url, params, this.config.consumerSecret, tokenSecret);
    const signed = { ...params, oauth_signature: signature };
    const response = await this.fetchImpl(url, {
      headers: { Authorization: `OAuth ${authHeader(signed)}` },
    });
    const body = await response.text();
    if (!response.ok) {
      throw new FlickrUpstreamError(`flickr ${what} failed: ${response.status} - ${body}`);
    }
    return parseForm(body);
  }

  /** request token を取得して認可 URL を組み立てる */
  async getRequestToken(): Promise<RequestToken> {
    const params = { ...this.oauthBaseParams(), oauth_callback: this.config.callbackUrl };
    const form = await this.signedGetForm(this.endpoints.requestTokenUrl, params, undefined, "request_token");
    const token = form.oauth_token;
    const secret = form.oauth_token_secret;
    if (!token) throw new FlickrUpstreamError("oauth_token not found in request_token response");
    if (!secret) throw new FlickrUpstreamError("oauth_token_secret not found in request_token response");
    return {
      token,
      secret,
      authorizationUrl: `${this.endpoints.authorizeUrl}?oauth_token=${token}&perms=write`,
    };
  }

  /** verifier を access token に交換する */
  async getAccessToken(
    oauthToken: string,
    oauthVerifier: string,
    requestTokenSecret: string,
  ): Promise<AccessToken> {
    const params = {
      ...this.oauthBaseParams(),
      oauth_token: oauthToken,
      oauth_verifier: oauthVerifier,
    };
    const form = await this.signedGetForm(
      this.endpoints.accessTokenUrl,
      params,
      requestTokenSecret,
      "access_token",
    );
    const token = form.oauth_token;
    const secret = form.oauth_token_secret;
    if (!token) throw new FlickrUpstreamError("oauth_token not found in access_token response");
    if (!secret) throw new FlickrUpstreamError("oauth_token_secret not found in access_token response");
    return {
      token,
      secret,
      userNsid: form.user_nsid ?? "",
      username: form.username ?? "",
    };
  }

  /** flickr.photos.getInfo を OAuth 署名付きで呼ぶ */
  async photosGetInfo(photoId: string, accessToken: string, accessTokenSecret: string): Promise<PhotoInfo> {
    const params = {
      ...this.oauthBaseParams(),
      oauth_token: accessToken,
      method: "flickr.photos.getInfo",
      photo_id: photoId,
      format: "json",
      nojsoncallback: "1",
    };
    const { authParams, queryParams } = oauthSignedParams(params);
    const signature = await sign(
      "GET",
      this.endpoints.restUrl,
      params,
      this.config.consumerSecret,
      accessTokenSecret,
    );
    authParams.oauth_signature = signature;

    const url = new URL(this.endpoints.restUrl);
    for (const [k, v] of Object.entries(queryParams)) url.searchParams.set(k, v);

    const response = await this.fetchImpl(url.toString(), {
      headers: { Authorization: `OAuth ${authHeader(authParams)}` },
    });
    if (!response.ok) {
      const body = await response.text();
      throw new FlickrUpstreamError(`Flickr API error for photo ${photoId}: ${response.status} - ${body}`);
    }
    const apiResponse = (await response.json()) as { photo?: PhotoInfo; stat: string };
    if (apiResponse.stat !== "ok") {
      throw new FlickrUpstreamError(`Flickr API returned stat=${apiResponse.stat} for photo ${photoId}`);
    }
    if (!apiResponse.photo) {
      throw new FlickrUpstreamError(`No photo data in Flickr response for photo ${photoId}`);
    }
    return apiResponse.photo;
  }

  /**
   * 写真を Flickr Upload API にアップロードして photo id を返す。OAuth1 署名は
   * oauth/API パラメータのみが対象で photo バイナリは含めない (Flickr Upload API
   * 仕様)。`tags=upBySytem` は rust-flickr 互換 (タイポも互換維持)。
   */
  async uploadPhoto(
    accessToken: string,
    accessTokenSecret: string,
    title: string,
    data: Uint8Array,
  ): Promise<string> {
    const params = {
      ...this.oauthBaseParams(),
      oauth_token: accessToken,
      title,
      tags: "upBySytem",
    };
    const signature = await sign(
      "POST",
      this.endpoints.uploadUrl,
      params,
      this.config.consumerSecret,
      accessTokenSecret,
    );
    const signed = { ...params, oauth_signature: signature };

    const form = new FormData();
    for (const [k, v] of Object.entries(signed)) form.append(k, v);
    form.append("photo", new Blob([data], { type: "application/octet-stream" }), title);

    const response = await this.fetchImpl(this.endpoints.uploadUrl, { method: "POST", body: form });
    const body = await response.text();
    if (!response.ok) {
      throw new FlickrUpstreamError(`flickr upload failed for ${title}: ${response.status}`);
    }
    const photoId = parseUploadPhotoId(body);
    if (!photoId) {
      throw new FlickrUpstreamError(`flickr upload: photoid not found in response for ${title}`);
    }
    return photoId;
  }
}

/** Flickr Upload API レスポンス XML から `<photoid>…</photoid>` を抽出。
 * この XML 形状は固定 (Flickr Upload API の応答のみ) なので、フル XML パーサー
 * ではなく正規表現で十分 — 依存を増やさない (mcp-cf-workers の「薄く保つ」方針と
 * 同趣旨)。 */
function parseUploadPhotoId(xml: string): string | null {
  const match = xml.match(/<photoid>([^<]*)<\/photoid>/);
  return match ? match[1] : null;
}
