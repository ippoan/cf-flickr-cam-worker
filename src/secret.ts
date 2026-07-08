// SOURCE-MIRROR: ippoan/auth-worker:src/lib/secret.ts (resolveSecret のみ移植)
//
// CF Secrets Store binding (`secrets_store_secrets`) は production deploy では
// `{ get(): Promise<string> }` (`SecretsStoreSecret`) として注入されるが、vitest /
// `wrangler dev` は同名を plain string で渡す。両形態を共通化して `string | null`
// に正規化することで、呼び出し側は `if (!value) return 503` の 1 分岐で扱える。
//
// 直接 `env.X` を string として使うと (Refs #6 で顕在化) SecretsStoreSecret
// オブジェクトがそのまま Flickr API 等に渡り `[object Object]` 相当の値が送信される。

export type SecretBinding = string | SecretsStoreSecret | undefined;

export async function resolveSecret(binding: SecretBinding): Promise<string | null> {
  if (!binding) return null;
  if (typeof binding === "string") return binding;
  try {
    const value = await binding.get();
    return value || null;
  } catch {
    return null;
  }
}
