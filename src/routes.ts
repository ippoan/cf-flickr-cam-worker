// Cron trigger + OAuth1.0a 認可フロー (Refs ippoan/cf-flickr-cam-worker#1)。
//
// カメラ日付/時間/ファイル一覧・ファイル本体 download を ohishi-logi (Cloud Run)
// から取得する RPC 呼び出しは、認証方式が未確定のため follow-up
// (Refs ohishi-exp/ohishi-logi#1)。本 route は Flickr 側の OAuth1.0a 認可フロー
// のみを持つ。

import type { Env } from "./env";
import { FlickrClient, FlickrUpstreamError } from "./flickr";
import { getAccessToken, saveAccessToken, saveRequestTokenSecret, takeRequestTokenSecret } from "./tokens";

const VERSION = "0.1.0";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function flickrClientFrom(env: Env, fetchImpl: typeof fetch): FlickrClient | null {
  if (!env.FLICKR_CONSUMER_KEY || !env.FLICKR_CONSUMER_SECRET || !env.FLICKR_CALLBACK_URL) return null;
  return new FlickrClient(
    {
      consumerKey: env.FLICKR_CONSUMER_KEY,
      consumerSecret: env.FLICKR_CONSUMER_SECRET,
      callbackUrl: env.FLICKR_CALLBACK_URL,
    },
    fetchImpl,
  );
}

async function handleOauthUrl(env: Env, fetchImpl: typeof fetch): Promise<Response> {
  const client = flickrClientFrom(env, fetchImpl);
  if (!client) return json(503, { error: "not configured", message: "FLICKR_* is not set" });

  let requestToken;
  try {
    requestToken = await client.getRequestToken();
  } catch (e) {
    const message = e instanceof FlickrUpstreamError ? e.message : "flickr request failed";
    return json(424, { error: "upstream", message });
  }

  await saveRequestTokenSecret(env.FLICKR_TOKENS, requestToken.token, requestToken.secret);
  return json(200, { authorization_url: requestToken.authorizationUrl });
}

async function handleOauthCallback(request: Request, env: Env, fetchImpl: typeof fetch): Promise<Response> {
  const url = new URL(request.url);
  const oauthToken = url.searchParams.get("oauth_token");
  const oauthVerifier = url.searchParams.get("oauth_verifier");
  if (!oauthToken || !oauthVerifier) {
    return json(400, { error: "bad_request", message: "oauth_token and oauth_verifier are required" });
  }

  const client = flickrClientFrom(env, fetchImpl);
  if (!client) return json(503, { error: "not configured", message: "FLICKR_* is not set" });

  const requestTokenSecret = await takeRequestTokenSecret(env.FLICKR_TOKENS, oauthToken);
  if (!requestTokenSecret) {
    return json(400, {
      error: "bad_request",
      message: "unknown or expired oauth_token — restart the /oauth/url flow",
    });
  }

  let accessToken;
  try {
    accessToken = await client.getAccessToken(oauthToken, oauthVerifier, requestTokenSecret);
  } catch (e) {
    const message = e instanceof FlickrUpstreamError ? e.message : "flickr request failed";
    return json(424, { error: "upstream", message });
  }

  await saveAccessToken(env.FLICKR_TOKENS, {
    token: accessToken.token,
    secret: accessToken.secret,
    userNsid: accessToken.userNsid,
    username: accessToken.username,
  });

  // access token 本体はレスポンスに echo しない (会話・ログに値を残さない方針)
  return json(200, { user_nsid: accessToken.userNsid, username: accessToken.username, saved: true });
}

async function handleOauthStatus(env: Env): Promise<Response> {
  const token = await getAccessToken(env.FLICKR_TOKENS);
  return json(200, { authorized: token !== null, username: token?.username ?? null });
}

export async function handleRequest(
  request: Request,
  env: Env,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === "/health" && request.method === "GET") {
    return json(200, { status: "ok", service: "cf-flickr-cam-worker", version: VERSION });
  }
  if (url.pathname === "/oauth/url" && request.method === "GET") {
    return handleOauthUrl(env, fetchImpl);
  }
  if (url.pathname === "/oauth/callback" && request.method === "GET") {
    return handleOauthCallback(request, env, fetchImpl);
  }
  if (url.pathname === "/oauth/status" && request.method === "GET") {
    return handleOauthStatus(env);
  }

  return json(404, { error: "not_found" });
}
