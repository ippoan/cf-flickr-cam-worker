import type { KVLike } from "../src/tokens";

/** in-memory KVLike fake。expirationTtl は検証のみ (実際の失効はさせない —
 * テストでは KV の TTL 挙動そのものではなく呼び出し側のロジックを検証する)。 */
export function createFakeKV(): KVLike & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    async get(key) {
      return store.has(key) ? store.get(key)! : null;
    },
    async put(key, value) {
      store.set(key, value);
    },
    async delete(key) {
      store.delete(key);
    },
  };
}
