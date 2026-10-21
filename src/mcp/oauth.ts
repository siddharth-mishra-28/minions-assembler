/**
 * OAuth discovery + browser-flow helpers for MCP servers over streamable HTTP.
 *
 * Implements the pieces an MCP client needs for 401-driven authorization
 * (MCP authorization spec + RFC 9728 + RFC 8414 + RFC 7636):
 *  - Protected Resource Metadata discovery (WWW-Authenticate resource_metadata,
 *    path-specific `/.well-known/oauth-protected-resource/<path>`, then root).
 *  - Authorization Server Metadata discovery (RFC 8414, with path-insertion
 *    rule: `/.well-known/oauth-authorization-server/<path-after-issuer>`).
 *  - Authorization Code + PKCE (S256) authorize URL + token exchange, with the
 *    MCP-specific `resource` parameter on both requests.
 * Tokens are handled by the caller (stored AES-256-GCM encrypted in the DB).
 */
import { createHash, randomBytes } from 'node:crypto';

const FETCH_TIMEOUT_MS = 15000;

async function getJson(url: string, stage: string): Promise<Record<string, unknown>> {
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: ac.signal });
    if (!res.ok) throw new Error(`${stage}: HTTP ${res.status} from ${url}`);
    const text = await res.text();
    try {
      const j = JSON.parse(text);
      if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('not an object');
      return j as Record<string, unknown>;
    } catch {
      throw new Error(`${stage}: response from ${url} is not a JSON object`);
    }
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new Error(`${stage}: timed out after ${FETCH_TIMEOUT_MS}ms fetching ${url}`);
    throw e;
  } finally { clearTimeout(to); }
}

export interface ProtectedResourceMetadata {
  resource?: string;
  authorization_servers?: string[];
  scopes_supported?: string[];
  resource_name?: string;
  [k: string]: unknown;
}

/** Fetch an RFC 9728 Protected Resource Metadata document. */
export function fetchProtectedResourceMetadata(url: string): Promise<ProtectedResourceMetadata> {
  return getJson(url, 'protected resource metadata') as Promise<ProtectedResourceMetadata>;
}

/**
 * Discover protected-resource metadata for an MCP server URL, in spec order:
 * 1. `resource_metadata` URL from the WWW-Authenticate challenge (caller passes it when present).
 * 2. Path-specific: `<scheme>://<host>/.well-known/oauth-protected-resource/<endpoint-path>`.
 * 3. Root: `<scheme>://<host>/.well-known/oauth-protected-resource`.
 * Returns null when no well-known location answers (server likely not an OAuth resource).
 */
export async function discoverProtectedResourceMetadata(
  serverUrl: string,
  challengeUrl?: string | null,
): Promise<ProtectedResourceMetadata | null> {
  const u = new URL(serverUrl);
  const pathSpecific = `${u.origin}/.well-known/oauth-protected-resource${u.pathname === '/' ? '/mcp' : u.pathname.replace(/\/+$/, '')}`;
  const root = `${u.origin}/.well-known/oauth-protected-resource`;
  for (const candidate of challengeUrl ? [challengeUrl, pathSpecific, root] : [pathSpecific, root]) {
    try { return await fetchProtectedResourceMetadata(candidate); } catch { /* try next */ }
  }
  return null;
}

export interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  scopes_supported?: string[];
  code_challenge_methods_supported?: string[];
  registration_endpoint?: string;
  [k: string]: unknown;
}

/**
 * RFC 8414 discovery for an authorization server issuer, with the path-insertion
 * rule: issuer `https://host/p` → `https://host/.well-known/oauth-authorization-server/p`.
 * The MCP spec additionally allows OIDC fallbacks for well-known issuers (e.g. GitHub).
 */
export async function fetchAuthorizationServerMetadata(issuer: string): Promise<AuthorizationServerMetadata> {
  const u = new URL(issuer);
  const basePath = `${u.origin}/.well-known/oauth-authorization-server`;
  const urls = u.pathname && u.pathname !== '/' ? [`${basePath}${u.pathname.replace(/\/+$/, '')}`, basePath] : [basePath];
  let lastErr: Error | null = null;
  for (const url of urls) {
    try {
      const md = (await getJson(url, 'authorization server metadata')) as unknown as AuthorizationServerMetadata;
      if (!md.authorization_endpoint || !md.token_endpoint) throw new Error('metadata missing authorization_endpoint/token_endpoint');
      if (md.issuer && md.issuer !== issuer) throw new Error(`metadata issuer mismatch (${md.issuer} ≠ ${issuer})`);
      return md;
    } catch (e) { lastErr = e as Error; }
  }
  throw new Error(`Cannot discover authorization server metadata for ${issuer} — ${lastErr?.message ?? 'no metadata document found'}`);
}

/** PKCE pair: `code_verifier` + its S256 `code_challenge`. */
export function makePkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export interface AuthorizeUrlInput {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  resource: string;
  scopes?: string[];
  state: string;
  codeChallenge: string;
}

/** Build the authorization redirect URL (Authorization Code + PKCE S256 + RFC 8707 `resource`). */
export function buildAuthorizeUrl(input: AuthorizeUrlInput): string {
  const u = new URL(input.authorizationEndpoint);
  const q = u.searchParams;
  q.set('response_type', 'code');
  q.set('client_id', input.clientId);
  q.set('redirect_uri', input.redirectUri);
  q.set('code_challenge', input.codeChallenge);
  q.set('code_challenge_method', 'S256');
  q.set('state', input.state);
  q.set('resource', input.resource);
  if (input.scopes?.length) q.set('scope', [...new Set(input.scopes)].join(' '));
  return u.toString();
}

export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}

/** Error thrown by the token endpoint with the OAuth error payload preserved. */
export class OAuthTokenError extends Error {
  /** OAuth error code from the response body (`invalid_grant`, …) when present. */
  oauthError: string | null;
  oauthErrorDescription: string | null;
  constructor(message: string, oauthError: string | null = null, oauthErrorDescription: string | null = null) {
    super(message);
    this.name = 'OAuthTokenError';
    this.oauthError = oauthError;
    this.oauthErrorDescription = oauthErrorDescription;
  }
}

export interface TokenExchangeInput {
  tokenEndpoint: string;
  grantType: string; // 'authorization_code' | 'refresh_token'
  clientId: string;
  redirectUri: string;
  resource?: string;
  scopes?: string[];
  code?: string;
  codeVerifier?: string;
  refreshToken?: string;
  clientSecret?: string;
}

/** Token endpoint request: authorization_code or refresh_token grant, `resource` included per the MCP spec. */
export async function requestToken(input: TokenExchangeInput): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: input.grantType,
    client_id: input.clientId,
    ...(input.clientSecret ? { client_secret: input.clientSecret } : {}),
    ...(input.redirectUri ? { redirect_uri: input.redirectUri } : {}),
    ...(input.resource ? { resource: input.resource } : {}),
    ...(input.scopes?.length ? { scope: [...new Set(input.scopes)].join(' ') } : {}),
    ...(input.grantType === 'authorization_code' ? { code: input.code ?? '', code_verifier: input.codeVerifier ?? '' } : {}),
    ...(input.grantType === 'refresh_token' ? { refresh_token: input.refreshToken ?? '' } : {}),
  });
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(input.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: body.toString(),
      signal: ac.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      let oauthError: string | null = null, desc: string | null = null;
      try {
        const j = JSON.parse(text) as { error?: string; error_description?: string };
        oauthError = j.error ?? null; desc = j.error_description ?? null;
      } catch { /* plaintext error body */ }
      throw new OAuthTokenError(
        `token endpoint returned HTTP ${res.status}${desc ? `: ${desc}` : oauthError ? `: ${oauthError}` : ''}`,
        oauthError, desc,
      );
    }
    let j: Record<string, unknown>;
    try { j = JSON.parse(text) as Record<string, unknown>; } catch {
      // GitHub returns urlencoded on token endpoint when no Accept header — we always send Accept, but tolerate.
      const p = new URLSearchParams(text);
      j = Object.fromEntries(p.entries());
    }
    const at = (j.access_token ?? null) as string | null;
    if (!at) throw new OAuthTokenError('token response missing access_token', (j.error as string) ?? null, (j.error_description as string) ?? null);
    return {
      access_token: at,
      token_type: (j.token_type as string) ?? 'Bearer',
      ...(j.expires_in !== undefined ? { expires_in: Number(j.expires_in) } : {}),
      ...(j.refresh_token ? { refresh_token: j.refresh_token as string } : {}),
      ...(j.scope ? { scope: j.scope as string } : {}),
    };
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new OAuthTokenError(`token endpoint timed out after ${FETCH_TIMEOUT_MS}ms`);
    throw e;
  } finally { clearTimeout(to); }
}
