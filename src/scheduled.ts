// cron trigger エントリポイント: カメラ scrape → Flickr upload (sync.ts) →
// 当日以外の日付を R2 へ日次アーカイブ (archive.ts)。
// Refs ippoan/cf-flickr-cam-worker#1, ohishi-exp/ohishi-logi#1

import { archiveDate } from "./archive";
import type { CamConfig } from "./cam";
import { CamClient } from "./cam";
import { lastCamFile, listDates } from "./d1";
import type { Env } from "./env";
import type { FlickrConfig } from "./flickr";
import { FlickrClient } from "./flickr";
import { resolveSecret } from "@ippoan/mcp-cf-workers/auth/secret";
import type { SyncResult } from "./sync";
import { syncCamFiles } from "./sync";
import { getAccessToken } from "./tokens";

// 1 回の cron 実行あたりの upload 上限。Workers の CPU time / subrequest 制限内に
// 収める (rust-flickr の既定値 50 を踏襲)。残りは次回 cron が拾う。
const UPLOAD_LIMIT = 50;

async function camConfigFrom(env: Env): Promise<CamConfig | null> {
  const [digestUser, digestPass, machineName, camHost] = await Promise.all([
    resolveSecret(env.CAM_DIGEST_USER),
    resolveSecret(env.CAM_DIGEST_PASS),
    resolveSecret(env.CAM_MACHINE_NAME),
    resolveSecret(env.CAM_HOST),
  ]);
  if (
    !digestUser ||
    !digestPass ||
    !machineName ||
    !camHost ||
    !env.CAM_SDCARD_CGI_PATH ||
    !env.CAM_MP4_CGI_PATH ||
    !env.CAM_JPG_CGI_PATH
  ) {
    return null;
  }
  return {
    digestUser,
    digestPass,
    machineName,
    // Workers VPC Services は fetch() の URL host/scheme を実際のルーティングには
    // 使わず Host ヘッダにのみ反映する (VPC Service 設定の target host:port が
    // 常に使われる) が、公開ホスト名を渡すと VPC の外にエスケープする既知の罠が
    // あるため internal な camHost (private IP) を使う (Refs #17)。
    sdcardCgi: `http://${camHost}${env.CAM_SDCARD_CGI_PATH}`,
    mp4Cgi: `http://${camHost}${env.CAM_MP4_CGI_PATH}`,
    jpgCgi: `http://${camHost}${env.CAM_JPG_CGI_PATH}`,
    cfAccessClientId: env.CAM_CF_ACCESS_CLIENT_ID,
    cfAccessClientSecret: env.CAM_CF_ACCESS_CLIENT_SECRET,
  };
}

async function flickrConfigFrom(env: Env): Promise<FlickrConfig | null> {
  const [consumerKey, consumerSecret] = await Promise.all([
    resolveSecret(env.FLICKR_CONSUMER_KEY),
    resolveSecret(env.FLICKR_CONSUMER_SECRET),
  ]);
  if (!consumerKey || !consumerSecret || !env.FLICKR_CALLBACK_URL) return null;
  return { consumerKey, consumerSecret, callbackUrl: env.FLICKR_CALLBACK_URL };
}

/** `YYYYMMDD` (UTC)。SD カード側の日付表記と同じ桁数フォーマット。 */
export function todayUtc(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10).replace(/-/g, "");
}

export { camConfigFrom, flickrConfigFrom };

/**
 * `camFetch` は DI (既定は Workers VPC Services binding `env.CAM_SERVICE`)。
 * vitest-pool-workers (Miniflare) は `vpc_services` binding を未対応のため、
 * テストではモック実装を渡す (`cf-flickr-proxy` の `fetchImpl` DI と同じ流儀)。
 *
 * 戻り値は `SyncResult` (cam scrape → upload の結果)。CAM_* 未設定でスキップした
 * 場合は `null` (`POST /admin/sync` が手動実行結果を表示するために使う、Refs #15)。
 */
export async function runScheduled(
  env: Env,
  nowMs: number,
  camFetch: typeof fetch = env.CAM_SERVICE.fetch.bind(env.CAM_SERVICE) as typeof fetch,
): Promise<SyncResult | null> {
  const camConfig = await camConfigFrom(env);
  if (!camConfig) {
    console.warn("CAM_* not fully set — skipping cam scrape");
    return null;
  }
  const cam = new CamClient(camConfig, camFetch);

  const flickrConfig = await flickrConfigFrom(env);
  const flickr = flickrConfig ? new FlickrClient(flickrConfig) : null;
  const accessToken = getAccessToken(await resolveSecret(env.FLICKR_ACCESS_TOKEN_JSON));

  const now = Math.floor(nowMs / 1000);
  const lastPosition = await lastCamFile(env.CAM_DB);
  const result = await syncCamFiles(env.CAM_DB, cam, flickr, accessToken, lastPosition, UPLOAD_LIMIT, now);
  console.log(result.message);

  // 当日 (UTC) 以外の日付は確定済みとみなしアーカイブする。当日分は cron が
  // 次回以降も追記し得るため D1 に残す (= D1 を常に最小に保つ、Refs #1)。
  const today = todayUtc(nowMs);
  const dates = await listDates(env.CAM_DB);
  for (const date of dates) {
    if (date === today) continue;
    const archivedCount = await archiveDate(env.CAM_DB, env.CAM_ARCHIVE, date, now);
    if (archivedCount > 0) console.log(`archived ${archivedCount} files for ${date}`);
  }

  return result;
}
