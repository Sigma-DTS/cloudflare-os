import { afterEach, expect, it, vi } from "vitest";
import { brokerTokenProvider, redeemBrokerGrant, refreshBrokerToken } from "../src/broker-api";
import { fetchWithAuthRetry } from "../src/auth-retry";

afterEach(() => vi.restoreAllMocks());
it("uses the managed access token directly at Google while keeping only a central refresh reference", async () => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const env = { CENTRAL_GATEKEEPER_URL: "https://central.test", BROKER_URL: "https://legacy.test",
    CFOS_INSTALL_ID: `${"a".repeat(32)}:test`, CFOS_INSTALL_KEY_ID: crypto.randomUUID(),
    CFOS_INSTALL_PRIVATE_KEY: btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey) as ArrayBuffer))) };
  const grant = { credentialId: "b".repeat(64), accessToken: "google-access", expiresAt: Date.now() + 3_600_000,
    scopes: ["openid"] };
  const mock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    if (String(url) === "https://central.test/redeem") return Response.json({ accountId: "c".repeat(64), nonce: "d".repeat(64), grant });
    if (String(url) === "https://central.test/refresh") return Response.json({ ok: true, grant });
    expect(String(url)).toBe("https://www.googleapis.com/oauth2/v3/userinfo");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer google-access");
    return Response.json({ email: "user@example.test" });
  });
  const delivery = await redeemBrokerGrant(env, "e".repeat(64));
  expect(delivery.grant.refreshToken).toBe(`cgc1.${grant.credentialId}`);
  expect(delivery.grant.accessToken.token).toBe("google-access");
  const provider = brokerTokenProvider(env, async () => delivery.grant.accessToken.token);
  expect(provider.transport).toBeUndefined();
  await fetchWithAuthRetry("https://www.googleapis.com/oauth2/v3/userinfo", {}, provider);
  const renewed = await refreshBrokerToken(env, delivery.grant.refreshToken!);
  expect(renewed.ok && renewed.token.token).toBe("google-access");
  expect(mock).toHaveBeenCalledTimes(3);
});
