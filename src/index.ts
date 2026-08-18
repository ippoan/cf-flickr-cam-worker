// cf-flickr-cam-worker — cron trigger camera scrape + Flickr OAuth1.0a 認可
// フロー + upload + 状況/画像確認ページ (Hono)。Refs ippoan/cf-flickr-cam-worker#1

import { WorkerEntrypoint } from "cloudflare:workers";

import type { Env } from "./env";
import { app } from "./routes";
import { runScheduled } from "./scheduled";
import { collectDailyStats, type DailyStats } from "./stats";

/** 日次メールの既定窓 (旧 rust-flickr `GET /stats?days=20` を踏襲)。 */
const DEFAULT_STATS_DAYS = 20;

/**
 * 日次メール (ippoan/cf-billing-monitor) 専用の binding-only RPC。Refs #38
 *
 * default export (= Hono の fetch) に生やすと auth-worker proxy 越しの公開面が
 * 増えるため、**non-default export の named WorkerEntrypoint** にして service
 * binding からしか呼べないようにする (org 標準: claude-skills
 * `knowledge/standards/ops/cloudflare-binding-only-rpc.md`)。consumer 側は
 * `entrypoint = "ReportEntrypoint"` を指定して binding する。
 */
export class ReportEntrypoint extends WorkerEntrypoint<Env> {
  /** 撮影日別の登録/アップロード件数 (新しい順) と D1 の未アップロード残。 */
  async dailyStats(days: number = DEFAULT_STATS_DAYS): Promise<DailyStats> {
    return collectDailyStats(this.env, days);
  }
}

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await runScheduled(env, Date.now());
  },
} satisfies ExportedHandler<Env>;
