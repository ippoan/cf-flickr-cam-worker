// cf-flickr-cam-worker — cron trigger + Flickr OAuth1.0a 認可フロー + upload。
// Refs ippoan/cf-flickr-cam-worker#1

import type { Env } from "./env";
import { handleRequest } from "./routes";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  },
} satisfies ExportedHandler<Env>;
