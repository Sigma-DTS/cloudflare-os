import { beginCentralOAuth, redeemCentralOAuth, refreshCentralOAuth, revokeCentralOAuth } from "@gadgets/gatekeeper-kit/central-oauth";
import type { AccessTokenResult, GoogleOAuthGrant } from "./google-api";
import type { AccessTokenProvider } from "./auth-retry";

/** Installer-owned identity; the delegated Worker never receives Google's client secret. */
export type BrokerEnv = {
  BROKER_URL?: string;
  CENTRAL_GATEKEEPER_URL?: string;
  CFOS_INSTALL_ID?: string;
  CFOS_INSTALL_KEY_ID?: string;
  CFOS_INSTALL_PRIVATE_KEY?: string;
};

const FORWARDED_HEADERS = [
  "x-google-url", "x-google-method", "x-gatekeeper-grant", "accept", "content-type",
  "if-match", "if-none-match", "x-goog-client-request-id",
] as const;
const MAX_BODY_BYTES = 25 * 1024 * 1024;
const HEX64 = /^[0-9a-f]{64}$/;

function endpoint(env: BrokerEnv, path: string): URL {
  if (!env.BROKER_URL || !env.CFOS_INSTALL_ID || !env.CFOS_INSTALL_KEY_ID ||
      !env.CFOS_INSTALL_PRIVATE_KEY) {
    throw new Error("Central Google delegation is not configured for this installation.");
  }
  const url = new URL(env.BROKER_URL);
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash ||
      url.username || url.password) throw new Error("BROKER_URL must be an HTTPS origin.");
  url.pathname = path;
  return url;
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/** Sign the exact request, including the target URL, sealed grant, method, and request body. */
async function signed(env: BrokerEnv, path: string, body: Uint8Array,
                      forwarded?: Headers): Promise<Request> {
  const url = endpoint(env, path);
  if (body.byteLength > MAX_BODY_BYTES) throw new Error("Google request exceeds broker limit.");
  const headers = new Headers(forwarded);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomUUID();
  const digest = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", body)));
  headers.set("x-cfos-install-id", env.CFOS_INSTALL_ID!);
  headers.set("x-cfos-key-id", env.CFOS_INSTALL_KEY_ID!);
  headers.set("x-cfos-timestamp", timestamp);
  headers.set("x-cfos-nonce", nonce);
  headers.set("x-cfos-content-digest", digest);
  const canonical = ["CFOS-GOOGLE-1", "POST", url.pathname,
    env.CFOS_INSTALL_ID!, env.CFOS_INSTALL_KEY_ID!, timestamp, nonce, digest,
    ...FORWARDED_HEADERS.map(name => headers.get(name) ?? ""),
  ].join("\n");
  const pkcs8 = Uint8Array.from(atob(env.CFOS_INSTALL_PRIVATE_KEY!),
    char => char.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", pkcs8,
    { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  headers.set("x-cfos-signature", base64url(new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(canonical)))));
  return new Request(url, { method: "POST", headers, body });
}

async function call(env: BrokerEnv, path: string, payload: object,
                    signal?: AbortSignal): Promise<unknown> {
  const request = await signed(env, path, new TextEncoder().encode(JSON.stringify(payload)),
    new Headers({ "content-type": "application/json" }));
  const response = await fetch(request, {
    redirect: "manual", signal: signal ?? AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    response.body?.cancel();
    throw new Error(`Central Google broker rejected ${path} (${response.status}).`);
  }
  return response.json();
}

/** Begin one install-bound OAuth flow through the single central Google callback. */
export async function beginBrokerOAuth(env: BrokerEnv, callbackPath: string,
                                       accountId: string, nonce: string,
                                       scopes: string[]): Promise<string> {
  if (env.CENTRAL_GATEKEEPER_URL) return beginCentralOAuth(env, "google", { callbackPath, accountId, nonce, scopes },
    "https://accounts.google.com/o/oauth2/v2/auth");
  const result = await call(env, "/begin", { callbackPath, accountId, nonce, scopes });
  if (!result || typeof result !== "object" ||
      !("authorizationUrl" in result) || typeof result.authorizationUrl !== "string") {
    throw new Error("Central Google broker returned an invalid authorization URL.");
  }
  const authorization = new URL(result.authorizationUrl);
  if (authorization.origin !== "https://accounts.google.com" ||
      authorization.pathname !== "/o/oauth2/v2/auth") {
    throw new Error("Central Google broker returned an unexpected authorization URL.");
  }
  return authorization.href;
}

/** Redeem a single-use ticket for ciphertext bound to this installation. */
export async function redeemBrokerGrant(env: BrokerEnv, ticket: string): Promise<{
  accountId: string;
  nonce: string;
  grant: GoogleOAuthGrant;
}> {
  if (env.CENTRAL_GATEKEEPER_URL) {
    const delivery = await redeemCentralOAuth(env, "google", ticket);
    return { accountId: delivery.accountId, nonce: delivery.nonce, grant: {
      refreshToken: `cgc1.${delivery.grant.credentialId}`,
      accessToken: { token: delivery.grant.accessToken, expires: new Date(delivery.grant.expiresAt) },
      grantedScopes: delivery.grant.scopes,
    } };
  }
  if (!HEX64.test(ticket)) throw new Error("Invalid OAuth ticket.");
  const result = await call(env, "/redeem", { ticket });
  if (!result || typeof result !== "object") throw new Error("Invalid OAuth credential handoff.");
  const delivery = result as Record<string, unknown>;
  const grant = delivery.grant as Record<string, unknown> | undefined;
  const accessToken = grant?.accessToken as Record<string, unknown> | undefined;
  if (typeof delivery.accountId !== "string" || !HEX64.test(delivery.accountId) ||
      typeof delivery.nonce !== "string" || !HEX64.test(delivery.nonce) ||
      typeof grant?.refreshToken !== "string" || !grant.refreshToken.startsWith("gk1.") ||
      typeof accessToken?.token !== "string" || accessToken.token !== grant.refreshToken ||
      typeof accessToken.expires !== "string" || !Array.isArray(grant.grantedScopes) ||
      !grant.grantedScopes.every(scope => typeof scope === "string")) {
    throw new Error("Invalid OAuth credential handoff.");
  }
  const expires = new Date(accessToken.expires);
  if (!Number.isFinite(expires.valueOf())) throw new Error("Invalid OAuth credential expiry.");
  return { accountId: delivery.accountId, nonce: delivery.nonce, grant: {
    refreshToken: grant.refreshToken,
    accessToken: { token: accessToken.token, expires },
    grantedScopes: grant.grantedScopes as string[],
  } };
}

/** Refresh inside the broker; only a newly sealed grant ever comes back. */
export async function refreshBrokerToken(env: BrokerEnv, sealedGrant: string,
                                         signal?: AbortSignal, rejectedAccessToken?: string): Promise<AccessTokenResult & {
                                           sealedGrant?: string;
                                         }> {
  if (env.CENTRAL_GATEKEEPER_URL) {
    const result = await refreshCentralOAuth(env, "google", sealedGrant, rejectedAccessToken, signal);
    if (!result.ok) return result.reason === "policyBlocked"
      ? { ok: false, reason: "policyBlocked", detail: "admin_policy_enforced" } : { ok: false, reason: "revoked" };
    return { ok: true, token: { token: result.grant.accessToken, expires: new Date(result.grant.expiresAt) } };
  }
  const result = await call(env, "/refresh", { sealedGrant }, signal);
  if (!result || typeof result !== "object" || !("ok" in result)) {
    throw new Error("Invalid central Google refresh response.");
  }
  if (result.ok === false) {
    if ("reason" in result && result.reason === "revoked") return { ok: false, reason: "revoked" };
    if ("reason" in result && result.reason === "policyBlocked") {
      return { ok: false, reason: "policyBlocked", detail: "admin_policy_enforced" };
    }
  }
  if (result.ok !== true || !("token" in result) || !result.token ||
      typeof result.token !== "object") {
    throw new Error("Invalid central Google refresh response.");
  }
  const token = result.token as Record<string, unknown>;
  if (typeof token.token !== "string" || typeof token.expires !== "string" ||
      !("sealedGrant" in result) || typeof result.sealedGrant !== "string" ||
      token.token !== result.sealedGrant || !token.token.startsWith("gk1.")) {
    throw new Error("Invalid central Google refresh response.");
  }
  const expires = new Date(token.expires);
  if (!Number.isFinite(expires.valueOf())) throw new Error("Invalid central Google refresh expiry.");
  return { ok: true, token: { token: token.token, expires }, sealedGrant: result.sealedGrant };
}

/** Forward only the existing Google API request; no usable credential leaves the broker. */
export async function proxyGoogleRequest(env: BrokerEnv, sealedGrant: string, url: string,
                                         init: RequestInit): Promise<Response> {
  if (!sealedGrant.startsWith("gk1.")) throw new Error("Expected a sealed Google grant.");
  const original = new Headers(init.headers);
  const forwarded = new Headers({
    "x-gatekeeper-grant": sealedGrant,
    "x-google-url": url,
    "x-google-method": init.method ?? "GET",
  });
  for (const name of ["Accept", "Content-Type", "If-Match", "If-None-Match",
                      "X-Goog-Client-Request-Id"]) {
    const value = original.get(name);
    if (value) forwarded.set(name, value);
  }
  const body = init.body ? new Uint8Array(await new Response(init.body).arrayBuffer())
    : new Uint8Array();
  return fetch(await signed(env, "/proxy", body, forwarded), {
    redirect: "manual", signal: init.signal,
  });
}

/** Decorate existing API clients without changing their agent-facing capability interfaces. */
export function brokerTokenProvider(env: BrokerEnv, provider: AccessTokenProvider)
    : AccessTokenProvider {
  if (env.CENTRAL_GATEKEEPER_URL) return provider;
  return Object.assign(provider, {
    transport: (url: string, init: RequestInit, token: string) =>
      proxyGoogleRequest(env, token, url, init),
  });
}

/** Disconnect the central refresh grant without revoking other Google project grants. */
export const revokeManagedGoogleGrant = (env: BrokerEnv, reference: string): Promise<void> =>
  revokeCentralOAuth(env, "google", reference);
