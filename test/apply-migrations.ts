import { applyD1Migrations, env } from "cloudflare:test";

// vitest-pool-workers の各 isolated runtime で cam_files テーブルを用意する
// (migrations/0001_cam_files.sql を D1 に適用)。migrations 本体は Node 側
// (vitest.config.ts) が fs から読み、TEST_MIGRATIONS binding 経由でここに渡す
// (この worker sandbox からは fs にアクセスできないため)。型は test/env.d.ts 参照。
const migrations = JSON.parse(env.TEST_MIGRATIONS);
await applyD1Migrations(env.CAM_DB, migrations);
