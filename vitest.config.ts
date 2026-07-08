import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";

// D1 (cam_files) / R2 (アーカイブ) を実際に叩くテストがあるため、実行環境として
// vitest-pool-workers (Miniflare、実 Workers runtime 相当) を使う
// (security-notification-app と同方針)。SQL 正しさは実 SQLite (D1) で検証する。
//
// migrations の読み込み (fs アクセス) は Node 側 (このファイル) でしかできない
// ため、ここで読んで TEST_MIGRATIONS binding 経由で worker sandbox 側
// (test/apply-migrations.ts) に渡す。
export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations("./migrations");

  return {
    test: {
      pool: "@cloudflare/vitest-pool-workers",
      setupFiles: ["./test/apply-migrations.ts"],
      poolOptions: {
        workers: {
          wrangler: { configPath: "./wrangler.jsonc" },
          miniflare: {
            bindings: {
              TEST_MIGRATIONS: JSON.stringify(migrations),
              FLICKR_CONSUMER_KEY: "test-consumer-key",
              FLICKR_CONSUMER_SECRET: "test-consumer-secret",
              CAM_DIGEST_USER: "test-user",
              CAM_DIGEST_PASS: "test-pass",
              CAM_MACHINE_NAME: "cam1",
              CAM_SDCARD_CGI: "https://cam.internal/sd/",
              CAM_MP4_CGI: "https://cam.internal/mp4/",
              CAM_JPG_CGI: "https://cam.internal/jpg/",
              OAUTH_STATE_SECRET: "test-oauth-state-secret",
            },
          },
        },
      },
      coverage: {
        provider: "istanbul",
        include: ["src/**/*.ts"],
        exclude: ["src/index.ts"],
        reporter: ["text", "json-summary"],
      },
    },
  };
});
