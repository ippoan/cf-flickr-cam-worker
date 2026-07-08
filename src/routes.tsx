// OAuth1.0a 認可フロー (JSON API + ブラウザ用ページ) + 状況/画像確認ページ
// (Refs ippoan/cf-flickr-cam-worker#1)。
//
// カメラ scrape は cron (`scheduled.ts`) が定期実行するのに加え、`POST
// /admin/sync` から手動実行もできる (Refs #15 — CF ダッシュボードの Quick Edit
// 「Trigger scheduled event」が Workers VPC Services / Secrets Store binding
// 未対応でグレーアウトするため)。ここは HTTP 経由の人間向け UI と Flickr からの
// OAuth callback を扱う。

import type { Context } from "hono";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

import { getArchive, listArchivedDates } from "./archive";
import { CamClient, parseDirNames } from "./cam";
import type { CamFileRow } from "./d1";
import { dayStats, listByDate, listDates } from "./d1";
import type { Env } from "./env";
import { FlickrClient, FlickrUpstreamError } from "./flickr";
import { REQUEST_TOKEN_TTL_SECONDS, signState, verifyState } from "./oauthState";
import { ImagesPage, OAuthCompletePage, StatusPage } from "./pages";
import { resolveSecret } from "@ippoan/mcp-cf-workers/auth/secret";
import { camConfigFrom, runScheduled } from "./scheduled";
import { getAccessToken } from "./tokens";

const VERSION = "0.1.0";
const OAUTH_STATE_COOKIE = "oauth_state";

async function flickrClientFrom(env: Env, fetchImpl: typeof fetch): Promise<FlickrClient | null> {
  const consumerKey = await resolveSecret(env.FLICKR_CONSUMER_KEY);
  const consumerSecret = await resolveSecret(env.FLICKR_CONSUMER_SECRET);
  if (!consumerKey || !consumerSecret || !env.FLICKR_CALLBACK_URL) return null;
  return new FlickrClient(
    {
      consumerKey,
      consumerSecret,
      callbackUrl: env.FLICKR_CALLBACK_URL,
    },
    fetchImpl,
  );
}

/**
 * Hono app を組み立てる。`fetchImpl` は Flickr 向け外部 HTTP 呼び出しの DI
 * (テストで upstream を差し替えるため、`cf-flickr-proxy` の `handleRequest` と
 * 同じ流儀)。production は `src/index.ts` が既定の `fetch` で呼ぶ。
 */
export function createApp(fetchImpl: typeof fetch = fetch) {
  const app = new Hono<{ Bindings: Env }>();

  app.get("/health", (c) =>
    c.json({ status: "ok", service: "cf-flickr-cam-worker", version: VERSION }),
  );

  // ---- JSON API (プログラム呼び出し用) ----

  app.get("/oauth/url", async (c) => {
    const client = await flickrClientFrom(c.env, fetchImpl);
    if (!client) return c.json({ error: "not configured", message: "FLICKR_* is not set" }, 503);
    const stateSecret = await resolveSecret(c.env.OAUTH_STATE_SECRET);
    if (!stateSecret) {
      return c.json({ error: "not configured", message: "OAUTH_STATE_SECRET is not set" }, 503);
    }

    let requestToken;
    try {
      requestToken = await client.getRequestToken();
    } catch (e) {
      const message = e instanceof FlickrUpstreamError ? e.message : "flickr request failed";
      return c.json({ error: "upstream", message }, 424);
    }
    await setOAuthStateCookie(c, requestToken.token, requestToken.secret, stateSecret);
    return c.json({ authorization_url: requestToken.authorizationUrl });
  });

  app.get("/oauth/status", async (c) => {
    const token = getAccessToken(await resolveSecret(c.env.FLICKR_ACCESS_TOKEN_JSON));
    return c.json({ authorized: token !== null, username: token?.username ?? null });
  });

  // ---- ブラウザ向けページ (OAuth 認可/状況確認・画像確認、Refs #1 2026-07-08) ----

  app.get("/oauth/start", async (c) => {
    const client = await flickrClientFrom(c.env, fetchImpl);
    if (!client) return c.text("Flickr not configured", 503);
    const stateSecret = await resolveSecret(c.env.OAUTH_STATE_SECRET);
    if (!stateSecret) return c.text("OAUTH_STATE_SECRET is not set", 503);

    let requestToken;
    try {
      requestToken = await client.getRequestToken();
    } catch (e) {
      // secretは含まれない (Flickr側のHTTPステータス+レスポンスボディのみ、Refs #6)
      console.error("oauth/start: request_token failed", e instanceof Error ? e.message : String(e));
      return c.text("Flickr request_token failed", 424);
    }
    await setOAuthStateCookie(c, requestToken.token, requestToken.secret, stateSecret);
    return c.redirect(requestToken.authorizationUrl, 302);
  });

  app.get("/oauth/callback", async (c) => {
    const oauthToken = c.req.query("oauth_token");
    const oauthVerifier = c.req.query("oauth_verifier");
    if (!oauthToken || !oauthVerifier) {
      return c.text("oauth_token and oauth_verifier are required", 400);
    }

    const client = await flickrClientFrom(c.env, fetchImpl);
    if (!client) return c.text("Flickr not configured", 503);
    const stateSecret = await resolveSecret(c.env.OAUTH_STATE_SECRET);
    if (!stateSecret) return c.text("OAUTH_STATE_SECRET is not set", 503);

    // cookie は成功・失敗を問わず 1 回きりの使い捨て
    const cookieValue = getCookie(c, OAUTH_STATE_COOKIE);
    deleteCookie(c, OAUTH_STATE_COOKIE, { path: "/" });
    const state = cookieValue ? await verifyState(cookieValue, stateSecret) : null;
    if (!state || state.token !== oauthToken) {
      return c.text("unknown or expired oauth_token — restart from /oauth/start", 400);
    }

    let accessToken;
    try {
      accessToken = await client.getAccessToken(oauthToken, oauthVerifier, state.secret);
    } catch (e) {
      // secretは含まれない (Flickr側のHTTPステータス+レスポンスボディのみ、Refs #6)
      console.error("oauth/callback: access_token exchange failed", e instanceof Error ? e.message : String(e));
      return c.text("Flickr access_token exchange failed", 424);
    }

    // CF Secrets Store は read-only のため Worker はここで永続化できない —
    // 運用者が secret-inject skill で手動投入するための値を 1 回だけ表示する
    // (通常の応答・ログに access token を出さない方針の、意図的な唯一の例外)
    const tokenJson = JSON.stringify({
      token: accessToken.token,
      secret: accessToken.secret,
      userNsid: accessToken.userNsid,
      username: accessToken.username,
    });
    return c.html(
      <OAuthCompletePage username={accessToken.username} userNsid={accessToken.userNsid} tokenJson={tokenJson} />,
    );
  });

  // ---- 運用者向け admin (認証は境界の CF Access に委譲、Refs #15) ----

  app.post("/admin/sync", async (c) => {
    const result = await runScheduled(c.env, Date.now());
    if (!result) return c.json({ error: "not configured", message: "CAM_* is not set" }, 503);
    return c.json(result);
  });

  // 「0 dates」が SD カード側の空応答なのか parseDirNames の不一致なのかを
  // 切り分けるためのデバッグ用エンドポイント (Refs #19)。
  app.get("/admin/debug/cam", async (c) => {
    const camConfig = await camConfigFrom(c.env);
    if (!camConfig) return c.json({ error: "not configured", message: "CAM_* is not set" }, 503);
    const cam = new CamClient(camConfig, c.env.CAM_SERVICE.fetch.bind(c.env.CAM_SERVICE) as typeof fetch);
    const raw = await cam.debugListRoot();
    return c.json({ ...raw, parsedDates: parseDirNames(raw.body) });
  });

  app.get("/", async (c) => {
    const token = getAccessToken(await resolveSecret(c.env.FLICKR_ACCESS_TOKEN_JSON));
    const days = c.env.CAM_DB ? await dayStats(c.env.CAM_DB, 14) : [];
    return c.html(
      <StatusPage authorized={token !== null} username={token?.username ?? null} days={days} />,
    );
  });

  app.get("/images", async (c) => {
    const [liveDates, archivedDates] = await Promise.all([
      c.env.CAM_DB ? listDates(c.env.CAM_DB) : Promise.resolve([]),
      c.env.CAM_ARCHIVE ? listArchivedDates(c.env.CAM_ARCHIVE) : Promise.resolve([]),
    ]);
    // 新しい順。live (D1、当日分) が最新のはずなのでアーカイブより前に置く
    const availableDates = [...new Set([...liveDates.slice().reverse(), ...archivedDates])];

    const requestedDate = c.req.query("date");
    const date = requestedDate ?? availableDates[0] ?? null;

    let files: CamFileRow[] = [];
    if (date) {
      if (liveDates.includes(date)) {
        files = await listByDate(c.env.CAM_DB, date);
      } else if (c.env.CAM_ARCHIVE) {
        const archive = await getArchive(c.env.CAM_ARCHIVE, date);
        files = archive?.files ?? [];
      }
    }

    const token = getAccessToken(await resolveSecret(c.env.FLICKR_ACCESS_TOKEN_JSON));
    return c.html(
      <ImagesPage date={date} availableDates={availableDates} files={files} userNsid={token?.userNsid ?? null} />,
    );
  });

  return app;
}

/** request_token_secret を署名付き HttpOnly cookie に載せる (KV の代替、
 * `oauthState.ts` 冒頭コメント参照)。`/oauth/callback` 側で 1 回きり消費・破棄する。
 * `stateSecret` は呼び出し元で `resolveSecret(c.env.OAUTH_STATE_SECRET)` 済みの値。 */
async function setOAuthStateCookie(
  c: Context<{ Bindings: Env }>,
  token: string,
  secret: string,
  stateSecret: string,
): Promise<void> {
  const value = await signState({ token, secret }, stateSecret);
  setCookie(c, OAUTH_STATE_COOKIE, value, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    maxAge: REQUEST_TOKEN_TTL_SECONDS,
    path: "/",
  });
}

// production 用の既定インスタンス (fetchImpl = global fetch)
export const app = createApp();
