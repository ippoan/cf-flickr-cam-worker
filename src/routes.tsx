// OAuth1.0a 認可フロー (JSON API + ブラウザ用ページ) + 状況/画像確認ページ
// (Refs ippoan/cf-flickr-cam-worker#1)。
//
// カメラ scrape (cron) は `scheduled.ts` が持つ。ここは HTTP 経由の人間向け UI と
// Flickr からの OAuth callback のみを扱う。

import { Hono } from "hono";

import { getArchive, listArchivedDates } from "./archive";
import type { CamFileRow } from "./d1";
import { dayStats, listByDate, listDates } from "./d1";
import type { Env } from "./env";
import { FlickrClient, FlickrUpstreamError } from "./flickr";
import { ImagesPage, StatusPage } from "./pages";
import { getAccessToken, saveAccessToken, saveRequestTokenSecret, takeRequestTokenSecret } from "./tokens";

const VERSION = "0.1.0";

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
    const client = flickrClientFrom(c.env, fetchImpl);
    if (!client) return c.json({ error: "not configured", message: "FLICKR_* is not set" }, 503);

    let requestToken;
    try {
      requestToken = await client.getRequestToken();
    } catch (e) {
      const message = e instanceof FlickrUpstreamError ? e.message : "flickr request failed";
      return c.json({ error: "upstream", message }, 424);
    }
    await saveRequestTokenSecret(c.env.FLICKR_TOKENS, requestToken.token, requestToken.secret);
    return c.json({ authorization_url: requestToken.authorizationUrl });
  });

  app.get("/oauth/status", async (c) => {
    const token = await getAccessToken(c.env.FLICKR_TOKENS);
    return c.json({ authorized: token !== null, username: token?.username ?? null });
  });

  // ---- ブラウザ向けページ (OAuth 認可/状況確認・画像確認、Refs #1 2026-07-08) ----

  app.get("/oauth/start", async (c) => {
    const client = flickrClientFrom(c.env, fetchImpl);
    if (!client) return c.text("Flickr not configured", 503);

    let requestToken;
    try {
      requestToken = await client.getRequestToken();
    } catch {
      return c.text("Flickr request_token failed", 424);
    }
    await saveRequestTokenSecret(c.env.FLICKR_TOKENS, requestToken.token, requestToken.secret);
    return c.redirect(requestToken.authorizationUrl, 302);
  });

  app.get("/oauth/callback", async (c) => {
    const oauthToken = c.req.query("oauth_token");
    const oauthVerifier = c.req.query("oauth_verifier");
    if (!oauthToken || !oauthVerifier) {
      return c.text("oauth_token and oauth_verifier are required", 400);
    }

    const client = flickrClientFrom(c.env, fetchImpl);
    if (!client) return c.text("Flickr not configured", 503);

    const requestTokenSecret = await takeRequestTokenSecret(c.env.FLICKR_TOKENS, oauthToken);
    if (!requestTokenSecret) {
      return c.text("unknown or expired oauth_token — restart from /oauth/start", 400);
    }

    let accessToken;
    try {
      accessToken = await client.getAccessToken(oauthToken, oauthVerifier, requestTokenSecret);
    } catch {
      return c.text("Flickr access_token exchange failed", 424);
    }

    await saveAccessToken(c.env.FLICKR_TOKENS, {
      token: accessToken.token,
      secret: accessToken.secret,
      userNsid: accessToken.userNsid,
      username: accessToken.username,
    });

    // access token 本体は redirect 先に乗せない (会話・ログ・URL に値を残さない方針)
    return c.redirect("/", 302);
  });

  app.get("/", async (c) => {
    const token = await getAccessToken(c.env.FLICKR_TOKENS);
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

    const token = await getAccessToken(c.env.FLICKR_TOKENS);
    return c.html(
      <ImagesPage date={date} availableDates={availableDates} files={files} userNsid={token?.userNsid ?? null} />,
    );
  });

  return app;
}

// production 用の既定インスタンス (fetchImpl = global fetch)
export const app = createApp();
