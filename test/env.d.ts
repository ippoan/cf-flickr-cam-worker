/// <reference types="@cloudflare/vitest-pool-workers/types" />
import type { Env as WorkerEnv } from "../src/env";

declare module "cloudflare:test" {
  interface ProvidedEnv extends WorkerEnv {
    TEST_MIGRATIONS: string;
  }
}
