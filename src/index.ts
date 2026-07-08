// cf-flickr-cam-worker — cron trigger camera scrape + Flickr OAuth1.0a 認可
// フロー + upload + 状況/画像確認ページ (Hono)。Refs ippoan/cf-flickr-cam-worker#1

import type { Env } from "./env";
import { app } from "./routes";
import { runScheduled } from "./scheduled";

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await runScheduled(env, Date.now());
  },
} satisfies ExportedHandler<Env>;
