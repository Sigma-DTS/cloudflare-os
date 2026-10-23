import { afterEach, describe, expect, it, vi } from "vitest";
import { beginBrokerOAuth, brokerTransport, redeemBrokerGrant, refreshBrokerGrant } from "../src/broker-api";
import { GitHubApi } from "../src/github-api";

const base64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));

const identity = async () => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" },
    true, ["sign", "verify"]) as CryptoKeyPair;
  return {
    env: {
      BROKER_URL: "https://broker.example.com",
      CFOS_INSTALL_ID: `${"a".repeat(32)}:cfos-test`,
      CFOS_INSTALL_KEY_ID: crypto.randomUUID(),
      CFOS_INSTALL_PRIVATE_KEY: base64(new Uint8Array(
        await crypto.subtle.exportKey("pkcs8", pair.privateKey) as ArrayBuffer)),
    },
    publicKey: pair.publicKey,
  };
};

afterEach(() => vi.unstubAllGlobals());

describe("delegated GitHub requests", () => {
  it("delivers a usable token for managed instances and renews it through the central reference", async () => {
    const { env: legacy } = await identity();
    const env = { ...legacy, CENTRAL_GATEKEEPER_URL: "https://central.example.com" };
    const grant = { credentialId: "b".repeat(64), accessToken: "github-access", expiresAt: Date.now() + 3_600_000,
      scopes: ["repo"] };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "https://central.example.com/redeem") return Response.json({
        accountId: "c".repeat(64), nonce: "d".repeat(64), grant });
      if (String(input) === "https://central.example.com/refresh") return Response.json({ ok: true, grant });
      expect(String(input)).toBe("https://api.github.com/user");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer github-access");
      return Response.json({ login: "example", id: 1 });
    });
    const delivery = await redeemBrokerGrant(env, "e".repeat(64));
    expect(delivery.grant.sealed).toBe(`cgc1.${grant.credentialId}`);
    expect(delivery.grant.accessToken).toBe("github-access");
    expect((await new GitHubApi(async () => delivery.grant.accessToken!).getViewer()).user.login).toBe("example");
    const renewed = await refreshBrokerGrant(env, delivery.grant.sealed);
    expect(renewed.ok && renewed.grant.accessToken).toBe("github-access");
  });
  it("signs the OAuth flow request including the install-specific callback", async () => {
    const { env, publicKey } = await identity();
    vi.stubGlobal("fetch", async (request: Request) => {
      const body = new Uint8Array(await request.clone().arrayBuffer());
      const headers = request.headers;
      const digest = base64(new Uint8Array(await crypto.subtle.digest("SHA-256", body)))
        .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
      expect(headers.get("x-cfos-content-digest")).toBe(digest);
      const canonical = ["CFOS-GITHUB-1", "POST", "/begin", env.CFOS_INSTALL_ID,
        env.CFOS_INSTALL_KEY_ID, headers.get("x-cfos-timestamp"),
        headers.get("x-cfos-nonce"), digest, "", "", "", "", "application/json",
        "", "", "",
      ].join("\n");
      const signature = headers.get("x-cfos-signature")!;
      const binary = atob(signature.replaceAll("-", "+").replaceAll("_", "/")
        .padEnd(Math.ceil(signature.length / 4) * 4, "="));
      expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey,
        Uint8Array.from(binary, char => char.charCodeAt(0)),
        new TextEncoder().encode(canonical))).toBe(true);
      expect(JSON.parse(new TextDecoder().decode(body))).toEqual({
        accountId: "b".repeat(64), nonce: "c".repeat(64), scopes: ["repo"],
        callbackPath: "/gatekeeper/githubproxy/oauth",
      });
      return Response.json({ authorizationUrl:
        "https://github.com/login/oauth/authorize?client_id=test" });
    });
    await expect(beginBrokerOAuth(env, "b".repeat(64), "c".repeat(64), ["repo"],
      "/gatekeeper/githubproxy/oauth")).resolves.toContain("github.com/login/oauth/authorize");
  });

  it("sends a sealed grant only to the broker, not GitHub", async () => {
    const { env } = await identity();
    vi.stubGlobal("fetch", async (request: Request) => {
      expect(request.url).toBe("https://broker.example.com/proxy");
      expect(request.headers.get("authorization")).toBeNull();
      expect(request.headers.get("x-github-url"))
        .toBe("https://api.github.com/repos/example/test/issues");
      expect(request.headers.get("x-gatekeeper-grant")).toBe("ghg1.test.encrypted");
      expect(request.headers.get("x-github-method")).toBe("GET");
      return Response.json([]);
    });
    const result = await brokerTransport(env)(
      "https://api.github.com/repos/example/test/issues", {
        method: "GET", headers: { Authorization: "Bearer ghg1.test.encrypted" },
      });
    expect(await result.json()).toEqual([]);
  });

  it("forwards Git smart-HTTP request bytes through the broker", async () => {
    const { env } = await identity();
    const packet = new Uint8Array([0, 5, 1, 2, 255]);
    vi.stubGlobal("fetch", async (request: Request) => {
      expect(request.url).toBe("https://broker.example.com/proxy");
      expect(request.headers.get("authorization")).toBeNull();
      expect(request.headers.get("x-github-method")).toBe("POST");
      expect(request.headers.get("x-github-url"))
        .toBe("https://github.com/example/test.git/git-receive-pack");
      expect(request.headers.get("x-gatekeeper-grant")).toBe("ghg1.test.encrypted");
      expect(request.headers.get("content-type"))
        .toBe("application/x-git-receive-pack-request");
      expect(new Uint8Array(await request.arrayBuffer())).toEqual(packet);
      return new Response(packet, {
        headers: { "Content-Type": "application/x-git-receive-pack-result" },
      });
    });
    const response = await brokerTransport(env)(
      "https://github.com/example/test.git/git-receive-pack", {
        method: "POST",
        headers: {
          Authorization: `Basic ${btoa("x-access-token:ghg1.test.encrypted")}`,
          "Content-Type": "application/x-git-receive-pack-request",
        },
        body: new ReadableStream<Uint8Array>({
          start(controller) { controller.enqueue(packet); controller.close(); },
        }),
      });
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(packet);
  });

  it("rejects a raw access token before making any broker request", async () => {
    const { env } = await identity();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(brokerTransport(env)("https://api.github.com/user", {
      headers: { Authorization: "Bearer raw-github-access-token" },
    })).rejects.toThrow("encrypted GitHub grant");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
