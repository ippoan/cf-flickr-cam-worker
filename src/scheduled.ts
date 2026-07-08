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
import { syncCamFiles } from "./sync";
import { getAccessToken } from "./tokens";

// 1 回の cron 実行あたりの upload 上限。Workers の CPU time / subrequest 制限内に
// 収める (rust-flickr の既定値 50 を踏襲)。残りは次回 cron が拾う。
const UPLOAD_LIMIT = 50;

function camConfigFrom(env: Env): CamConfig | null {
  if (
    !env.CAM_DIGEST_USER ||
    !env.CAM_DIGEST_PASS ||
    !env.CAM_MACHINE_NAME ||
    !env.CAM_SDCARD_CGI ||
    !env.CAM_MP4_CGI ||
    !env.CAM_JPG_CGI
  ) {
    return null;
  }
  return {
    digestUser: env.CAM_DIGEST_USER,
    digestPass: env.CAM_DIGEST_PASS,
    machineName: env.CAM_MACHINE_NAME,
    sdcardCgi: env.CAM_SDCARD_CGI,
    mp4Cgi: env.CAM_MP4_CGI,
    jpgCgi: env.CAM_JPG_CGI,
    cfAccessClientId: env.CAM_CF_ACCESS_CLIENT_ID,
    cfAccessClientSecret: env.CAM_CF_ACCESS_CLIENT_SECRET,
  };
}

function flickrConfigFrom(env: Env): FlickrConfig | null {
  if (!env.FLICKR_CONSUMER_KEY || !env.FLICKR_CONSUMER_SECRET || !env.FLICKR_CALLBACK_URL) return null;
  return {
    consumerKey: env.FLICKR_CONSUMER_KEY,
    consumerSecret: env.FLICKR_CONSUMER_SECRET,
    callbackUrl: env.FLICKR_CALLBACK_URL,
  };
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
 */
export async function runScheduled(
  env: Env,
  nowMs: number,
  camFetch: typeof fetch = env.CAM_SERVICE.fetch.bind(env.CAM_SERVICE) as typeof fetch,
): Promise<void> {
  const camConfig = camConfigFrom(env);
  if (!camConfig) {
    console.warn("CAM_* not fully set — skipping cam scrape");
    return;
  }
  const cam = new CamClient(camConfig, camFetch);

  const flickrConfig = flickrConfigFrom(env);
  const flickr = flickrConfig ? new FlickrClient(flickrConfig) : null;
  const accessToken = getAccessToken(env.FLICKR_ACCESS_TOKEN_JSON);

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
}
