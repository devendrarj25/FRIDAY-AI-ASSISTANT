/**
 * Real OAuth loopback + PKCE token exchange (GitHub HTTP mocked), Twilio
 * Verify (HTTP mocked), and MCP stdio tool listing/call. The local callback
 * server and code-exchange logic are actually exercised.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const connectors = require("../../electron/connectors.cjs") as {
  CONNECTORS: Record<string, { authType?: string; name: string }>;
  listConnectors: (root: string) => { connectors: Array<Record<string, unknown>> };
  connect: (
    root: string,
    id: string,
    values?: Record<string, string>,
    fetchImpl?: typeof fetch,
  ) => Promise<{
    ok: boolean;
    error?: string;
    account?: string;
    connector?: { connected: boolean };
  }>;
  startOAuth: (
    root: string,
    id: string,
    values?: Record<string, string>,
    options?: {
      fetchImpl?: typeof fetch;
      openExternal?: (url: string) => Promise<unknown>;
      timeoutMs?: number;
    },
  ) => Promise<{
    ok: boolean;
    error?: string;
    account?: string;
    connector?: { connected: boolean; account?: string };
  }>;
  startPhoneVerify: (
    root: string,
    id: string,
    values?: Record<string, string>,
    fetchImpl?: typeof fetch,
  ) => Promise<{ ok: boolean; error?: string; pending?: boolean }>;
  confirmPhone: (
    root: string,
    id: string,
    values?: Record<string, string>,
    fetchImpl?: typeof fetch,
  ) => Promise<{ ok: boolean; error?: string; account?: string }>;
  callConnector: (
    root: string,
    id: string,
    action: string,
    params?: Record<string, unknown>,
    fetchImpl?: typeof fetch,
  ) => Promise<{ ok: boolean; error?: string; lines?: string[] }>;
  disconnect: (root: string, id: string) => { ok: boolean };
};
const credentials = require("../../electron/credentials.cjs") as {
  getSecret: (root: string, id: string) => string;
  setSecret: (root: string, id: string, value: string) => { ok: boolean };
};
const oauthLoopback = require("../../electron/oauth-loopback.cjs") as {
  pkcePair: () => { verifier: string; challenge: string; method: string };
  listen: (opts?: { port?: number; timeoutMs?: number }) => Promise<{
    port: number;
    redirectUri: string;
    wait: () => Promise<{ code: string; state: string }>;
    close: () => Promise<void>;
  }>;
};

type ConnectorRow = {
  id: string;
  connected?: boolean;
  account?: string;
  actions?: { id: string; risk: string }[];
};

const spec = (id: string) => connectors.CONNECTORS[id];
const listed = (root: string, id: string) =>
  connectors.listConnectors(root).connectors.find((row) => row["id"] === id) as
    ConnectorRow | undefined;
const headerAuth = (headers?: Record<string, string>) =>
  String((headers && (headers["Authorization"] || headers["authorization"])) || "");
const temps: string[] = [];
const temp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-connectors-"));
  temps.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
  temps.length = 0;
});

function jsonRes(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    headers: { get: () => "application/json" },
  };
}

function githubFetch(opts: { userOk?: boolean } = {}) {
  const userOk = opts.userOk !== false;
  return async (url: string, init?: { body?: string; headers?: Record<string, string> }) => {
    const href = String(url);
    if (href.includes("login/oauth/access_token")) {
      const body = String(init?.body || "");
      if (!body.includes("code=test-github-code") || !body.includes("code_verifier=")) {
        return jsonRes(400, { error: "bad_verification_code" });
      }
      return jsonRes(200, {
        access_token: "gho_test_token",
        token_type: "bearer",
        scope: "read:user,repo",
      });
    }
    if (href.includes("api.github.com/user")) {
      const auth = headerAuth(init?.headers);
      if (!userOk || !auth.includes("gho_test_token")) {
        return jsonRes(401, { message: "Bad credentials" });
      }
      return jsonRes(200, { login: "devendrarj25" });
    }
    return jsonRes(404, { message: "not mocked" });
  };
}

describe("connector catalog auth types", () => {
  it("declares real authType on every connector and includes Gmail + MCP", () => {
    const ids = Object.keys(connectors.CONNECTORS);
    expect(ids).toEqual(
      expect.arrayContaining([
        "github",
        "google-gmail",
        "twilio",
        "mcp",
        "discord",
        "telegram",
        "onedrive",
        "microsoft-teams",
        "zoom",
        "asana",
        "airtable",
        "sendgrid",
        "figma",
        "calendly",
        "whatsapp",
        "gitlab",
        "bluesky",
        "google-tasks",
        "microsoft-todo",
        "neon",
        "mattermost",
        "mailgun",
        "wordpress",
        "shopify",
        "twitter",
        "instagram",
        "facebook",
        "linkedin",
      ]),
    );
    expect(ids.length).toBe(113);
    expect(ids.filter((id) => spec(id)?.authType === "oauth")).toHaveLength(17);
    expect(ids.filter((id) => spec(id)?.authType === "apiKey")).toHaveLength(94);
    for (const id of ids) {
      expect(spec(id)?.authType, id).toMatch(/^(oauth|apiKey|phone|mcp)$/);
      expect(spec(id)?.name, id).toBeTruthy();
    }
    expect(spec("github")?.authType).toBe("oauth");
    expect(spec("google-gmail")?.authType).toBe("oauth");
    expect(spec("google-tasks")?.authType).toBe("oauth");
    expect(spec("microsoft-todo")?.authType).toBe("oauth");
    expect(spec("twilio")?.authType).toBe("phone");
    expect(spec("mcp")?.authType).toBe("mcp");
    expect(spec("notion")?.authType).toBe("apiKey");
    expect(spec("whatsapp")?.authType).toBe("apiKey");
    expect(spec("bluesky")?.authType).toBe("apiKey");
    const src = fs.readFileSync(path.resolve(__dirname, "../../electron/connectors.cjs"), "utf8");
    expect(src).toContain("{ me { name email } }");
    expect(src).toContain("{ boards (limit: 20) { id name } }");
  });
});

describe("OAuth loopback + GitHub token exchange", () => {
  it("captures a real loopback code, exchanges it, and connects only after /user succeeds", async () => {
    const root = temp();
    const fetchImpl = githubFetch();
    const result = await connectors.startOAuth(
      root,
      "github",
      { clientId: "iv1.test", clientSecret: "s3cret" },
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        timeoutMs: 15_000,
        openExternal: async (url: string) => {
          const parsed = new URL(url);
          expect(parsed.hostname).toBe("github.com");
          expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
          expect(parsed.searchParams.get("code_challenge")).toBeTruthy();
          const redirect = parsed.searchParams.get("redirect_uri") || "";
          const state = parsed.searchParams.get("state") || "";
          expect(redirect).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/);
          const hit = await fetch(
            `${redirect}?code=test-github-code&state=${encodeURIComponent(state)}`,
          );
          expect(hit.ok).toBe(true);
        },
      },
    );
    expect(result.ok).toBe(true);
    expect(result.account).toBe("devendrarj25");
    expect(result.connector?.connected).toBe(true);
    expect(credentials.getSecret(root, "connector.github.accessToken")).toBe("gho_test_token");
    const github = listed(root, "github");
    expect(github?.connected).toBe(true);
    expect(github?.account).toBe("devendrarj25");
  });

  it("refuses a state mismatch and does not mark GitHub connected", async () => {
    const root = temp();
    const result = await connectors.startOAuth(
      root,
      "github",
      { clientId: "iv1.test", clientSecret: "s3cret" },
      {
        fetchImpl: githubFetch() as unknown as typeof fetch,
        timeoutMs: 15_000,
        openExternal: async (url: string) => {
          const parsed = new URL(url);
          const redirect = parsed.searchParams.get("redirect_uri") || "";
          await fetch(`${redirect}?code=test-github-code&state=wrong-state`);
        },
      },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/state mismatch/i);
    expect(listed(root, "github")?.connected).toBe(false);
  });

  it("does not mark connected when the token works but /user rejects it", async () => {
    const root = temp();
    const result = await connectors.startOAuth(
      root,
      "github",
      { clientId: "iv1.test", clientSecret: "s3cret" },
      {
        fetchImpl: githubFetch({ userOk: false }) as unknown as typeof fetch,
        timeoutMs: 15_000,
        openExternal: async (url: string) => {
          const parsed = new URL(url);
          const redirect = parsed.searchParams.get("redirect_uri") || "";
          const state = parsed.searchParams.get("state") || "";
          await fetch(`${redirect}?code=test-github-code&state=${encodeURIComponent(state)}`);
        },
      },
    );
    expect(result.ok).toBe(false);
    expect(listed(root, "github")?.connected).toBe(false);
  });

  it("keeps the pasted PAT path working", async () => {
    const root = temp();
    const fetchImpl = async (url: string, init?: { headers?: Record<string, string> }) => {
      if (String(url).includes("api.github.com/user")) {
        const auth = headerAuth(init?.headers);
        if (!auth.includes("ghp_pat_token")) return jsonRes(401, { message: "Bad credentials" });
        return jsonRes(200, { login: "devendrarj25" });
      }
      return jsonRes(404, {});
    };
    const result = await connectors.connect(
      root,
      "github",
      { token: "ghp_pat_token" },
      fetchImpl as unknown as typeof fetch,
    );
    expect(result.ok).toBe(true);
    expect(result.account).toBe("devendrarj25");
  });
});

describe("callConnector requires Connected, not just stored tokens", () => {
  it("refuses an action when credentials exist but the probe never succeeded", async () => {
    const root = temp();
    expect(credentials.setSecret(root, "connector.github.token", "gho_unverified").ok).toBe(true);
    fs.mkdirSync(path.join(root, "config"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "config", "connectors.json"),
      JSON.stringify({ github: { connected: false, lastError: "probe failed", fields: {} } }),
    );
    const result = await connectors.callConnector(
      root,
      "github",
      "repos",
      {},
      githubFetch() as unknown as typeof fetch,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not connected/i);
  });
});

describe("oauth loopback module", () => {
  it("builds S256 PKCE and serves /oauth/callback", async () => {
    const pair = oauthLoopback.pkcePair();
    expect(pair.method).toBe("S256");
    expect(pair.verifier.length).toBeGreaterThan(20);
    expect(pair.challenge.length).toBeGreaterThan(20);
    const listener = await oauthLoopback.listen({ port: 0, timeoutMs: 8_000 });
    const pending = listener.wait();
    const miss = await fetch(`http://127.0.0.1:${listener.port}/not-callback`);
    expect(miss.status).toBe(404);
    const hit = await fetch(`${listener.redirectUri}?code=abc&state=xyz`);
    expect(hit.ok).toBe(true);
    await expect(pending).resolves.toEqual({ code: "abc", state: "xyz" });
    await listener.close();
  });
});

describe("Twilio Verify is real and never fakes connected", () => {
  function twilioFetch(approvedCode: string) {
    return async (url: string, init?: { body?: string }) => {
      const href = String(url);
      const body = String(init?.body || "");
      if (href.includes("/Verifications") && !href.includes("VerificationCheck")) {
        return jsonRes(201, { status: "pending", to: "+15555550100", sid: "VE_test" });
      }
      if (href.includes("VerificationCheck")) {
        const params = new URLSearchParams(body);
        const status = params.get("Code") === approvedCode ? "approved" : "pending";
        return jsonRes(200, { status, to: "+15555550100" });
      }
      if (href.includes("api.twilio.com/2010-04-01/Accounts/")) {
        return jsonRes(200, { friendly_name: "FRIDAY test", sid: "ACtest" });
      }
      return jsonRes(404, {});
    };
  }

  it("send does not connect; wrong code stays disconnected; approved + account probe connects", async () => {
    const root = temp();
    const fetchImpl = twilioFetch("123456") as unknown as typeof fetch;
    const fields = {
      accountSid: "ACtest",
      authToken: "token",
      verifyServiceSid: "VAtest",
      phone: "+15555550100",
    };
    const sent = await connectors.startPhoneVerify(root, "twilio", fields, fetchImpl);
    expect(sent.ok).toBe(true);
    expect(sent.pending).toBe(true);
    expect(listed(root, "twilio")?.connected).toBe(false);

    const bare = await connectors.connect(root, "twilio", fields, fetchImpl);
    expect(bare.ok).toBe(false);
    expect(bare.error).toMatch(/SMS code/i);

    const wrong = await connectors.confirmPhone(
      root,
      "twilio",
      { ...fields, code: "000000" },
      fetchImpl,
    );
    expect(wrong.ok).toBe(false);
    expect(listed(root, "twilio")?.connected).toBe(false);

    const ok = await connectors.confirmPhone(
      root,
      "twilio",
      { ...fields, code: "123456" },
      fetchImpl,
    );
    expect(ok.ok).toBe(true);
    expect(ok.account).toBe("FRIDAY test");
    expect(listed(root, "twilio")?.connected).toBe(true);
  });
});

describe("MCP connector lists and calls real stdio tools", () => {
  it("handshakes a fixture server, lists echo/ping, and calls echo through connectorTools bridge ids", async () => {
    const root = temp();
    const fixture = path.join(__dirname, "fixtures", "mcp-echo-server.cjs");
    const command = `${process.execPath} ${JSON.stringify(fixture)}`;
    const connected = await connectors.connect(root, "mcp", { command });
    expect(connected.ok).toBe(true);
    const listedMcp = listed(root, "mcp");
    expect(listedMcp?.connected).toBe(true);
    expect(listedMcp?.actions?.map((a) => a.id)).toEqual(
      expect.arrayContaining(["tools", "mcp:echo", "mcp:ping"]),
    );
    expect(listedMcp?.actions?.find((a) => a.id === "mcp:echo")?.risk).toBe("write");
    const echo = await connectors.callConnector(root, "mcp", "mcp:echo", {
      arguments: JSON.stringify({ text: "hello-mcp" }),
    });
    expect(echo.ok).toBe(true);
    expect(echo.lines?.join(" ")).toContain("hello-mcp");
  });
});

describe("CMS write and social posting connectors", () => {
  it("publishes a WordPress post only after a real users/me probe", async () => {
    const root = temp();
    const fetchImpl = async (url: string, init?: { method?: string; body?: string }) => {
      const href = String(url);
      if (href.endsWith("/wp-json/wp/v2/users/me")) {
        return jsonRes(200, { name: "Devendra", slug: "devendra" });
      }
      if (
        href.endsWith("/wp-json/wp/v2/posts") &&
        String(init?.method || "GET").toUpperCase() === "POST"
      ) {
        const body = JSON.parse(String(init?.body || "{}")) as { title?: string; content?: string };
        expect(body.title).toBe("Ward lamps");
        expect(body.content).toMatch(/LED/);
        return jsonRes(201, { id: 44, link: "https://example.com/ward-lamps" });
      }
      return jsonRes(404, { message: "not mocked" });
    };
    const connected = await connectors.connect(
      root,
      "wordpress",
      { site: "https://example.com", user: "devendra", token: "app-pass" },
      fetchImpl as unknown as typeof fetch,
    );
    expect(connected.ok).toBe(true);
    expect(connected.account).toBe("Devendra");
    const published = await connectors.callConnector(
      root,
      "wordpress",
      "publish",
      { title: "Ward lamps", content: "LED street lamps" },
      fetchImpl as unknown as typeof fetch,
    );
    expect(published.ok).toBe(true);
    expect(published.lines?.join(" ")).toContain("https://example.com/ward-lamps");
  });

  it("signs X/Twitter calls with OAuth 1.0a and posts after /2/users/me", async () => {
    const root = temp();
    const seen: string[] = [];
    const fetchImpl = async (
      url: string,
      init?: { method?: string; headers?: Record<string, string>; body?: string },
    ) => {
      const href = String(url);
      const auth = headerAuth(init?.headers);
      seen.push(`${String(init?.method || "GET").toUpperCase()} ${href}`);
      expect(auth.startsWith("OAuth ")).toBe(true);
      expect(auth).toMatch(/oauth_signature=/);
      if (href.includes("/2/users/me")) return jsonRes(200, { data: { username: "devendra" } });
      if (href.includes("/2/tweets")) {
        expect(String(init?.method || "").toUpperCase()).toBe("POST");
        expect(String(init?.body || "")).toContain("hello from FRIDAY");
        return jsonRes(201, { data: { id: "123" } });
      }
      return jsonRes(404, { message: "not mocked" });
    };
    const connected = await connectors.connect(
      root,
      "twitter",
      {
        apiKey: "key",
        apiSecret: "secret",
        accessToken: "token",
        accessSecret: "token-secret",
      },
      fetchImpl as unknown as typeof fetch,
    );
    expect(connected.ok).toBe(true);
    expect(connected.account).toBe("devendra");
    const posted = await connectors.callConnector(
      root,
      "twitter",
      "post",
      { text: "hello from FRIDAY" },
      fetchImpl as unknown as typeof fetch,
    );
    expect(posted.ok).toBe(true);
    expect(posted.lines?.join(" ")).toContain("posted 123");
    expect(seen.some((row) => row.includes("/2/users/me"))).toBe(true);
    expect(seen.some((row) => row.includes("/2/tweets"))).toBe(true);
  });

  it("refuses Instagram text-only feed posts honestly", async () => {
    const root = temp();
    const fetchImpl = async (url: string) => {
      if (String(url).includes("graph.facebook.com")) {
        return jsonRes(200, { id: "1789", username: "fridaydesk" });
      }
      return jsonRes(404, {});
    };
    const connected = await connectors.connect(
      root,
      "instagram",
      { token: "ig-token", igUserId: "1789" },
      fetchImpl as unknown as typeof fetch,
    );
    expect(connected.ok).toBe(true);
    const posted = await connectors.callConnector(
      root,
      "instagram",
      "post",
      { caption: "text only" },
      fetchImpl as unknown as typeof fetch,
    );
    expect(posted.ok).toBe(false);
    expect(posted.error).toMatch(/public image URL/i);
  });
});
