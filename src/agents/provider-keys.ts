import { encryptToToken, resolveProviderApiKeyValue } from '../core/crypto.js';

/**
 * Provider-credential helpers shared by every surface that resolves or stores a
 * BYOK provider key (agent registration, elaborate, provider test/models routes).
 */

/** Seal a literal providerApiKey value into an enc:v1 token; pass through tokens, ${ENV} refs, and the `provider-ref` sentinel. */
export const sealProviderApiKey = (value: string): string => {
  const v = value.trim();
  if (!v || v === 'provider-ref' || v.startsWith('enc:v1:') || /^\$\{[A-Z0-9_]+\}$/.test(v)) return v;
  return encryptToToken(v);
};

/** Deep-copy a definition with provider.providerApiKey sealed to an enc:v1 token when it is a literal secret. */
export const sealDefinitionSecrets = <T>(def: T): T => {
  const copy = JSON.parse(JSON.stringify(def)) as { provider?: { providerApiKey?: string } };
  if (copy.provider?.providerApiKey) copy.provider.providerApiKey = sealProviderApiKey(copy.provider.providerApiKey);
  return copy as T;
};

/** Resolve a provider API key: providerApiKey (token/${ENV}/literal) → legacy credentialEnv → raw apiKey. */
export const resolveProviderKey = (p: { providerApiKey?: string; apiKey?: string; credentialEnv?: string }): { key?: string; source?: string; error?: string } => {
  const attr = p.providerApiKey?.trim();
  if (attr) {
    try {
      return { key: resolveProviderApiKeyValue(attr), source: attr.startsWith('enc:v1:') ? 'token' : attr.startsWith('${') ? 'env-ref' : 'literal' };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }
  const raw = p.apiKey?.trim();
  if (raw) return { key: raw, source: 'request' };
  if (p.credentialEnv) {
    const key = process.env[p.credentialEnv];
    if (key) return { key, source: 'env' };
    return { error: `Environment variable "${p.credentialEnv}" is not set on the server.` };
  }
  return { error: 'No API key provided — set the providerApiKey field.' };
};

export const providerAuthHeaders = (type: string | undefined, key: string | undefined): Record<string, string> => {
  const headers: Record<string, string> = { 'Accept': 'application/json' };
  if (!key) return headers;
  if (type === 'anthropic') {
    headers['x-api-key'] = key;
    headers['anthropic-version'] = '2023-06-01';
  } else {
    headers['Authorization'] = `Bearer ${key}`;
  }
  return headers;
};
