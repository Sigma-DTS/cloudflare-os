import { beginCentralOAuth, redeemCentralOAuth, refreshCentralOAuth, revokeCentralOAuth } from "@gadgets/gatekeeper-kit/central-oauth";
import type { GitHubTransport } from "./github-api";

/** The installer injects this identity only into the delegated GitHub Worker. */
export type BrokerEnv = {
  BROKER_URL?: string;
  CENTRAL_GATEKEEPER_URL?: string;
  CFOS_INSTALL_ID?: string;
  CFOS_INSTALL_KEY_ID?: string;
  CFOS_INSTALL_PRIVATE_KEY?: string;
};

export type SealedGitHubGrant = { sealed: string; expiresAt: number; scopes: string[]; accessToken?: string };

const MAX_BODY_BYTES = 25 * 1024 * 1024;
const HEX64 = /^[0-9a-f]{64}$/;

const endpoint = (env: BrokerEnv, path: string): URL => {
  if (!env.BROKER_URL || !env.CFOS_INSTALL_ID || !env.CFOS_INSTALL_KEY_ID ||
      !env.CFOS_INSTALL_PRIVATE_KEY) {
    throw new Error("Central GitHub delegation is not configured for this installation.");
  }
  const base = new URL(env.BROKER_URL);
  if (base.protocol !== "https:" || base.pathname !== "/" || base.search || base.hash ||
      base.username || base.password) throw new Error("BROKER_URL must be an HTTPS origin.");
  base.pathname = path;
  return base;
};

const base64url = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes))
  .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

const signed = async (env: BrokerEnv, path: string, body: Uint8Array,
                      forwarded?: Headers): Promise<Request> => {
  const url = endpoint(env, path);
  if (body.byteLength > MAX_BODY_BYTES) throw new Error("GitHub request exceeds broker limit.");
  const headers = new Headers(forwarded);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomUUID();
  const digest = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", body)));
  headers.set("x-cfos-install-id", env.CFOS_INSTALL_ID!);
  headers.set("x-cfos-key-id", env.CFOS_INSTALL_KEY_ID!);
  headers.set("x-cfos-timestamp", timestamp);
  headers.set("x-cfos-nonce", nonce);
  headers.set("x-cfos-content-digest", digest);
  const canonical = ["CFOS-GITHUB-1", "POST", url.pathname,
    env.CFOS_INSTALL_ID!, env.CFOS_INSTALL_KEY_ID!, timestamp, nonce, digest,
    ...["x-github-url", "x-github-method", "x-gatekeeper-grant", "accept", "content-type",
      "if-match", "if-none-match", "git-protocol"].map(name => headers.get(name) ?? ""),
  ].join("\n");
  const privateKey = Uint8Array.from(atob(env.CFOS_INSTALL_PRIVATE_KEY!),
    char => char.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", privateKey,
    { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  headers.set("x-cfos-signature", base64url(new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(canonical)))));
  return new Request(url, { method: "POST", headers, body });
};

const call = async (env: BrokerEnv, path: string, payload: object): Promise<unknown> => {
  const request = await signed(env, path, new TextEncoder().encode(JSON.stringify(payload)),
    new Headers({ "content-type": "application/json" }));
  const response = await fetch(request, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
  if (!response.ok) {
    response.body?.cancel();
    throw new Error(`Central GitHub broker rejected ${path} (${response.status}).`);
  }
  return response.json();
};

const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid central GitHub broker response.");
  }
  return value as Record<string, unknown>;
};

const grant = (value: unknown): SealedGitHubGrant => {
  const result = record(value);
  if (typeof result.sealed !== "string" || !result.sealed.startsWith("ghg1.") ||
      typeof result.expiresAt !== "number" || !Number.isFinite(result.expiresAt) ||
      !Array.isArray(result.scopes) ||
      !result.scopes.every(scope => typeof scope === "string")) {
    throw new Error("Invalid sealed GitHub grant.");
  }
  return { sealed: result.sealed, expiresAt: result.expiresAt,
    scopes: result.scopes as string[] };
};

export const beginBrokerOAuth = async (
  env: BrokerEnv, accountId: string, nonce: string, scopes: string[], callbackPath: string,
): Promise<string> => {
  if (env.CENTRAL_GATEKEEPER_URL) return beginCentralOAuth(env, "github", { accountId, nonce, scopes, callbackPath },
    "https://github.com/login/oauth/authorize");
  const response = record(await call(env, "/begin", { accountId, nonce, scopes, callbackPath }));
  if (typeof response.authorizationUrl !== "string") throw new Error("Invalid GitHub authorization URL.");
  const url = new URL(response.authorizationUrl);
  if (url.origin !== "https://github.com" || url.pathname !== "/login/oauth/authorize") {
    throw new Error("Unexpected GitHub authorization URL.");
  }
  return url.href;
};

export const redeemBrokerGrant = async (env: BrokerEnv, ticket: string): Promise<{
  accountId: string; nonce: string; grant: SealedGitHubGrant;
}> => {
  if (env.CENTRAL_GATEKEEPER_URL) {
    const delivery = await redeemCentralOAuth(env, "github", ticket);
    return { accountId: delivery.accountId, nonce: delivery.nonce, grant: {
      sealed: `cgc1.${delivery.grant.credentialId}`, accessToken: delivery.grant.accessToken,
      expiresAt: delivery.grant.expiresAt, scopes: delivery.grant.scopes } };
  }
  if (!HEX64.test(ticket)) throw new Error("Invalid OAuth ticket.");
  const response = record(await call(env, "/redeem", { ticket }));
  if (typeof response.accountId !== "string" || !HEX64.test(response.accountId) ||
      typeof response.nonce !== "string" || !HEX64.test(response.nonce)) {
    throw new Error("Invalid OAuth handoff.");
  }
  return { accountId: response.accountId, nonce: response.nonce, grant: grant(response.grant) };
};

export const refreshBrokerGrant = async (env: BrokerEnv, sealedGrant: string): Promise<
  { ok: true; grant: SealedGitHubGrant } | { ok: false }
> => {
  if (env.CENTRAL_GATEKEEPER_URL) {
    const result = await refreshCentralOAuth(env, "github", sealedGrant);
    return result.ok ? { ok: true, grant: { sealed: `cgc1.${result.grant.credentialId}`,
      accessToken: result.grant.accessToken, expiresAt: result.grant.expiresAt, scopes: result.grant.scopes } }
      : { ok: false };
  }
  const response = record(await call(env, "/refresh", { sealedGrant }));
  if (response.ok === false && response.reason === "revoked") return { ok: false };
  if (response.ok !== true) throw new Error("Invalid GitHub refresh response.");
  return { ok: true, grant: grant({ sealed: response.sealedGrant,
    expiresAt: response.expiresAt, scopes: response.scopes }) };
};

export const revokeBrokerGrant = async (env: BrokerEnv, sealedGrant: string): Promise<void> => {
  if (env.CENTRAL_GATEKEEPER_URL) return revokeCentralOAuth(env, "github", sealedGrant);
  const response = record(await call(env, "/revoke", { sealedGrant }));
  if (response.ok !== true) throw new Error("GitHub token revoke failed.");
};

/** No usable GitHub credential or arbitrary target host ever leaves the broker. */
export const brokerTransport = (env: BrokerEnv): GitHubTransport => async (url, init) => {
  const original = new Headers(init.headers);
  const authorization = original.get("Authorization") ?? "";
  let sealed: string | undefined;
  if (authorization.startsWith("Bearer ")) sealed = authorization.slice(7);
  if (authorization.startsWith("Basic ")) {
    try {
      const decoded = atob(authorization.slice(6));
      if (decoded.startsWith("x-access-token:")) sealed = decoded.slice(15);
    } catch { /* reject malformed credentials */ }
  }
  if (!sealed?.startsWith("ghg1.")) throw new Error("Expected an encrypted GitHub grant.");
  const forwarded = new Headers({
    "x-github-url": url,
    "x-github-method": init.method ?? "GET",
    "x-gatekeeper-grant": sealed,
  });
  for (const name of ["accept", "content-type", "if-match", "if-none-match", "git-protocol"]) {
    const value = original.get(name);
    if (value) forwarded.set(name, value);
  }
  const body = init.body ? new Uint8Array(await new Response(init.body).arrayBuffer())
    : new Uint8Array();
  const request = await signed(env, "/proxy", body, forwarded);
  return fetch(request, { redirect: "manual", signal: init.signal });
};
