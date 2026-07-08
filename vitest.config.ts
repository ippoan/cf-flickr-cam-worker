import { defineConfig } from "vitest/config";

// KV は KVLike インターフェース越しの DI (test/kv-fake.ts) でテストするため、
// vitest-pool-workers (Miniflare) は使わず素の node 環境で回す
// (cf-flickr-proxy と同方針。Request/Response/Headers は Node 18+ の
// web standard グローバル)。
export default defineConfig({
  test: {
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text", "json-summary"],
    },
  },
});
