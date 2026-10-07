/**
 * FRIDAY · external service connectors (main process, authoritative).
 *
 * ONE registry of the outside services FRIDAY may use — calendar, mail-adjacent
 * task tools, code hosts, notes, storage — kept in exactly the same shape the
 * cloud model providers already use in electron/models.cjs:
 *
 *   • credentials never reach the renderer: they live in the canonical secret
 *     store (<FRIDAY_ROOT>/security/credentials, Electron safeStorage),
 *   • "connected" is only ever written after a REAL authenticated call to the
 *     provider succeeded — a saved token alone never counts as connected,
 *   • every request goes through electron/net-fetch so Windows proxy / TLS
 *     settings apply, exactly like provider calls do.
 *
 * Each connector declares its fields, one verification request and a small set
 * of real actions. Actions carry a risk tier the renderer's governance gate
 * uses, so a write action (posting, creating) still asks the owner first.
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const credentials = require("./credentials.cjs");
const { fetchCompat } = require("./net-fetch.cjs");
const oauthLoopback = require("./oauth-loopback.cjs");
const mcpClient = require("./mcp-client.cjs");

const STATE_FILE = path.join("config", "connectors.json");
const SECRET_ID = (id, field) => `connector.${id}.${field}`;

const text = (value) => (value == null ? "" : String(value));
const clamp = (value, fallback, max) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), max) : fallback;
};
const list = (rows, render) => rows.map(render).filter(Boolean);

const percentEncode = (value) =>
  encodeURIComponent(String(value)).replace(
    /[!'()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );

/** OAuth 1.0a HMAC-SHA1 header for X/Twitter user-context calls (JSON body is not signed). */
function oauth1Header(fields, method, url) {
  const parsed = new URL(url);
  const params = {};
  parsed.searchParams.forEach((value, key) => {
    params[key] = value;
  });
  const oauth = {
    oauth_consumer_key: text(fields.apiKey),
    oauth_nonce: crypto.randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: text(fields.accessToken),
    oauth_version: "1.0",
  };
  Object.assign(params, oauth);
  const paramStr = Object.keys(params)
    .sort()
    .map((key) => `${percentEncode(key)}=${percentEncode(params[key])}`)
    .join("&");
  const baseUrl = `${parsed.origin}${parsed.pathname}`;
  const base = `${String(method || "GET").toUpperCase()}&${percentEncode(baseUrl)}&${percentEncode(paramStr)}`;
  const signingKey = `${percentEncode(text(fields.apiSecret))}&${percentEncode(text(fields.accessSecret))}`;
  oauth.oauth_signature = crypto.createHmac("sha1", signingKey).update(base).digest("base64");
  const header = Object.keys(oauth)
    .sort()
    .map((key) => `${percentEncode(key)}="${percentEncode(oauth[key])}"`)
    .join(", ");
  return { Authorization: `OAuth ${header}` };
}

const shopHost = (fields) =>
  text(fields.shop)
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
const wpSite = (fields) => text(fields.site).replace(/\/+$/, "");
const graphError = (body, fallback) =>
  text(body?.error?.message || body?.message || body?.error_description) || fallback;

/* ------------------------------------------------------------------ google */
// Google connectors are OAuth: the owner pastes a client id/secret and a
// refresh token (from the Google OAuth playground or their own client), and
// FRIDAY exchanges it for a short-lived access token on demand.
const googleTokens = new Map();

async function googleAccessToken(id, fields, fetchImpl) {
  return oauthAccessToken(id, fields, fetchImpl, "https://oauth2.googleapis.com/token");
}

/** Short-lived access token from a stored refresh token (Google / Microsoft / Dropbox / Zoom). */
async function oauthAccessToken(id, fields, fetchImpl, tokenUrl) {
  const cached = googleTokens.get(id);
  if (cached && cached.expires > Date.now() + 30_000) return cached.token;
  if (text(fields.accessToken) && !text(fields.refreshToken)) return text(fields.accessToken);
  if (!text(fields.refreshToken)) return text(fields.accessToken);
  const body = new URLSearchParams({
    client_id: text(fields.clientId),
    grant_type: "refresh_token",
    refresh_token: text(fields.refreshToken),
  });
  if (text(fields.clientSecret)) body.set("client_secret", text(fields.clientSecret));
  const res = await fetchImpl(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const payload = await readBody(res);
  if (!res.ok || !payload?.access_token) {
    throw new Error(
      payload?.error_description ||
        payload?.error ||
        `The provider refused the refresh token (${res.status}).`,
    );
  }
  googleTokens.set(id, {
    token: payload.access_token,
    expires: Date.now() + Number(payload.expires_in || 3000) * 1000,
  });
  return payload.access_token;
}

const bearerFrom = (id, tokenUrl) => async (fields, fetchImpl) => ({
  Authorization: `Bearer ${await oauthAccessToken(id, fields, fetchImpl, tokenUrl)}`,
});

const googleAuth = (id) => async (fields, fetchImpl) => ({
  Authorization: `Bearer ${await googleAccessToken(id, fields, fetchImpl)}`,
});

/* ------------------------------------------------------------------ github */
// Small helpers shared by the GitHub read AND write actions, so both talk to
// exactly one client (the connector's own auth + net-fetch path).
const GH_REPO_HINT = 'Give the repository as "owner/name" or its github.com URL.';

/** "owner/name", a full URL or a git remote → "owner/name". */
function ghRepo(value) {
  const raw = text(value).trim();
  if (!raw) return "";
  const match =
    /github\.com[/:]([^/\s]+)\/([^/\s#?]+)/i.exec(raw) ||
    /^([\w.-]+)\/([\w.-]+)$/.exec(raw) ||
    null;
  if (!match) return "";
  return `${match[1]}/${match[2].replace(/\.git$/i, "")}`;
}

const ghPath = (value) =>
  text(value)
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");

function ghContentsUrl(repo, filePath, ref) {
  const query = text(ref).trim() ? `?ref=${encodeURIComponent(text(ref).trim())}` : "";
  return `https://api.github.com/repos/${repo}/contents/${ghPath(filePath)}${query}`;
}

const ghError = (what, result) =>
  `GitHub could not ${what} (${result.status})${
    result.body?.message ? ` — ${text(result.body.message).slice(0, 160)}` : ""
  }.`;

/* --------------------------------------------------------------- registry */

const CONNECTORS = {
  github: {
    name: "GitHub",
    category: "development",
    authType: "oauth",
    description: "Your repositories, issues and notifications.",
    help: "Paste a personal access token, or register an OAuth App with callback http://127.0.0.1:18765/oauth/callback and click Connect with GitHub.",
    fields: [
      { id: "token", label: "Personal access token", secret: true, optional: true },
      { id: "clientId", label: "OAuth client id", secret: false, optional: true },
      { id: "clientSecret", label: "OAuth client secret", secret: true, optional: true },
    ],
    oauth: {
      authorizeUrl: "https://github.com/login/oauth/authorize",
      tokenUrl: "https://github.com/login/oauth/access_token",
      scopes: "read:user repo notifications",
      pkce: true,
      clientSecret: true,
      tokenHeaders: { Accept: "application/json" },
    },
    auth: async (fields) => ({
      Authorization: `Bearer ${text(fields.accessToken || fields.token)}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "FRIDAY",
    }),
    verify: { url: "https://api.github.com/user", account: (body) => body?.login },
    actions: {
      repos: {
        label: "List my repositories",
        risk: "safe",
        request: (_f, params) => ({
          url: `https://api.github.com/user/repos?sort=updated&per_page=${clamp(params.limit, 10, 50)}`,
        }),
        summary: (body) =>
          list(
            Array.isArray(body) ? body : [],
            (r) => `${r.full_name} · ${r.private ? "private" : "public"}`,
          ),
      },
      issues: {
        label: "Issues assigned to me",
        risk: "safe",
        request: (_f, params) => ({
          url: `https://api.github.com/issues?filter=assigned&state=open&per_page=${clamp(params.limit, 10, 50)}`,
        }),
        summary: (body) =>
          list(
            Array.isArray(body) ? body : [],
            (i) => `${i.repository?.full_name ?? ""}#${i.number} ${i.title}`,
          ),
      },
      notifications: {
        label: "Unread notifications",
        risk: "safe",
        request: () => ({ url: "https://api.github.com/notifications" }),
        summary: (body) =>
          list(
            Array.isArray(body) ? body : [],
            (n) => `${n.repository?.full_name ?? ""} — ${n.subject?.title ?? ""}`,
          ),
      },

      // ---- read helpers used by the capability "import from GitHub" flow ---
      "list-contents": {
        label: "List a repo folder",
        risk: "safe",
        inputs: ["repo", "path", "ref"],
        run: async ({ params, call }) => {
          const repo = ghRepo(params.repo);
          if (!repo) return { ok: false, error: GH_REPO_HINT };
          const r = await call({ url: ghContentsUrl(repo, params.path, params.ref) });
          if (!r.ok) return { ok: false, error: ghError("list", r) };
          const entries = (Array.isArray(r.body) ? r.body : [r.body]).filter(Boolean).map((e) => ({
            name: text(e.name),
            path: text(e.path),
            type: text(e.type),
            size: Number(e.size || 0),
          }));
          return {
            ok: true,
            lines: entries.map((e) => `${e.type === "dir" ? "📁" : "📄"} ${e.path}`),
            data: { repo, entries },
          };
        },
      },
      "read-file": {
        label: "Read a file from a repo",
        risk: "safe",
        inputs: ["repo", "path", "ref"],
        run: async ({ params, call }) => {
          const repo = ghRepo(params.repo);
          if (!repo) return { ok: false, error: GH_REPO_HINT };
          const r = await call({ url: ghContentsUrl(repo, params.path, params.ref) });
          if (!r.ok) return { ok: false, error: ghError("read", r) };
          if (Array.isArray(r.body)) return { ok: false, error: `${params.path} is a folder.` };
          const content = Buffer.from(text(r.body?.content), "base64").toString("utf8");
          return {
            ok: true,
            lines: [`${repo}/${text(params.path)} · ${content.length} characters`],
            data: { repo, path: text(params.path), sha: text(r.body?.sha), content },
          };
        },
      },

      "latest-release": {
        label: "Latest release or tag",
        risk: "safe",
        inputs: ["repo"],
        run: async ({ params, call }) => {
          const repo = ghRepo(params.repo);
          if (!repo) return { ok: false, error: GH_REPO_HINT };
          const release = await call({
            url: `https://api.github.com/repos/${repo}/releases/latest`,
          });
          if (release.ok && release.body?.tag_name) {
            const tag = text(release.body.tag_name);
            const version = tag.replace(/^v/i, "");
            return {
              ok: true,
              lines: [`${repo} ${tag}`],
              data: { repo, version, tag, source: "release" },
            };
          }
          const tags = await call({
            url: `https://api.github.com/repos/${repo}/tags?per_page=1`,
          });
          const name = Array.isArray(tags.body) ? text(tags.body[0]?.name) : "";
          if (tags.ok && name) {
            const version = name.replace(/^v/i, "");
            return {
              ok: true,
              lines: [`${repo} ${name}`],
              data: { repo, version, tag: name, source: "tag" },
            };
          }
          return { ok: false, error: ghError("read latest release", release) };
        },
      },

      // ---- real write actions (gated: they change something off this PC) ---
      "put-file": {
        label: "Create or update a file in a repo",
        risk: "write",
        inputs: ["repo", "path", "content", "message", "branch"],
        run: async ({ params, call }) => {
          const repo = ghRepo(params.repo);
          const filePath = text(params.path).replace(/^\/+/, "");
          if (!repo) return { ok: false, error: GH_REPO_HINT };
          if (!filePath) return { ok: false, error: "Give the file a path inside the repo." };
          const branch = text(params.branch).trim();
          // Contents API needs the current blob sha to update an existing file.
          const existing = await call({ url: ghContentsUrl(repo, filePath, branch) });
          const sha = !Array.isArray(existing.body) ? text(existing.body?.sha) : "";
          const r = await call({
            url: `https://api.github.com/repos/${repo}/contents/${ghPath(filePath)}`,
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              message: text(params.message) || `FRIDAY: update ${filePath}`,
              content: Buffer.from(text(params.content), "utf8").toString("base64"),
              ...(sha ? { sha } : {}),
              ...(branch ? { branch } : {}),
            }),
          });
          if (!r.ok) return { ok: false, error: ghError(sha ? "update" : "create", r) };
          return {
            ok: true,
            lines: [
              `${sha ? "updated" : "created"} ${repo}/${filePath}`,
              text(r.body?.content?.html_url),
            ].filter(Boolean),
            data: r.body,
          };
        },
      },
      "create-repo": {
        label: "Create a new repository",
        risk: "exec",
        inputs: ["name", "description", "private"],
        run: async ({ params, call }) => {
          const name = text(params.name).trim();
          if (!name) return { ok: false, error: "Give the new repository a name." };
          const isPrivate = !/^(false|no|0|public)$/i.test(text(params.private || "true"));
          const r = await call({
            url: "https://api.github.com/user/repos",
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              name,
              description: text(params.description),
              private: isPrivate,
              auto_init: true,
            }),
          });
          if (!r.ok) return { ok: false, error: ghError("create the repository", r) };
          return {
            ok: true,
            lines: [`created ${text(r.body?.full_name)} · ${isPrivate ? "private" : "public"}`],
            data: r.body,
          };
        },
      },
    },
  },

  notion: {
    name: "Notion",
    category: "notes",
    authType: "apiKey",
    description: "Search and read the pages shared with your integration.",
    help: "Create an internal integration at notion.so/my-integrations and share the pages with it.",
    fields: [{ id: "token", label: "Internal integration token", secret: true }],
    auth: async (fields) => ({
      Authorization: `Bearer ${text(fields.token)}`,
      "Notion-Version": "2022-06-28",
    }),
    verify: {
      url: "https://api.notion.com/v1/users/me",
      account: (body) => body?.name || body?.bot?.owner?.type,
    },
    actions: {
      search: {
        label: "Search pages",
        risk: "safe",
        request: (_f, params) => ({
          url: "https://api.notion.com/v1/search",
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            query: text(params.query),
            page_size: clamp(params.limit, 10, 50),
          }),
        }),
        summary: (body) =>
          list(body?.results ?? [], (p) => {
            const title = Object.values(p?.properties ?? {}).find((v) => v?.type === "title");
            return `${title?.title?.[0]?.plain_text ?? p?.id} — ${p?.url ?? ""}`;
          }),
      },
    },
  },

  slack: {
    name: "Slack",
    category: "communication",
    authType: "oauth",
    description: "Read your channels and post messages.",
    help: "Paste a bot token (xoxb-…), or register a Slack app and click Connect with Slack. Callback: http://127.0.0.1:18765/oauth/callback.",
    fields: [
      { id: "token", label: "Bot user OAuth token", secret: true, optional: true },
      { id: "clientId", label: "OAuth client id", secret: false, optional: true },
      { id: "clientSecret", label: "OAuth client secret", secret: true, optional: true },
    ],
    oauth: {
      authorizeUrl: "https://slack.com/oauth/v2/authorize",
      tokenUrl: "https://slack.com/api/oauth.v2.access",
      scopes: "channels:read,channels:history,chat:write,users:read",
      pkce: false,
      clientSecret: true,
      scopeParam: "scope",
    },
    auth: async (fields) => ({
      Authorization: `Bearer ${text(fields.accessToken || fields.token)}`,
    }),
    verify: {
      url: "https://slack.com/api/auth.test",
      method: "POST",
      account: (body) => (body?.ok ? `${body.user} @ ${body.team}` : null),
      failed: (body) => (body?.ok ? null : body?.error || "Slack rejected the token."),
    },
    actions: {
      channels: {
        label: "List channels",
        risk: "safe",
        request: (_f, params) => ({
          url: `https://slack.com/api/conversations.list?limit=${clamp(params.limit, 20, 200)}&exclude_archived=true`,
        }),
        summary: (body) => list(body?.channels ?? [], (c) => `#${c.name}`),
      },
      post: {
        label: "Post a message",
        risk: "write",
        inputs: ["channel", "message"],
        request: (_f, params) => ({
          url: "https://slack.com/api/chat.postMessage",
          method: "POST",
          headers: { "content-type": "application/json; charset=utf-8" },
          body: JSON.stringify({ channel: text(params.channel), text: text(params.message) }),
        }),
        summary: (body) => (body?.ok ? [`posted to ${body.channel}`] : []),
      },
      history: {
        label: "Recent channel messages",
        risk: "safe",
        inputs: ["channel", "limit"],
        request: (_f, params) => ({
          url: `https://slack.com/api/conversations.history?channel=${encodeURIComponent(text(params.channel))}&limit=${clamp(params.limit, 20, 100)}`,
        }),
        summary: (body) =>
          list(body?.messages ?? [], (m) => `${m.user || "bot"}: ${text(m.text).slice(0, 80)}`),
      },
    },
  },

  todoist: {
    name: "Todoist",
    category: "tasks",
    authType: "apiKey",
    description: "Read and add your tasks.",
    help: "Copy the API token from Todoist → Settings → Integrations → Developer.",
    fields: [{ id: "token", label: "API token", secret: true }],
    auth: async (fields) => ({ Authorization: `Bearer ${text(fields.token)}` }),
    verify: {
      url: "https://api.todoist.com/rest/v2/projects",
      account: (body) => (Array.isArray(body) ? `${body.length} project(s)` : null),
    },
    actions: {
      tasks: {
        label: "Open tasks",
        risk: "safe",
        request: () => ({ url: "https://api.todoist.com/rest/v2/tasks" }),
        summary: (body) =>
          list(
            Array.isArray(body) ? body : [],
            (t) => `${t.content}${t.due?.string ? ` · ${t.due.string}` : ""}`,
          ),
      },
      add: {
        label: "Add a task",
        risk: "write",
        inputs: ["content", "due"],
        request: (_f, params) => ({
          url: "https://api.todoist.com/rest/v2/tasks",
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            content: text(params.content),
            ...(params.due ? { due_string: text(params.due) } : {}),
          }),
        }),
        summary: (body) => (body?.id ? [`added "${body.content}"`] : []),
      },
    },
  },

  trello: {
    name: "Trello",
    category: "tasks",
    authType: "apiKey",
    description: "Your boards and the cards on them.",
    help: "Get an API key and token at trello.com/power-ups/admin.",
    fields: [
      { id: "key", label: "API key", secret: true },
      { id: "token", label: "API token", secret: true },
    ],
    auth: async () => ({}),
    verify: {
      url: (fields) =>
        `https://api.trello.com/1/members/me?key=${text(fields.key)}&token=${text(fields.token)}`,
      account: (body) => body?.username,
    },
    actions: {
      boards: {
        label: "List boards",
        risk: "safe",
        request: (fields) => ({
          url: `https://api.trello.com/1/members/me/boards?key=${text(fields.key)}&token=${text(fields.token)}`,
        }),
        summary: (body) => list(Array.isArray(body) ? body : [], (b) => b.name),
      },
    },
  },

  linear: {
    name: "Linear",
    category: "development",
    authType: "apiKey",
    description: "Issues assigned to you.",
    help: "Create a personal API key in Linear → Settings → API.",
    fields: [{ id: "token", label: "API key", secret: true }],
    auth: async (fields) => ({
      Authorization: text(fields.token),
      "content-type": "application/json",
    }),
    verify: {
      url: "https://api.linear.app/graphql",
      method: "POST",
      body: JSON.stringify({ query: "{ viewer { name email } }" }),
      account: (body) => body?.data?.viewer?.name,
      failed: (body) => (body?.errors?.length ? body.errors[0]?.message : null),
    },
    actions: {
      issues: {
        label: "My open issues",
        risk: "safe",
        request: () => ({
          url: "https://api.linear.app/graphql",
          method: "POST",
          body: JSON.stringify({
            query:
              '{ viewer { assignedIssues(first: 20, filter: { state: { type: { neq: "completed" } } }) { nodes { identifier title state { name } } } } }',
          }),
        }),
        summary: (body) =>
          list(
            body?.data?.viewer?.assignedIssues?.nodes ?? [],
            (i) => `${i.identifier} ${i.title} · ${i.state?.name}`,
          ),
      },
    },
  },

  jira: {
    name: "Jira",
    category: "tasks",
    authType: "apiKey",
    description: "Issues assigned to you in your Jira site.",
    help: "Create an API token at id.atlassian.com/manage-profile/security/api-tokens.",
    fields: [
      { id: "site", label: "Site URL (https://you.atlassian.net)", secret: false },
      { id: "email", label: "Account email", secret: false },
      { id: "token", label: "API token", secret: true },
    ],
    auth: async (fields) => ({
      Authorization: `Basic ${Buffer.from(`${text(fields.email)}:${text(fields.token)}`).toString("base64")}`,
      Accept: "application/json",
    }),
    verify: {
      url: (fields) => `${text(fields.site).replace(/\/+$/, "")}/rest/api/3/myself`,
      account: (body) => body?.displayName,
    },
    actions: {
      issues: {
        label: "My open issues",
        risk: "safe",
        request: (fields) => ({
          url: `${text(fields.site).replace(/\/+$/, "")}/rest/api/3/search?jql=${encodeURIComponent(
            "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC",
          )}&maxResults=20`,
        }),
        summary: (body) => list(body?.issues ?? [], (i) => `${i.key} ${i.fields?.summary ?? ""}`),
      },
    },
  },

  dropbox: {
    name: "Dropbox",
    category: "storage",
    authType: "oauth",
    description: "Browse the files in your Dropbox.",
    help: "Paste an access token, or register an app and click Connect with Dropbox. Callback: http://127.0.0.1:18765/oauth/callback.",
    fields: [
      { id: "token", label: "Access token", secret: true, optional: true },
      { id: "clientId", label: "OAuth app key", secret: false, optional: true },
      { id: "clientSecret", label: "OAuth app secret", secret: true, optional: true },
    ],
    oauth: {
      authorizeUrl: "https://www.dropbox.com/oauth2/authorize",
      tokenUrl: "https://api.dropboxapi.com/oauth2/token",
      scopes: "",
      pkce: true,
      clientSecret: true,
      extraAuth: { token_access_type: "offline" },
      tokenUrlRefresh: "https://api.dropboxapi.com/oauth2/token",
    },
    auth: async (fields, fetchImpl) => {
      const token = text(fields.refreshToken)
        ? await oauthAccessToken(
            "dropbox",
            fields,
            fetchImpl,
            "https://api.dropboxapi.com/oauth2/token",
          )
        : text(fields.accessToken || fields.token);
      return { Authorization: `Bearer ${token}` };
    },
    verify: {
      url: "https://api.dropboxapi.com/2/users/get_current_account",
      method: "POST",
      account: (body) => body?.name?.display_name,
    },
    actions: {
      files: {
        label: "List a folder",
        risk: "safe",
        inputs: ["folder"],
        request: (_f, params) => ({
          url: "https://api.dropboxapi.com/2/files/list_folder",
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: params.folder ? text(params.folder) : "", limit: 50 }),
        }),
        summary: (body) => list(body?.entries ?? [], (e) => `${e[".tag"]} · ${e.path_display}`),
      },
    },
  },

  "google-calendar": {
    name: "Google Calendar",
    category: "calendar",
    authType: "oauth",
    description: "Read what is on your calendar.",
    help: "Register an OAuth client with calendar.readonly, add http://127.0.0.1:18765/oauth/callback, then Connect with Google — or paste a refresh token.",
    fields: [
      { id: "clientId", label: "OAuth client id", secret: false, optional: true },
      { id: "clientSecret", label: "OAuth client secret", secret: true, optional: true },
      { id: "refreshToken", label: "Refresh token", secret: true, optional: true },
    ],
    oauth: {
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      scopes:
        "https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/userinfo.email",
      pkce: true,
      clientSecret: true,
      extraAuth: { access_type: "offline", prompt: "consent", include_granted_scopes: "true" },
    },
    auth: googleAuth("google-calendar"),
    verify: {
      url: "https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=1",
      account: (body) => body?.items?.[0]?.summary || "calendar",
    },
    actions: {
      today: {
        label: "Today's events",
        risk: "safe",
        request: () => {
          const from = new Date();
          from.setHours(0, 0, 0, 0);
          const to = new Date(from.getTime() + 24 * 60 * 60 * 1000);
          return {
            url:
              "https://www.googleapis.com/calendar/v3/calendars/primary/events" +
              `?singleEvents=true&orderBy=startTime&timeMin=${from.toISOString()}&timeMax=${to.toISOString()}`,
          };
        },
        summary: (body) =>
          list(body?.items ?? [], (e) => {
            const when = e.start?.dateTime || e.start?.date || "";
            return `${when} — ${e.summary ?? "(no title)"}`;
          }),
      },
      upcoming: {
        label: "Next events",
        risk: "safe",
        request: (_f, params) => ({
          url:
            "https://www.googleapis.com/calendar/v3/calendars/primary/events" +
            `?singleEvents=true&orderBy=startTime&timeMin=${new Date().toISOString()}&maxResults=${clamp(params.limit, 10, 50)}`,
        }),
        summary: (body) =>
          list(
            body?.items ?? [],
            (e) => `${e.start?.dateTime || e.start?.date || ""} — ${e.summary ?? ""}`,
          ),
      },
    },
  },

  "google-drive": {
    name: "Google Drive",
    category: "storage",
    authType: "oauth",
    description: "Find your most recent Drive files.",
    help: "Register an OAuth client with drive.readonly, add http://127.0.0.1:18765/oauth/callback, then Connect with Google — or paste a refresh token.",
    fields: [
      { id: "clientId", label: "OAuth client id", secret: false, optional: true },
      { id: "clientSecret", label: "OAuth client secret", secret: true, optional: true },
      { id: "refreshToken", label: "Refresh token", secret: true, optional: true },
    ],
    oauth: {
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      scopes:
        "https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/userinfo.email",
      pkce: true,
      clientSecret: true,
      extraAuth: { access_type: "offline", prompt: "consent", include_granted_scopes: "true" },
    },
    auth: googleAuth("google-drive"),
    verify: {
      url: "https://www.googleapis.com/drive/v3/about?fields=user",
      account: (body) => body?.user?.emailAddress,
    },
    actions: {
      recent: {
        label: "Recent files",
        risk: "safe",
        request: (_f, params) => ({
          url: `https://www.googleapis.com/drive/v3/files?orderBy=modifiedTime desc&pageSize=${clamp(
            params.limit,
            10,
            50,
          )}&fields=files(name,mimeType,modifiedTime,webViewLink)`,
        }),
        summary: (body) => list(body?.files ?? [], (f) => `${f.name} · ${f.modifiedTime}`),
      },
    },
  },

  "google-gmail": {
    name: "Gmail",
    category: "mail",
    authType: "oauth",
    description: "Search, read and send mail in your Gmail account.",
    help: "Register an OAuth client with gmail.readonly and gmail.send, add http://127.0.0.1:18765/oauth/callback, then Connect with Google.",
    fields: [
      { id: "clientId", label: "OAuth client id", secret: false, optional: true },
      { id: "clientSecret", label: "OAuth client secret", secret: true, optional: true },
      { id: "refreshToken", label: "Refresh token", secret: true, optional: true },
    ],
    oauth: {
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      scopes:
        "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/userinfo.email",
      pkce: true,
      clientSecret: true,
      extraAuth: { access_type: "offline", prompt: "consent", include_granted_scopes: "true" },
    },
    auth: googleAuth("google-gmail"),
    verify: {
      url: "https://gmail.googleapis.com/gmail/v1/users/me/profile",
      account: (body) => body?.emailAddress,
    },
    actions: {
      search: {
        label: "Search messages",
        risk: "safe",
        inputs: ["query"],
        run: async ({ params, call }) => {
          const q = text(params.query).trim();
          const r = await call({
            url: `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=10${
              q ? `&q=${encodeURIComponent(q)}` : ""
            }`,
          });
          if (!r.ok) return { ok: false, error: `Gmail search failed (${r.status}).` };
          const ids = (r.body?.messages || [])
            .map((m) => m.id)
            .filter(Boolean)
            .slice(0, 8);
          const lines = [];
          for (const id of ids) {
            const one = await call({
              url: `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`,
            });
            if (!one.ok) continue;
            const headers = one.body?.payload?.headers || [];
            const subject = headers.find((h) => /subject/i.test(h.name))?.value || "(no subject)";
            const from = headers.find((h) => /from/i.test(h.name))?.value || "";
            lines.push(`${from} — ${subject}`);
          }
          return { ok: true, lines: lines.length ? lines : ["(no messages)"], data: r.body };
        },
      },
      read: {
        label: "Read a message",
        risk: "safe",
        inputs: ["id"],
        request: (_f, params) => ({
          url: `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(text(params.id))}?format=full`,
        }),
        summary: (body) => {
          const headers = body?.payload?.headers || [];
          const subject = headers.find((h) => /subject/i.test(h.name))?.value || "";
          const snippet = text(body?.snippet).slice(0, 240);
          return [subject, snippet].filter(Boolean);
        },
      },
      send: {
        label: "Send an email",
        risk: "write",
        inputs: ["to", "subject", "body"],
        run: async ({ params, call }) => {
          const to = text(params.to).trim();
          if (!to) return { ok: false, error: "Give a To address." };
          const mime = `To: ${to}\r\nSubject: ${text(params.subject) || "(no subject)"}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${text(params.body)}`;
          const raw = Buffer.from(mime, "utf8")
            .toString("base64")
            .replace(/\+/g, "-")
            .replace(/\//g, "_")
            .replace(/=+$/g, "");
          const r = await call({
            url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ raw }),
          });
          if (!r.ok) return { ok: false, error: `Gmail send failed (${r.status}).` };
          return { ok: true, lines: [`sent to ${to}`], data: r.body };
        },
      },
    },
  },

  discord: {
    name: "Discord",
    category: "communication",
    authType: "apiKey",
    description: "Your Discord bot — guilds and channel messages.",
    help: "Create a bot at discord.com/developers/applications and paste the bot token.",
    fields: [{ id: "token", label: "Bot token", secret: true }],
    auth: async (fields) => ({ Authorization: `Bot ${text(fields.token)}` }),
    verify: {
      url: "https://discord.com/api/v10/users/@me",
      account: (body) => body?.username,
    },
    actions: {
      guilds: {
        label: "List servers",
        risk: "safe",
        request: () => ({ url: "https://discord.com/api/v10/users/@me/guilds" }),
        summary: (body) => list(Array.isArray(body) ? body : [], (g) => g.name),
      },
      post: {
        label: "Post to a channel",
        risk: "write",
        inputs: ["channel", "message"],
        request: (_f, params) => ({
          url: `https://discord.com/api/v10/channels/${encodeURIComponent(text(params.channel))}/messages`,
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ content: text(params.message) }),
        }),
        summary: (body) => (body?.id ? [`posted ${body.id}`] : []),
      },
    },
  },

  telegram: {
    name: "Telegram",
    category: "communication",
    authType: "apiKey",
    description: "Your Telegram bot — identity and send.",
    help: "Create a bot with BotFather and paste the token. Bots cannot start a chat; the user must message first.",
    fields: [{ id: "token", label: "Bot token", secret: true }],
    auth: async () => ({}),
    verify: {
      url: (fields) => `https://api.telegram.org/bot${text(fields.token)}/getMe`,
      account: (body) => (body?.ok ? body.result?.username : null),
      failed: (body) => (body?.ok ? null : body?.description || "Telegram rejected the token."),
    },
    actions: {
      me: {
        label: "Bot identity",
        risk: "safe",
        request: (fields) => ({ url: `https://api.telegram.org/bot${text(fields.token)}/getMe` }),
        summary: (body) => (body?.ok ? [`@${body.result?.username}`] : []),
      },
      send: {
        label: "Send a message",
        risk: "write",
        inputs: ["chat_id", "message"],
        request: (fields, params) => ({
          url: `https://api.telegram.org/bot${text(fields.token)}/sendMessage`,
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: text(params.chat_id), text: text(params.message) }),
        }),
        summary: (body) => (body?.ok ? [`sent to ${body.result?.chat?.id}`] : []),
      },
    },
  },

  onedrive: {
    name: "OneDrive",
    category: "storage",
    authType: "oauth",
    description: "Files in your Microsoft OneDrive.",
    help: "Register a Microsoft Entra app with Files.Read and User.Read, redirect http://127.0.0.1:18765/oauth/callback, then Connect with Microsoft.",
    fields: [
      { id: "clientId", label: "Application (client) id", secret: false, optional: true },
      { id: "clientSecret", label: "Client secret", secret: true, optional: true },
    ],
    oauth: {
      authorizeUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
      tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
      scopes: "offline_access User.Read Files.Read",
      pkce: true,
      clientSecret: false,
      extraAuth: { response_mode: "query" },
    },
    auth: bearerFrom("onedrive", "https://login.microsoftonline.com/common/oauth2/v2.0/token"),
    verify: {
      url: "https://graph.microsoft.com/v1.0/me",
      account: (body) => body?.userPrincipalName || body?.displayName,
    },
    actions: {
      recent: {
        label: "Recent files",
        risk: "safe",
        request: () => ({
          url: "https://graph.microsoft.com/v1.0/me/drive/recent?$top=20",
        }),
        summary: (body) => list(body?.value ?? [], (f) => f.name),
      },
    },
  },

  "microsoft-teams": {
    name: "Microsoft Teams",
    category: "communication",
    authType: "oauth",
    description: "Read chats and send a Teams chat message.",
    help: "Register a Microsoft Entra app with Chat.Read and ChatMessage.Send. Work accounts may need admin consent. Callback: http://127.0.0.1:18765/oauth/callback.",
    fields: [
      { id: "clientId", label: "Application (client) id", secret: false, optional: true },
      { id: "clientSecret", label: "Client secret", secret: true, optional: true },
    ],
    oauth: {
      authorizeUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
      tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
      scopes: "offline_access User.Read Chat.Read ChatMessage.Send",
      pkce: true,
      clientSecret: false,
    },
    auth: bearerFrom(
      "microsoft-teams",
      "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    ),
    verify: {
      url: "https://graph.microsoft.com/v1.0/me",
      account: (body) => body?.userPrincipalName || body?.displayName,
    },
    actions: {
      chats: {
        label: "List chats",
        risk: "safe",
        request: () => ({ url: "https://graph.microsoft.com/v1.0/me/chats?$top=20" }),
        summary: (body) => list(body?.value ?? [], (c) => c.topic || c.id),
      },
      post: {
        label: "Send a chat message",
        risk: "write",
        inputs: ["chat", "message"],
        request: (_f, params) => ({
          url: `https://graph.microsoft.com/v1.0/chats/${encodeURIComponent(text(params.chat))}/messages`,
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ body: { content: text(params.message) } }),
        }),
        summary: (body) => (body?.id ? [`sent ${body.id}`] : []),
      },
    },
  },

  zoom: {
    name: "Zoom",
    category: "communication",
    authType: "oauth",
    description: "Your Zoom user and upcoming meetings.",
    help: "Create an OAuth app at marketplace.zoom.us with user:read:user and meeting:read:list_meetings. Callback: http://127.0.0.1:18765/oauth/callback.",
    fields: [
      { id: "clientId", label: "OAuth client id", secret: false, optional: true },
      { id: "clientSecret", label: "OAuth client secret", secret: true, optional: true },
    ],
    oauth: {
      authorizeUrl: "https://zoom.us/oauth/authorize",
      tokenUrl: "https://zoom.us/oauth/token",
      scopes: "",
      pkce: true,
      clientSecret: true,
      tokenBasic: true,
    },
    auth: bearerFrom("zoom", "https://zoom.us/oauth/token"),
    verify: {
      url: "https://api.zoom.us/v2/users/me",
      account: (body) => body?.email || body?.display_name,
    },
    actions: {
      meetings: {
        label: "Upcoming meetings",
        risk: "safe",
        request: () => ({
          url: "https://api.zoom.us/v2/users/me/meetings?type=upcoming&page_size=20",
        }),
        summary: (body) =>
          list(body?.meetings ?? [], (m) => `${m.start_time || ""} — ${m.topic || ""}`),
      },
    },
  },

  asana: {
    name: "Asana",
    category: "tasks",
    authType: "apiKey",
    description: "Workspaces and tasks assigned to you.",
    help: "Create a personal access token in Asana → Settings → Apps.",
    fields: [{ id: "token", label: "Personal access token", secret: true }],
    auth: async (fields) => ({ Authorization: `Bearer ${text(fields.token)}` }),
    verify: {
      url: "https://app.asana.com/api/1.0/users/me",
      account: (body) => body?.data?.name || body?.data?.email,
    },
    actions: {
      workspaces: {
        label: "List workspaces",
        risk: "safe",
        request: () => ({ url: "https://app.asana.com/api/1.0/workspaces" }),
        summary: (body) => list(body?.data ?? [], (w) => w.name),
      },
    },
  },

  airtable: {
    name: "Airtable",
    category: "notes",
    authType: "apiKey",
    description: "Bases your personal access token can see.",
    help: "Create a PAT at airtable.com/create/tokens with schema.bases:read.",
    fields: [{ id: "token", label: "Personal access token", secret: true }],
    auth: async (fields) => ({ Authorization: `Bearer ${text(fields.token)}` }),
    verify: {
      url: "https://api.airtable.com/v0/meta/whoami",
      account: (body) => body?.id || body?.email,
    },
    actions: {
      bases: {
        label: "List bases",
        risk: "safe",
        request: () => ({ url: "https://api.airtable.com/v0/meta/bases" }),
        summary: (body) => list(body?.bases ?? [], (b) => b.name),
      },
    },
  },

  twilio: {
    name: "Twilio",
    category: "communication",
    authType: "phone",
    description: "Verify a phone number with a real SMS code, then send SMS.",
    help: "Account SID + Auth Token from console.twilio.com, plus a Verify Service SID (VA…). Connected only after the SMS code is approved — never simulated.",
    fields: [
      { id: "accountSid", label: "Account SID", secret: false },
      { id: "authToken", label: "Auth token", secret: true },
      { id: "verifyServiceSid", label: "Verify Service SID", secret: false },
      { id: "phone", label: "Phone (E.164, +91…)", secret: false, optional: true },
    ],
    auth: async (fields) => ({
      Authorization: `Basic ${Buffer.from(`${text(fields.accountSid)}:${text(fields.authToken)}`).toString("base64")}`,
      Accept: "application/json",
    }),
    verify: {
      url: (fields) => `https://api.twilio.com/2010-04-01/Accounts/${text(fields.accountSid)}.json`,
      account: (body) => body?.friendly_name || body?.sid,
    },
    actions: {
      send: {
        label: "Send an SMS",
        risk: "write",
        inputs: ["from", "to", "message"],
        request: (fields, params) => ({
          url: `https://api.twilio.com/2010-04-01/Accounts/${text(fields.accountSid)}/Messages.json`,
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            From: text(params.from),
            To: text(params.to || fields.phone),
            Body: text(params.message),
          }).toString(),
        }),
        summary: (body) => (body?.sid ? [`sent ${body.sid} (${body.status})`] : []),
      },
    },
  },

  sendgrid: {
    name: "SendGrid",
    category: "mail",
    authType: "apiKey",
    description: "Your SendGrid account and outbound mail.",
    help: "Create an API key at app.sendgrid.com/settings/api_keys.",
    fields: [{ id: "token", label: "API key", secret: true }],
    auth: async (fields) => ({ Authorization: `Bearer ${text(fields.token)}` }),
    verify: {
      url: "https://api.sendgrid.com/v3/user/profile",
      account: (body) =>
        body?.email || [body?.first_name, body?.last_name].filter(Boolean).join(" "),
    },
    actions: {
      send: {
        label: "Send an email",
        risk: "write",
        inputs: ["from", "to", "subject", "body"],
        request: (_f, params) => ({
          url: "https://api.sendgrid.com/v3/mail/send",
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            personalizations: [{ to: [{ email: text(params.to) }] }],
            from: { email: text(params.from) },
            subject: text(params.subject) || "(no subject)",
            content: [{ type: "text/plain", value: text(params.body) }],
          }),
        }),
        summary: () => ["accepted by SendGrid"],
      },
    },
  },

  figma: {
    name: "Figma",
    category: "notes",
    authType: "apiKey",
    description: "Your Figma identity and a file you name.",
    help: "Create a personal access token in Figma → Settings → Security.",
    fields: [{ id: "token", label: "Personal access token", secret: true }],
    auth: async (fields) => ({ "X-Figma-Token": text(fields.token) }),
    verify: {
      url: "https://api.figma.com/v1/me",
      account: (body) => body?.handle || body?.email,
    },
    actions: {
      file: {
        label: "Read a file",
        risk: "safe",
        inputs: ["key"],
        request: (_f, params) => ({
          url: `https://api.figma.com/v1/files/${encodeURIComponent(text(params.key))}`,
        }),
        summary: (body) => [`${body?.name || ""} · ${body?.lastModified || ""}`],
      },
    },
  },

  calendly: {
    name: "Calendly",
    category: "calendar",
    authType: "apiKey",
    description: "Your Calendly user and scheduled events.",
    help: "Create a personal access token in Calendly → Integrations → API & webhooks.",
    fields: [{ id: "token", label: "Personal access token", secret: true }],
    auth: async (fields) => ({ Authorization: `Bearer ${text(fields.token)}` }),
    verify: {
      url: "https://api.calendly.com/users/me",
      account: (body) => body?.resource?.email || body?.resource?.name,
    },
    actions: {
      events: {
        label: "Scheduled events",
        risk: "safe",
        run: async ({ call }) => {
          const me = await call({ url: "https://api.calendly.com/users/me" });
          if (!me.ok) return { ok: false, error: `Calendly user lookup failed (${me.status}).` };
          const uri = text(me.body?.resource?.uri);
          if (!uri) return { ok: false, error: "Calendly did not return a user URI." };
          const r = await call({
            url: `https://api.calendly.com/scheduled_events?user=${encodeURIComponent(uri)}&count=20`,
          });
          if (!r.ok) return { ok: false, error: `Calendly events failed (${r.status}).` };
          const lines = (r.body?.collection || []).map(
            (e) => `${e.start_time || ""} — ${e.name || e.status || ""}`,
          );
          return { ok: true, lines, data: r.body };
        },
      },
    },
  },

  whatsapp: {
    name: "WhatsApp Cloud",
    category: "communication",
    authType: "apiKey",
    description: "WhatsApp Cloud API — send from a Meta-verified business number.",
    help: "Needs a Meta Cloud API token and Phone number ID. This is not SMS login; Connected stays off until Graph accepts the token.",
    fields: [
      { id: "token", label: "Access token", secret: true },
      { id: "phoneNumberId", label: "Phone number ID", secret: false },
    ],
    auth: async (fields) => ({ Authorization: `Bearer ${text(fields.token)}` }),
    verify: {
      url: (fields) =>
        `https://graph.facebook.com/v21.0/${text(fields.phoneNumberId)}?fields=display_phone_number,verified_name`,
      account: (body) => body?.display_phone_number || body?.verified_name,
    },
    actions: {
      send: {
        label: "Send a text message",
        risk: "write",
        inputs: ["to", "message"],
        request: (fields, params) => ({
          url: `https://graph.facebook.com/v21.0/${text(fields.phoneNumberId)}/messages`,
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            messaging_product: "whatsapp",
            to: text(params.to).replace(/^\+/, ""),
            type: "text",
            text: { body: text(params.message) },
          }),
        }),
        summary: (body) => (body?.messages?.[0]?.id ? [`sent ${body.messages[0].id}`] : []),
      },
    },
  },

  gitlab: {
    name: "GitLab",
    category: "development",
    authType: "apiKey",
    description: "Your GitLab user and projects (gitlab.com or a self-hosted site).",
    help: "Create a personal access token with read_api. Optional site URL defaults to https://gitlab.com.",
    fields: [
      { id: "token", label: "Personal access token", secret: true },
      { id: "site", label: "Site URL (optional)", secret: false, optional: true },
    ],
    auth: async (fields) => ({ Authorization: `Bearer ${text(fields.token)}` }),
    verify: {
      url: (fields) =>
        `${text(fields.site || "https://gitlab.com").replace(/\/+$/, "")}/api/v4/user`,
      account: (body) => body?.username,
    },
    actions: {
      projects: {
        label: "My projects",
        risk: "safe",
        request: (fields, params) => ({
          url: `${text(fields.site || "https://gitlab.com").replace(/\/+$/, "")}/api/v4/projects?membership=true&simple=true&per_page=${clamp(params.limit, 10, 50)}`,
        }),
        summary: (body) =>
          list(Array.isArray(body) ? body : [], (p) => p.path_with_namespace || p.name),
      },
    },
  },

  bitbucket: {
    name: "Bitbucket",
    category: "development",
    authType: "apiKey",
    description: "Your Bitbucket Cloud user and repositories.",
    help: "Atlassian account email plus an app password with Repositories:Read.",
    fields: [
      { id: "email", label: "Atlassian email", secret: false },
      { id: "token", label: "App password", secret: true },
    ],
    auth: async (fields) => ({
      Authorization: `Basic ${Buffer.from(`${text(fields.email)}:${text(fields.token)}`).toString("base64")}`,
    }),
    verify: {
      url: "https://api.bitbucket.org/2.0/user",
      account: (body) => body?.username || body?.display_name,
    },
    actions: {
      repos: {
        label: "List repositories",
        risk: "safe",
        request: () => ({
          url: "https://api.bitbucket.org/2.0/repositories?role=member&pagelen=20",
        }),
        summary: (body) => list(body?.values ?? [], (r) => r.full_name),
      },
    },
  },

  confluence: {
    name: "Confluence",
    category: "notes",
    authType: "apiKey",
    description: "Search pages on your Confluence Cloud site.",
    help: "Same Atlassian API token as Jira, plus your site URL (https://you.atlassian.net).",
    fields: [
      { id: "site", label: "Site URL (https://you.atlassian.net)", secret: false },
      { id: "email", label: "Account email", secret: false },
      { id: "token", label: "API token", secret: true },
    ],
    auth: async (fields) => ({
      Authorization: `Basic ${Buffer.from(`${text(fields.email)}:${text(fields.token)}`).toString("base64")}`,
      Accept: "application/json",
    }),
    verify: {
      url: (fields) => `${text(fields.site).replace(/\/+$/, "")}/wiki/rest/api/space?limit=1`,
      account: (body) =>
        Array.isArray(body?.results) ? `${body.results.length} space(s)` : body?.size,
    },
    actions: {
      search: {
        label: "Search pages",
        risk: "safe",
        inputs: ["query"],
        request: (fields, params) => ({
          url: `${text(fields.site).replace(/\/+$/, "")}/wiki/rest/api/content/search?cql=${encodeURIComponent(
            `text ~ "${text(params.query).replace(/"/g, "")}" AND type = page`,
          )}&limit=10`,
        }),
        summary: (body) => list(body?.results ?? [], (p) => p.title),
      },
    },
  },

  gitea: {
    name: "Gitea / Forgejo",
    category: "development",
    authType: "apiKey",
    description: "A Gitea, Forgejo or Codeberg instance — your user and repos.",
    help: "Instance URL (https://codeberg.org) plus a token with read:user and read:repository.",
    fields: [
      { id: "site", label: "Instance URL", secret: false },
      { id: "token", label: "Access token", secret: true },
    ],
    auth: async (fields) => ({ Authorization: `token ${text(fields.token)}` }),
    verify: {
      url: (fields) => `${text(fields.site).replace(/\/+$/, "")}/api/v1/user`,
      account: (body) => body?.login || body?.username,
    },
    actions: {
      repos: {
        label: "My repositories",
        risk: "safe",
        request: (fields) => ({
          url: `${text(fields.site).replace(/\/+$/, "")}/api/v1/user/repos?limit=20`,
        }),
        summary: (body) => list(Array.isArray(body) ? body : [], (r) => r.full_name),
      },
    },
  },

  hubspot: {
    name: "HubSpot",
    category: "tasks",
    authType: "apiKey",
    description: "Your HubSpot private app — account and recent contacts.",
    help: "Create a private app at app.hubspot.com with crm.objects.contacts.read.",
    fields: [{ id: "token", label: "Private app token", secret: true }],
    auth: async (fields) => ({ Authorization: `Bearer ${text(fields.token)}` }),
    verify: {
      url: "https://api.hubapi.com/integrations/v1/me",
      account: (body) => body?.user || body?.hub_id,
    },
    actions: {
      contacts: {
        label: "Recent contacts",
        risk: "safe",
        request: () => ({
          url: "https://api.hubapi.com/crm/v3/objects/contacts?limit=10&properties=email,firstname,lastname",
        }),
        summary: (body) =>
          list(body?.results ?? [], (c) =>
            [c.properties?.firstname, c.properties?.lastname, c.properties?.email]
              .filter(Boolean)
              .join(" "),
          ),
      },
    },
  },

  stripe: {
    name: "Stripe",
    category: "tasks",
    authType: "apiKey",
    description: "Your Stripe account balance (read-only).",
    help: "Restricted key with ras_balance_read from dashboard.stripe.com/apikeys. Write charges are not exposed.",
    fields: [{ id: "token", label: "Secret / restricted key", secret: true }],
    auth: async (fields) => ({ Authorization: `Bearer ${text(fields.token)}` }),
    verify: {
      url: "https://api.stripe.com/v1/balance",
      account: (body) =>
        Array.isArray(body?.available)
          ? body.available
              .map((b) => `${(Number(b.amount || 0) / 100).toFixed(2)} ${b.currency}`)
              .join(", ")
          : "stripe",
    },
    actions: {
      balance: {
        label: "Account balance",
        risk: "safe",
        request: () => ({ url: "https://api.stripe.com/v1/balance" }),
        summary: (body) =>
          list(
            body?.available ?? [],
            (b) => `available ${(Number(b.amount || 0) / 100).toFixed(2)} ${b.currency}`,
          ),
      },
    },
  },

  clickup: {
    name: "ClickUp",
    category: "tasks",
    authType: "apiKey",
    description: "Your ClickUp user and workspaces.",
    help: "Personal token from ClickUp → Settings → Apps. Sent as Authorization without Bearer.",
    fields: [{ id: "token", label: "API token", secret: true }],
    auth: async (fields) => ({ Authorization: text(fields.token) }),
    verify: {
      url: "https://api.clickup.com/api/v2/user",
      account: (body) => body?.user?.username || body?.user?.email,
    },
    actions: {
      teams: {
        label: "Workspaces",
        risk: "safe",
        request: () => ({ url: "https://api.clickup.com/api/v2/team" }),
        summary: (body) => list(body?.teams ?? [], (t) => t.name),
      },
    },
  },

  monday: {
    name: "Monday.com",
    category: "tasks",
    authType: "apiKey",
    description: "Your Monday.com user and boards.",
    help: "Personal API token from Monday → Developers → My access tokens.",
    fields: [{ id: "token", label: "API token", secret: true }],
    auth: async (fields) => ({
      Authorization: text(fields.token),
      "content-type": "application/json",
    }),
    verify: {
      url: "https://api.monday.com/v2",
      method: "POST",
      body: JSON.stringify({ query: "{ me { name email } }" }),
      account: (body) => body?.data?.me?.name,
      failed: (body) => (body?.errors?.length ? body.errors[0]?.message : null),
    },
    actions: {
      boards: {
        label: "List boards",
        risk: "safe",
        request: () => ({
          url: "https://api.monday.com/v2",
          method: "POST",
          body: JSON.stringify({ query: "{ boards (limit: 20) { id name } }" }),
        }),
        summary: (body) => list(body?.data?.boards ?? [], (b) => b.name),
      },
    },
  },

  pagerduty: {
    name: "PagerDuty",
    category: "communication",
    authType: "apiKey",
    description: "Your PagerDuty user and open incidents.",
    help: "User API token from PagerDuty → Integrations → API Access Keys.",
    fields: [{ id: "token", label: "API token", secret: true }],
    auth: async (fields) => ({
      Authorization: `Token token=${text(fields.token)}`,
      Accept: "application/vnd.pagerduty+json;version=2",
    }),
    verify: {
      url: "https://api.pagerduty.com/users/me",
      account: (body) => body?.user?.email || body?.user?.name,
    },
    actions: {
      incidents: {
        label: "Open incidents",
        risk: "safe",
        request: () => ({
          url: "https://api.pagerduty.com/incidents?statuses[]=triggered&statuses[]=acknowledged&limit=20",
        }),
        summary: (body) =>
          list(body?.incidents ?? [], (i) => `${i.incident_number} ${i.title || i.summary || ""}`),
      },
    },
  },

  vercel: {
    name: "Vercel",
    category: "development",
    authType: "apiKey",
    description: "Your Vercel user and projects.",
    help: "Create a token at vercel.com/account/tokens.",
    fields: [{ id: "token", label: "Access token", secret: true }],
    auth: async (fields) => ({ Authorization: `Bearer ${text(fields.token)}` }),
    verify: {
      url: "https://api.vercel.com/v2/user",
      account: (body) => body?.user?.username || body?.user?.email,
    },
    actions: {
      projects: {
        label: "List projects",
        risk: "safe",
        request: () => ({ url: "https://api.vercel.com/v9/projects?limit=20" }),
        summary: (body) => list(body?.projects ?? [], (p) => p.name),
      },
    },
  },

  cloudflare: {
    name: "Cloudflare",
    category: "development",
    authType: "apiKey",
    description: "Your Cloudflare user and zones.",
    help: "API token from dash.cloudflare.com with Zone:Read.",
    fields: [{ id: "token", label: "API token", secret: true }],
    auth: async (fields) => ({ Authorization: `Bearer ${text(fields.token)}` }),
    verify: {
      url: "https://api.cloudflare.com/client/v4/user",
      account: (body) => body?.result?.email,
      failed: (body) =>
        body?.success === false
          ? body?.errors?.[0]?.message || "Cloudflare rejected the token."
          : null,
    },
    actions: {
      zones: {
        label: "List zones",
        risk: "safe",
        request: () => ({ url: "https://api.cloudflare.com/client/v4/zones?per_page=20" }),
        summary: (body) => list(body?.result ?? [], (z) => z.name),
      },
    },
  },

  huggingface: {
    name: "Hugging Face",
    category: "development",
    authType: "apiKey",
    description: "Your Hugging Face identity and models you own.",
    help: "Fine-grained or classic token from huggingface.co/settings/tokens with read access.",
    fields: [{ id: "token", label: "Access token", secret: true }],
    auth: async (fields) => ({ Authorization: `Bearer ${text(fields.token)}` }),
    verify: {
      url: "https://huggingface.co/api/whoami-v2",
      account: (body) => body?.name || body?.email,
    },
    actions: {
      models: {
        label: "My models",
        risk: "safe",
        run: async ({ call, fields }) => {
          const me = await call({ url: "https://huggingface.co/api/whoami-v2" });
          if (!me.ok) return { ok: false, error: `Hugging Face whoami failed (${me.status}).` };
          const name = text(me.body?.name);
          const r = await call({
            url: `https://huggingface.co/api/models?author=${encodeURIComponent(name)}&limit=20`,
          });
          if (!r.ok) return { ok: false, error: `Hugging Face models failed (${r.status}).` };
          const rows = Array.isArray(r.body) ? r.body : [];
          return { ok: true, lines: rows.map((m) => m.modelId || m.id || m.name), data: r.body };
        },
      },
    },
  },

  digitalocean: {
    name: "DigitalOcean",
    category: "development",
    authType: "apiKey",
    description: "Your DigitalOcean account and droplets.",
    help: "Personal access token from cloud.digitalocean.com/account/api/tokens.",
    fields: [{ id: "token", label: "Personal access token", secret: true }],
    auth: async (fields) => ({ Authorization: `Bearer ${text(fields.token)}` }),
    verify: {
      url: "https://api.digitalocean.com/v2/account",
      account: (body) => body?.account?.email,
    },
    actions: {
      droplets: {
        label: "List droplets",
        risk: "safe",
        request: () => ({ url: "https://api.digitalocean.com/v2/droplets?per_page=20" }),
        summary: (body) => list(body?.droplets ?? [], (d) => `${d.name} · ${d.status}`),
      },
    },
  },

  netlify: {
    name: "Netlify",
    category: "development",
    authType: "apiKey",
    description: "Your Netlify user and sites.",
    help: "Personal access token from app.netlify.com/user/applications.",
    fields: [{ id: "token", label: "Access token", secret: true }],
    auth: async (fields) => ({ Authorization: `Bearer ${text(fields.token)}` }),
    verify: {
      url: "https://api.netlify.com/api/v1/user",
      account: (body) => body?.full_name || body?.email,
    },
    actions: {
      sites: {
        label: "List sites",
        risk: "safe",
        request: () => ({ url: "https://api.netlify.com/api/v1/sites?per_page=20" }),
        summary: (body) => list(Array.isArray(body) ? body : [], (s) => s.name || s.url),
      },
    },
  },

  heroku: {
    name: "Heroku",
    category: "development",
    authType: "apiKey",
    description: "Your Heroku account and apps.",
    help: "API key from dashboard.heroku.com/account.",
    fields: [{ id: "token", label: "API key", secret: true }],
    auth: async (fields) => ({
      Authorization: `Bearer ${text(fields.token)}`,
      Accept: "application/vnd.heroku+json; version=3",
    }),
    verify: {
      url: "https://api.heroku.com/account",
      account: (body) => body?.email,
    },
    actions: {
      apps: {
        label: "List apps",
        risk: "safe",
        request: () => ({ url: "https://api.heroku.com/apps" }),
        summary: (body) => list(Array.isArray(body) ? body : [], (a) => a.name),
      },
    },
  },

  sentry: {
    name: "Sentry",
    category: "development",
    authType: "apiKey",
    description: "Your Sentry organizations.",
    help: "Auth token from sentry.io/settings/account/api/auth-tokens/ with org:read.",
    fields: [{ id: "token", label: "Auth token", secret: true }],
    auth: async (fields) => ({ Authorization: `Bearer ${text(fields.token)}` }),
    verify: {
      url: "https://sentry.io/api/0/organizations/",
      account: (body) => (Array.isArray(body) ? body[0]?.slug || `${body.length} org(s)` : null),
    },
    actions: {
      orgs: {
        label: "List organizations",
        risk: "safe",
        request: () => ({ url: "https://sentry.io/api/0/organizations/" }),
        summary: (body) => list(Array.isArray(body) ? body : [], (o) => o.slug || o.name),
      },
    },
  },

  npm: {
    name: "npm",
    category: "development",
    authType: "apiKey",
    description: "Your npmjs.com identity.",
    help: "Granular access token from npmjs.com/settings/~/tokens with read-only.",
    fields: [{ id: "token", label: "Access token", secret: true }],
    auth: async (fields) => ({ Authorization: `Bearer ${text(fields.token)}` }),
    verify: {
      url: "https://registry.npmjs.org/-/whoami",
      account: (body) => (typeof body === "string" ? body : body?.username),
    },
    actions: {
      whoami: {
        label: "Who am I",
        risk: "safe",
        request: () => ({ url: "https://registry.npmjs.org/-/whoami" }),
        summary: (body) => [typeof body === "string" ? body : body?.username || ""],
      },
    },
  },

  resend: {
    name: "Resend",
    category: "mail",
    authType: "apiKey",
    description: "Your Resend domains and outbound mail.",
    help: "API key from resend.com/api-keys.",
    fields: [{ id: "token", label: "API key", secret: true }],
    auth: async (fields) => ({ Authorization: `Bearer ${text(fields.token)}` }),
    verify: {
      url: "https://api.resend.com/domains",
      account: (body) => `${(body?.data || []).length} domain(s)`,
    },
    actions: {
      domains: {
        label: "List domains",
        risk: "safe",
        request: () => ({ url: "https://api.resend.com/domains" }),
        summary: (body) => list(body?.data ?? [], (d) => `${d.name} · ${d.status}`),
      },
      send: {
        label: "Send an email",
        risk: "write",
        inputs: ["from", "to", "subject", "body"],
        request: (_f, params) => ({
          url: "https://api.resend.com/emails",
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            from: text(params.from),
            to: [text(params.to)],
            subject: text(params.subject) || "(no subject)",
            text: text(params.body),
          }),
        }),
        summary: (body) => (body?.id ? [`sent ${body.id}`] : []),
      },
    },
  },

  postmark: {
    name: "Postmark",
    category: "mail",
    authType: "apiKey",
    description: "Your Postmark server.",
    help: "Server API token from account.postmarkapp.com.",
    fields: [{ id: "token", label: "Server API token", secret: true }],
    auth: async (fields) => ({
      "X-Postmark-Server-Token": text(fields.token),
      Accept: "application/json",
    }),
    verify: {
      url: "https://api.postmarkapp.com/server",
      account: (body) => body?.Name || body?.ID,
    },
    actions: {
      send: {
        label: "Send an email",
        risk: "write",
        inputs: ["from", "to", "subject", "body"],
        request: (_f, params) => ({
          url: "https://api.postmarkapp.com/email",
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            From: text(params.from),
            To: text(params.to),
            Subject: text(params.subject) || "(no subject)",
            TextBody: text(params.body),
          }),
        }),
        summary: (body) => (body?.MessageID ? [`sent ${body.MessageID}`] : []),
      },
    },
  },

  mailchimp: {
    name: "Mailchimp",
    category: "mail",
    authType: "apiKey",
    description: "Your Mailchimp ping and audiences.",
    help: "API key from Mailchimp → Profile → Extras → API keys. Datacenter is the suffix after the last dash.",
    fields: [{ id: "token", label: "API key", secret: true }],
    auth: async (fields) => ({
      Authorization: `Basic ${Buffer.from(`any:${text(fields.token)}`).toString("base64")}`,
    }),
    verify: {
      url: (fields) => {
        const dc = text(fields.token).split("-").pop() || "us1";
        return `https://${dc}.api.mailchimp.com/3.0/ping`;
      },
      account: (body) => body?.health_status || "mailchimp",
    },
    actions: {
      lists: {
        label: "Audiences",
        risk: "safe",
        request: (fields) => {
          const dc = text(fields.token).split("-").pop() || "us1";
          return { url: `https://${dc}.api.mailchimp.com/3.0/lists?count=20` };
        },
        summary: (body) => list(body?.lists ?? [], (l) => l.name),
      },
    },
  },

  intercom: {
    name: "Intercom",
    category: "communication",
    authType: "apiKey",
    description: "Your Intercom workspace identity.",
    help: "Access token from Intercom Developer Hub.",
    fields: [{ id: "token", label: "Access token", secret: true }],
    auth: async (fields) => ({
      Authorization: `Bearer ${text(fields.token)}`,
      Accept: "application/json",
    }),
    verify: {
      url: "https://api.intercom.io/me",
      account: (body) => body?.email || body?.name,
    },
    actions: {
      me: {
        label: "Workspace identity",
        risk: "safe",
        request: () => ({ url: "https://api.intercom.io/me" }),
        summary: (body) => [body?.email || body?.name || ""].filter(Boolean),
      },
    },
  },

  zendesk: {
    name: "Zendesk",
    category: "communication",
    authType: "apiKey",
    description: "Your Zendesk user and open tickets.",
    help: "Subdomain plus email and an API token (email/token basic auth).",
    fields: [
      { id: "subdomain", label: "Subdomain (you in you.zendesk.com)", secret: false },
      { id: "email", label: "Account email", secret: false },
      { id: "token", label: "API token", secret: true },
    ],
    auth: async (fields) => ({
      Authorization: `Basic ${Buffer.from(`${text(fields.email)}/token:${text(fields.token)}`).toString("base64")}`,
    }),
    verify: {
      url: (fields) => `https://${text(fields.subdomain)}.zendesk.com/api/v2/users/me.json`,
      account: (body) => body?.user?.email || body?.user?.name,
    },
    actions: {
      tickets: {
        label: "Open tickets",
        risk: "safe",
        request: (fields) => ({
          url: `https://${text(fields.subdomain)}.zendesk.com/api/v2/search.json?query=${encodeURIComponent("type:ticket status<solved")}`,
        }),
        summary: (body) => list(body?.results ?? [], (t) => `#${t.id} ${t.subject || ""}`),
      },
    },
  },

  pipedrive: {
    name: "Pipedrive",
    category: "tasks",
    authType: "apiKey",
    description: "Your Pipedrive user and open deals.",
    help: "Personal API token from Pipedrive → Settings → Personal → API.",
    fields: [{ id: "token", label: "API token", secret: true }],
    auth: async () => ({}),
    verify: {
      url: (fields) => `https://api.pipedrive.com/api/v1/users/me?api_token=${text(fields.token)}`,
      account: (body) => body?.data?.email || body?.data?.name,
      failed: (body) =>
        body?.success === false ? body?.error || "Pipedrive rejected the token." : null,
    },
    actions: {
      deals: {
        label: "Open deals",
        risk: "safe",
        request: (fields) => ({
          url: `https://api.pipedrive.com/api/v1/deals?status=open&api_token=${text(fields.token)}`,
        }),
        summary: (body) => list(body?.data ?? [], (d) => d.title),
      },
    },
  },

  clockify: {
    name: "Clockify",
    category: "tasks",
    authType: "apiKey",
    description: "Your Clockify user and workspaces.",
    help: "API key from clockify.me/user/settings.",
    fields: [{ id: "token", label: "API key", secret: true }],
    auth: async (fields) => ({ "X-Api-Key": text(fields.token) }),
    verify: {
      url: "https://api.clockify.me/api/v1/user",
      account: (body) => body?.email || body?.name,
    },
    actions: {
      workspaces: {
        label: "List workspaces",
        risk: "safe",
        request: () => ({ url: "https://api.clockify.me/api/v1/workspaces" }),
        summary: (body) => list(Array.isArray(body) ? body : [], (w) => w.name),
      },
    },
  },

  harvest: {
    name: "Harvest",
    category: "tasks",
    authType: "apiKey",
    description: "Your Harvest user and time entries.",
    help: "Personal access token plus Account ID from Harvest → Developers.",
    fields: [
      { id: "token", label: "Personal access token", secret: true },
      { id: "accountId", label: "Account ID", secret: false },
    ],
    auth: async (fields) => ({
      Authorization: `Bearer ${text(fields.token)}`,
      "Harvest-Account-Id": text(fields.accountId),
      "User-Agent": "FRIDAY",
    }),
    verify: {
      url: "https://api.harvestapp.com/v2/users/me",
      account: (body) =>
        body?.email || [body?.first_name, body?.last_name].filter(Boolean).join(" "),
    },
    actions: {
      time: {
        label: "Recent time entries",
        risk: "safe",
        request: () => ({ url: "https://api.harvestapp.com/v2/time_entries?per_page=20" }),
        summary: (body) =>
          list(
            body?.time_entries ?? [],
            (e) => `${e.spent_date} ${e.hours}h ${e.notes || e.task?.name || ""}`,
          ),
      },
    },
  },

  "google-sheets": {
    name: "Google Sheets",
    category: "notes",
    authType: "oauth",
    description: "Spreadsheets in your Google Drive.",
    help: "OAuth client with drive.readonly or spreadsheets.readonly. Callback http://127.0.0.1:18765/oauth/callback.",
    fields: [
      { id: "clientId", label: "OAuth client id", secret: false, optional: true },
      { id: "clientSecret", label: "OAuth client secret", secret: true, optional: true },
      { id: "refreshToken", label: "Refresh token", secret: true, optional: true },
    ],
    oauth: {
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      scopes:
        "https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/userinfo.email",
      pkce: true,
      clientSecret: true,
      extraAuth: { access_type: "offline", prompt: "consent", include_granted_scopes: "true" },
    },
    auth: googleAuth("google-sheets"),
    verify: {
      url: "https://www.googleapis.com/drive/v3/about?fields=user",
      account: (body) => body?.user?.emailAddress,
    },
    actions: {
      sheets: {
        label: "Recent spreadsheets",
        risk: "safe",
        request: () => ({
          url:
            "https://www.googleapis.com/drive/v3/files?q=" +
            encodeURIComponent("mimeType='application/vnd.google-apps.spreadsheet'") +
            "&orderBy=modifiedTime desc&pageSize=20&fields=files(name,modifiedTime,webViewLink)",
        }),
        summary: (body) => list(body?.files ?? [], (f) => f.name),
      },
    },
  },

  "google-tasks": {
    name: "Google Tasks",
    category: "tasks",
    authType: "oauth",
    description: "Your Google Tasks lists.",
    help: "OAuth client with tasks.readonly. Callback http://127.0.0.1:18765/oauth/callback.",
    fields: [
      { id: "clientId", label: "OAuth client id", secret: false, optional: true },
      { id: "clientSecret", label: "OAuth client secret", secret: true, optional: true },
      { id: "refreshToken", label: "Refresh token", secret: true, optional: true },
    ],
    oauth: {
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      scopes:
        "https://www.googleapis.com/auth/tasks.readonly https://www.googleapis.com/auth/userinfo.email",
      pkce: true,
      clientSecret: true,
      extraAuth: { access_type: "offline", prompt: "consent", include_granted_scopes: "true" },
    },
    auth: googleAuth("google-tasks"),
    verify: {
      url: "https://tasks.googleapis.com/tasks/v1/users/@me/lists?maxResults=1",
      account: (body) => body?.items?.[0]?.title || "tasks",
    },
    actions: {
      lists: {
        label: "Task lists",
        risk: "safe",
        request: () => ({ url: "https://tasks.googleapis.com/tasks/v1/users/@me/lists" }),
        summary: (body) => list(body?.items ?? [], (l) => l.title),
      },
    },
  },

  outlook: {
    name: "Outlook Mail",
    category: "mail",
    authType: "oauth",
    description: "Read recent messages in Microsoft 365 / Outlook.",
    help: "Entra app with Mail.Read and User.Read. Callback http://127.0.0.1:18765/oauth/callback.",
    fields: [
      { id: "clientId", label: "Application (client) id", secret: false, optional: true },
      { id: "clientSecret", label: "Client secret", secret: true, optional: true },
    ],
    oauth: {
      authorizeUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
      tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
      scopes: "offline_access User.Read Mail.Read",
      pkce: true,
      clientSecret: false,
    },
    auth: bearerFrom("outlook", "https://login.microsoftonline.com/common/oauth2/v2.0/token"),
    verify: {
      url: "https://graph.microsoft.com/v1.0/me",
      account: (body) => body?.userPrincipalName || body?.mail,
    },
    actions: {
      inbox: {
        label: "Recent messages",
        risk: "safe",
        request: () => ({
          url: "https://graph.microsoft.com/v1.0/me/messages?$top=10&$select=subject,from,receivedDateTime",
        }),
        summary: (body) =>
          list(
            body?.value ?? [],
            (m) => `${m.from?.emailAddress?.address || ""} — ${m.subject || ""}`,
          ),
      },
    },
  },

  "microsoft-calendar": {
    name: "Microsoft Calendar",
    category: "calendar",
    authType: "oauth",
    description: "Events on your Microsoft 365 calendar.",
    help: "Entra app with Calendars.Read and User.Read. Callback http://127.0.0.1:18765/oauth/callback.",
    fields: [
      { id: "clientId", label: "Application (client) id", secret: false, optional: true },
      { id: "clientSecret", label: "Client secret", secret: true, optional: true },
    ],
    oauth: {
      authorizeUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
      tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
      scopes: "offline_access User.Read Calendars.Read",
      pkce: true,
      clientSecret: false,
    },
    auth: bearerFrom(
      "microsoft-calendar",
      "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    ),
    verify: {
      url: "https://graph.microsoft.com/v1.0/me",
      account: (body) => body?.userPrincipalName || body?.displayName,
    },
    actions: {
      upcoming: {
        label: "Upcoming events",
        risk: "safe",
        request: () => ({
          url: "https://graph.microsoft.com/v1.0/me/events?$top=10&$orderby=start/dateTime&$select=subject,start,end",
        }),
        summary: (body) =>
          list(body?.value ?? [], (e) => `${e.start?.dateTime || ""} — ${e.subject || ""}`),
      },
    },
  },

  "microsoft-todo": {
    name: "Microsoft To Do",
    category: "tasks",
    authType: "oauth",
    description: "Your Microsoft To Do lists.",
    help: "Entra app with Tasks.Read and User.Read. Callback http://127.0.0.1:18765/oauth/callback.",
    fields: [
      { id: "clientId", label: "Application (client) id", secret: false, optional: true },
      { id: "clientSecret", label: "Client secret", secret: true, optional: true },
    ],
    oauth: {
      authorizeUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
      tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
      scopes: "offline_access User.Read Tasks.Read",
      pkce: true,
      clientSecret: false,
    },
    auth: bearerFrom(
      "microsoft-todo",
      "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    ),
    verify: {
      url: "https://graph.microsoft.com/v1.0/me",
      account: (body) => body?.userPrincipalName || body?.displayName,
    },
    actions: {
      lists: {
        label: "To Do lists",
        risk: "safe",
        request: () => ({ url: "https://graph.microsoft.com/v1.0/me/todo/lists" }),
        summary: (body) => list(body?.value ?? [], (l) => l.displayName),
      },
    },
  },

  youtube: {
    name: "YouTube",
    category: "notes",
    authType: "oauth",
    description: "Your YouTube channel (read-only).",
    help: "Google OAuth client with youtube.readonly. Callback http://127.0.0.1:18765/oauth/callback.",
    fields: [
      { id: "clientId", label: "OAuth client id", secret: false, optional: true },
      { id: "clientSecret", label: "OAuth client secret", secret: true, optional: true },
      { id: "refreshToken", label: "Refresh token", secret: true, optional: true },
    ],
    oauth: {
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      scopes:
        "https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/userinfo.email",
      pkce: true,
      clientSecret: true,
      extraAuth: { access_type: "offline", prompt: "consent", include_granted_scopes: "true" },
    },
    auth: googleAuth("youtube"),
    verify: {
      url: "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true",
      account: (body) => body?.items?.[0]?.snippet?.title || "youtube",
    },
    actions: {
      channel: {
        label: "My channel",
        risk: "safe",
        request: () => ({
          url: "https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true",
        }),
        summary: (body) =>
          list(
            body?.items ?? [],
            (c) => `${c.snippet?.title} · ${c.statistics?.subscriberCount || ""} subs`,
          ),
      },
    },
  },

  box: {
    name: "Box",
    category: "storage",
    authType: "oauth",
    description: "Files in your Box account.",
    help: "Box developer app with OAuth 2.0. Callback http://127.0.0.1:18765/oauth/callback.",
    fields: [
      { id: "clientId", label: "Client id", secret: false, optional: true },
      { id: "clientSecret", label: "Client secret", secret: true, optional: true },
    ],
    oauth: {
      authorizeUrl: "https://account.box.com/api/oauth2/authorize",
      tokenUrl: "https://api.box.com/oauth2/token",
      scopes: "",
      pkce: true,
      clientSecret: true,
    },
    auth: bearerFrom("box", "https://api.box.com/oauth2/token"),
    verify: {
      url: "https://api.box.com/2.0/users/me",
      account: (body) => body?.login || body?.name,
    },
    actions: {
      files: {
        label: "Root folder",
        risk: "safe",
        request: () => ({ url: "https://api.box.com/2.0/folders/0/items?limit=20" }),
        summary: (body) => list(body?.entries ?? [], (e) => `${e.type} · ${e.name}`),
      },
    },
  },

  spotify: {
    name: "Spotify",
    category: "notes",
    authType: "oauth",
    description: "Your Spotify profile and playlists.",
    help: "Spotify app at developer.spotify.com. Callback http://127.0.0.1:18765/oauth/callback.",
    fields: [
      { id: "clientId", label: "Client id", secret: false, optional: true },
      { id: "clientSecret", label: "Client secret", secret: true, optional: true },
    ],
    oauth: {
      authorizeUrl: "https://accounts.spotify.com/authorize",
      tokenUrl: "https://accounts.spotify.com/api/token",
      scopes: "user-read-email playlist-read-private",
      pkce: true,
      clientSecret: true,
    },
    auth: bearerFrom("spotify", "https://accounts.spotify.com/api/token"),
    verify: {
      url: "https://api.spotify.com/v1/me",
      account: (body) => body?.display_name || body?.id,
    },
    actions: {
      playlists: {
        label: "My playlists",
        risk: "safe",
        request: () => ({ url: "https://api.spotify.com/v1/me/playlists?limit=20" }),
        summary: (body) => list(body?.items ?? [], (p) => p.name),
      },
    },
  },

  mastodon: {
    name: "Mastodon",
    category: "communication",
    authType: "apiKey",
    description: "Your Mastodon (or compatible) account on an instance you name.",
    help: "Instance URL plus an access token from Preferences → Development. Posting is write-tier.",
    fields: [
      { id: "site", label: "Instance URL (https://mastodon.social)", secret: false },
      { id: "token", label: "Access token", secret: true },
    ],
    auth: async (fields) => ({ Authorization: `Bearer ${text(fields.token)}` }),
    verify: {
      url: (fields) =>
        `${text(fields.site).replace(/\/+$/, "")}/api/v1/accounts/verify_credentials`,
      account: (body) => body?.acct || body?.username,
    },
    actions: {
      home: {
        label: "Home timeline",
        risk: "safe",
        request: (fields) => ({
          url: `${text(fields.site).replace(/\/+$/, "")}/api/v1/timelines/home?limit=10`,
        }),
        summary: (body) =>
          list(
            Array.isArray(body) ? body : [],
            (s) =>
              `@${s.account?.acct}: ${text(s.content)
                .replace(/<[^>]+>/g, "")
                .slice(0, 80)}`,
          ),
      },
      post: {
        label: "Publish a toot",
        risk: "write",
        inputs: ["message"],
        request: (fields, params) => ({
          url: `${text(fields.site).replace(/\/+$/, "")}/api/v1/statuses`,
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: text(params.message) }),
        }),
        summary: (body) => (body?.id ? [`posted ${body.url || body.id}`] : []),
      },
    },
  },

  raindrop: {
    name: "Raindrop.io",
    category: "notes",
    authType: "apiKey",
    description: "Your Raindrop bookmarks.",
    help: "Test token from app.raindrop.io/settings/integrations.",
    fields: [{ id: "token", label: "Test / access token", secret: true }],
    auth: async (fields) => ({ Authorization: `Bearer ${text(fields.token)}` }),
    verify: {
      url: "https://api.raindrop.io/rest/v1/user",
      account: (body) => body?.user?.email || body?.item?.email,
    },
    actions: {
      latest: {
        label: "Latest bookmarks",
        risk: "safe",
        request: () => ({ url: "https://api.raindrop.io/rest/v1/raindrops/0?perpage=20" }),
        summary: (body) => list(body?.items ?? [], (i) => i.title || i.link),
      },
    },
  },

  typeform: {
    name: "Typeform",
    category: "notes",
    authType: "apiKey",
    description: "Your Typeform account and forms.",
    help: "Personal token from admin.typeform.com/account#/section/tokens.",
    fields: [{ id: "token", label: "Personal token", secret: true }],
    auth: async (fields) => ({ Authorization: `Bearer ${text(fields.token)}` }),
    verify: {
      url: "https://api.typeform.com/me",
      account: (body) => body?.alias || body?.email,
    },
    actions: {
      forms: {
        label: "List forms",
        risk: "safe",
        request: () => ({ url: "https://api.typeform.com/forms?page_size=20" }),
        summary: (body) => list(body?.items ?? [], (f) => f.title),
      },
    },
  },

  shopify: {
    name: "Shopify",
    category: "tasks",
    authType: "apiKey",
    description: "Your Shopify shop (Admin API). Pages can be created or edited after approval.",
    help: "Custom app Admin API access token plus the myshopify.com host. Write actions (create/edit page) still ask every time.",
    fields: [
      { id: "shop", label: "Shop host (you.myshopify.com)", secret: false },
      { id: "token", label: "Admin API access token", secret: true },
    ],
    auth: async (fields) => ({ "X-Shopify-Access-Token": text(fields.token) }),
    verify: {
      url: (fields) => `https://${shopHost(fields)}/admin/api/2024-10/shop.json`,
      account: (body) => body?.shop?.name || body?.shop?.myshopify_domain,
    },
    actions: {
      shop: {
        label: "Shop profile",
        risk: "safe",
        request: (fields) => ({
          url: `https://${shopHost(fields)}/admin/api/2024-10/shop.json`,
        }),
        summary: (body) => [`${body?.shop?.name || ""} · ${body?.shop?.email || ""}`],
      },
      pages: {
        label: "List pages",
        risk: "safe",
        request: (fields) => ({
          url: `https://${shopHost(fields)}/admin/api/2024-10/pages.json?limit=20`,
        }),
        summary: (body) => list(body?.pages ?? [], (p) => `${p.id} ${p.title}`),
      },
      "publish-page": {
        label: "Create a page",
        risk: "write",
        inputs: ["title", "body"],
        request: (fields, params) => ({
          url: `https://${shopHost(fields)}/admin/api/2024-10/pages.json`,
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            page: {
              title: text(params.title) || "Untitled",
              body_html: text(params.body || params.content || params.text),
            },
          }),
        }),
        summary: (body) =>
          [body?.page?.id ? `page ${body.page.id} ${body.page.title || ""}` : ""].filter(Boolean),
      },
      "edit-page": {
        label: "Edit a page",
        risk: "write",
        inputs: ["id", "title", "body"],
        run: async ({ fields, params, call }) => {
          const id = text(params.id).trim();
          if (!id) return { ok: false, error: "Give the Shopify page id to edit." };
          const page = {};
          if (text(params.title)) page.title = text(params.title);
          if (text(params.body || params.content || params.text))
            page.body_html = text(params.body || params.content || params.text);
          if (!Object.keys(page).length)
            return { ok: false, error: "Give a title or body to change on that page." };
          const r = await call({
            url: `https://${shopHost(fields)}/admin/api/2024-10/pages/${encodeURIComponent(id)}.json`,
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ page }),
          });
          if (!r.ok)
            return {
              ok: false,
              error: graphError(r.body, `Shopify refused the edit (${r.status}).`),
            };
          return {
            ok: true,
            lines: [`updated page ${r.body?.page?.id || id}`],
            data: r.body,
          };
        },
      },
    },
  },

  wordpress: {
    name: "WordPress",
    category: "notes",
    authType: "apiKey",
    description:
      "A WordPress site's REST API via application password. Publish and edit are write actions.",
    help: "Site URL plus a WordPress application password (Users → Profile). Publish/edit still go through the approval gate every time.",
    fields: [
      { id: "site", label: "Site URL", secret: false },
      { id: "user", label: "Username", secret: false },
      { id: "token", label: "Application password", secret: true },
    ],
    auth: async (fields) => ({
      Authorization: `Basic ${Buffer.from(`${text(fields.user)}:${text(fields.token)}`).toString("base64")}`,
    }),
    verify: {
      url: (fields) => `${wpSite(fields)}/wp-json/wp/v2/users/me`,
      account: (body) => body?.name || body?.slug,
    },
    actions: {
      posts: {
        label: "Recent posts",
        risk: "safe",
        request: (fields) => ({
          url: `${wpSite(fields)}/wp-json/wp/v2/posts?per_page=10&_fields=id,title,link`,
        }),
        summary: (body) =>
          list(Array.isArray(body) ? body : [], (p) => p.title?.rendered || p.link),
      },
      publish: {
        label: "Publish a post",
        risk: "write",
        inputs: ["title", "content", "status"],
        request: (fields, params) => ({
          url: `${wpSite(fields)}/wp-json/wp/v2/posts`,
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            title: text(params.title) || "Untitled",
            content: text(params.content || params.body || params.text),
            status: /^(publish|draft|private)$/i.test(text(params.status))
              ? text(params.status).toLowerCase()
              : "publish",
          }),
        }),
        summary: (body) => [body?.link || (body?.id ? `post ${body.id}` : "")].filter(Boolean),
      },
      edit: {
        label: "Edit a post",
        risk: "write",
        inputs: ["id", "title", "content", "status"],
        run: async ({ fields, params, call }) => {
          const id = text(params.id).trim();
          if (!id) return { ok: false, error: "Give the WordPress post id to edit." };
          const payload = {};
          if (text(params.title)) payload.title = text(params.title);
          const content = text(params.content || params.body || params.text);
          if (content) payload.content = content;
          if (text(params.status)) payload.status = text(params.status);
          if (!Object.keys(payload).length)
            return { ok: false, error: "Give title, content, or status to change." };
          const r = await call({
            url: `${wpSite(fields)}/wp-json/wp/v2/posts/${encodeURIComponent(id)}`,
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          });
          if (!r.ok)
            return {
              ok: false,
              error: graphError(r.body, `WordPress refused the edit (${r.status}).`),
            };
          return { ok: true, lines: [r.body?.link || `updated ${id}`], data: r.body };
        },
      },
    },
  },

  twitter: {
    name: "X / Twitter",
    category: "communication",
    authType: "apiKey",
    description: "Post to X (Twitter) with user-context OAuth 1.0a keys from the developer portal.",
    help: "API key, API secret, access token and access token secret (user context, tweet.write). Connected only after GET /2/users/me succeeds. Posts still ask every time.",
    fields: [
      { id: "apiKey", label: "API key (consumer key)", secret: true },
      { id: "apiSecret", label: "API secret (consumer secret)", secret: true },
      { id: "accessToken", label: "Access token", secret: true },
      { id: "accessSecret", label: "Access token secret", secret: true },
    ],
    auth: async (fields, _fetchImpl, ctx = {}) =>
      oauth1Header(fields, ctx.method || "GET", ctx.url || "https://api.twitter.com/2/users/me"),
    verify: {
      url: "https://api.twitter.com/2/users/me",
      account: (body) => body?.data?.username,
    },
    actions: {
      me: {
        label: "My profile",
        risk: "safe",
        request: () => ({ url: "https://api.twitter.com/2/users/me" }),
        summary: (body) => [`@${body?.data?.username || ""}`].filter((row) => row !== "@"),
      },
      post: {
        label: "Create a post",
        risk: "write",
        inputs: ["text"],
        request: (_fields, params) => ({
          url: "https://api.twitter.com/2/tweets",
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: text(params.text || params.message) }),
        }),
        summary: (body) => [body?.data?.id ? `posted ${body.data.id}` : ""].filter(Boolean),
      },
    },
  },

  instagram: {
    name: "Instagram",
    category: "communication",
    authType: "apiKey",
    description:
      "Instagram professional account via Graph API. Feed publish needs a public image URL.",
    help: "Page-linked Instagram user id plus a Graph token with instagram_content_publish. Text-only feed posts are refused honestly.",
    fields: [
      { id: "token", label: "Graph access token", secret: true },
      { id: "igUserId", label: "Instagram professional account ID", secret: false },
    ],
    auth: async (fields) => ({ Authorization: `Bearer ${text(fields.token)}` }),
    verify: {
      url: (fields) =>
        `https://graph.facebook.com/v21.0/${text(fields.igUserId)}?fields=id,username`,
      account: (body) => body?.username || body?.id,
    },
    actions: {
      profile: {
        label: "Account profile",
        risk: "safe",
        request: (fields) => ({
          url: `https://graph.facebook.com/v21.0/${text(fields.igUserId)}?fields=id,username,name`,
        }),
        summary: (body) => [`@${body?.username || body?.id || ""}`],
      },
      post: {
        label: "Publish a photo post",
        risk: "write",
        inputs: ["imageUrl", "caption"],
        run: async ({ fields, params, call }) => {
          const imageUrl = text(params.imageUrl || params.url);
          const caption = text(params.caption || params.text || params.message);
          if (!imageUrl) {
            return {
              ok: false,
              error:
                "Instagram Graph publishing needs a public image URL. Text-only feed posts are not supported.",
            };
          }
          const ig = text(fields.igUserId);
          const created = await call({
            url: `https://graph.facebook.com/v21.0/${ig}/media`,
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ image_url: imageUrl, caption }),
          });
          if (!created.ok || !created.body?.id) {
            return {
              ok: false,
              error: graphError(created.body, "Instagram refused the media container."),
            };
          }
          const published = await call({
            url: `https://graph.facebook.com/v21.0/${ig}/media_publish`,
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ creation_id: created.body.id }),
          });
          if (!published.ok) {
            return {
              ok: false,
              error: graphError(published.body, "Instagram refused publish."),
            };
          }
          return {
            ok: true,
            lines: [`published ${published.body?.id || created.body.id}`],
            data: published.body,
          };
        },
      },
    },
  },

  facebook: {
    name: "Facebook",
    category: "communication",
    authType: "apiKey",
    description: "A Facebook Page you manage. Text posts go to /{page-id}/feed after approval.",
    help: "Page ID plus a Page access token with pages_manage_posts. This is not a personal-profile poster.",
    fields: [
      { id: "token", label: "Page access token", secret: true },
      { id: "pageId", label: "Page ID", secret: false },
    ],
    auth: async (fields) => ({ Authorization: `Bearer ${text(fields.token)}` }),
    verify: {
      url: (fields) => `https://graph.facebook.com/v21.0/${text(fields.pageId)}?fields=id,name`,
      account: (body) => body?.name || body?.id,
    },
    actions: {
      page: {
        label: "Page profile",
        risk: "safe",
        request: (fields) => ({
          url: `https://graph.facebook.com/v21.0/${text(fields.pageId)}?fields=id,name`,
        }),
        summary: (body) => [body?.name || body?.id].filter(Boolean),
      },
      post: {
        label: "Post to the Page",
        risk: "write",
        inputs: ["message"],
        request: (fields, params) => ({
          url: `https://graph.facebook.com/v21.0/${text(fields.pageId)}/feed`,
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message: text(params.message || params.text) }),
        }),
        summary: (body) => [body?.id ? `posted ${body.id}` : ""].filter(Boolean),
      },
    },
  },

  linkedin: {
    name: "LinkedIn",
    category: "communication",
    authType: "apiKey",
    description: "Share a text post as the authenticated member (UGC Posts API).",
    help: "OAuth 2.0 user token with w_member_social and OpenID userinfo. Connected after /v2/userinfo succeeds.",
    fields: [{ id: "token", label: "Member access token", secret: true }],
    auth: async (fields) => ({
      Authorization: `Bearer ${text(fields.token)}`,
      "X-Restli-Protocol-Version": "2.0.0",
    }),
    verify: {
      url: "https://api.linkedin.com/v2/userinfo",
      account: (body) => body?.name || body?.email || body?.sub,
    },
    actions: {
      me: {
        label: "My profile",
        risk: "safe",
        request: () => ({ url: "https://api.linkedin.com/v2/userinfo" }),
        summary: (body) => [body?.name || body?.email || body?.sub].filter(Boolean),
      },
      post: {
        label: "Share a post",
        risk: "write",
        inputs: ["text"],
        run: async ({ fields, params, call }) => {
          const commentary = text(params.text || params.message);
          if (!commentary.trim()) return { ok: false, error: "Give the LinkedIn post text." };
          const me = await call({ url: "https://api.linkedin.com/v2/userinfo" });
          const person = text(me.body?.sub);
          if (!me.ok || !person)
            return { ok: false, error: "LinkedIn userinfo did not return a member id." };
          const created = await call({
            url: "https://api.linkedin.com/v2/ugcPosts",
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              author: `urn:li:person:${person}`,
              lifecycleState: "PUBLISHED",
              specificContent: {
                "com.linkedin.ugc.ShareContent": {
                  shareCommentary: { text: commentary },
                  shareMediaCategory: "NONE",
                },
              },
              visibility: { "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC" },
            }),
          });
          if (!created.ok) {
            return {
              ok: false,
              error: graphError(created.body, `LinkedIn refused the post (${created.status}).`),
            };
          }
          const id = text(created.body?.id);
          return { ok: true, lines: [id ? `posted ${id}` : "posted"], data: created.body };
        },
      },
    },
  },

  bluesky: {
    name: "Bluesky",
    category: "communication",
    authType: "apiKey",
    description: "Your Bluesky account via an app password (AT Protocol).",
    help: "Handle plus an app password from Bluesky Settings. Optional PDS URL defaults to https://bsky.social. This is not Twitter/X.",
    fields: [
      { id: "handle", label: "Handle or email", secret: false },
      { id: "token", label: "App password", secret: true },
      { id: "instance", label: "PDS URL (optional)", secret: false, optional: true },
    ],
    auth: async (fields, fetchImpl) => {
      const base = text(fields.instance || "https://bsky.social").replace(/\/+$/, "");
      const res = await fetchImpl(`${base}/xrpc/com.atproto.server.createSession`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ identifier: text(fields.handle), password: text(fields.token) }),
      });
      const body = await readBody(res);
      if (!body?.accessJwt) throw new Error(text(body?.message || "Bluesky login failed."));
      return { Authorization: `Bearer ${body.accessJwt}` };
    },
    verify: {
      url: (fields) =>
        `${text(fields.instance || "https://bsky.social").replace(/\/+$/, "")}/xrpc/com.atproto.server.getSession`,
      account: (body) => body?.handle,
    },
    actions: {
      timeline: {
        label: "Home timeline",
        risk: "safe",
        request: (fields) => ({
          url: `${text(fields.instance || "https://bsky.social").replace(/\/+$/, "")}/xrpc/app.bsky.feed.getTimeline?limit=20`,
        }),
        summary: (body) =>
          list(
            body?.feed ?? [],
            (row) => row.post?.author?.handle + " — " + (row.post?.record?.text || ""),
          ),
      },
      post: {
        label: "Create a post",
        risk: "write",
        inputs: ["text"],
        run: async ({ fields, params, call }) => {
          const session = await call({
            url: `${text(fields.instance || "https://bsky.social").replace(/\/+$/, "")}/xrpc/com.atproto.server.getSession`,
          });
          if (!session.ok || !session.body?.did)
            return { ok: false, error: "Bluesky session has no DID." };
          const created = await call({
            url: `${text(fields.instance || "https://bsky.social").replace(/\/+$/, "")}/xrpc/com.atproto.repo.createRecord`,
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              repo: session.body.did,
              collection: "app.bsky.feed.post",
              record: {
                $type: "app.bsky.feed.post",
                text: text(params.text),
                createdAt: new Date().toISOString(),
              },
            }),
          });
          if (!created.ok)
            return { ok: false, error: text(created.body?.message) || "Bluesky refused the post." };
          return { ok: true, lines: [`posted ${created.body?.uri || ""}`], data: created.body };
        },
      },
    },
  },

  mailgun: {
    name: "Mailgun",
    category: "mail",
    authType: "apiKey",
    description: "Your Mailgun domains (sending stays write-tier).",
    help: "Private API key from Mailgun → Settings → API Keys. EU region uses api.eu.mailgun.net.",
    fields: [
      { id: "token", label: "Private API key", secret: true },
      { id: "baseUrl", label: "API host (optional)", secret: false, optional: true },
    ],
    auth: async (fields) => ({
      Authorization: `Basic ${Buffer.from(`api:${text(fields.token)}`).toString("base64")}`,
    }),
    verify: {
      url: (fields) =>
        `${text(fields.baseUrl || "https://api.mailgun.net").replace(/\/+$/, "")}/v3/domains`,
      account: (body) => body?.items?.[0]?.name || "mailgun",
    },
    actions: {
      domains: {
        label: "List domains",
        risk: "safe",
        request: (fields) => ({
          url: `${text(fields.baseUrl || "https://api.mailgun.net").replace(/\/+$/, "")}/v3/domains`,
        }),
        summary: (body) => list(body?.items ?? [], (d) => d.name),
      },
    },
  },

  toggl: {
    name: "Toggl Track",
    category: "tasks",
    authType: "apiKey",
    description: "Your Toggl Track profile and recent time entries.",
    help: "API token from Toggl Track → Profile → API Token. Sent as Basic token:api_token.",
    fields: [{ id: "token", label: "API token", secret: true }],
    auth: async (fields) => ({
      Authorization: `Basic ${Buffer.from(`${text(fields.token)}:api_token`).toString("base64")}`,
    }),
    verify: {
      url: "https://api.track.toggl.com/api/v9/me",
      account: (body) => body?.email || body?.fullname,
    },
    actions: {
      time: {
        label: "Recent time entries",
        risk: "safe",
        request: () => ({ url: "https://api.track.toggl.com/api/v9/me/time_entries" }),
        summary: (body) =>
          list(Array.isArray(body) ? body : [], (e) => `${e.start || ""} ${e.description || ""}`),
      },
    },
  },

  "cal-com": {
    name: "Cal.com",
    category: "calendar",
    authType: "apiKey",
    description: "Your Cal.com user and event types.",
    help: "API key from Cal.com → Settings → Developer → API keys.",
    fields: [{ id: "token", label: "API key", secret: true }],
    auth: async (fields) => ({ Authorization: `Bearer ${text(fields.token)}` }),
    verify: {
      url: "https://api.cal.com/v2/me",
      account: (body) => body?.data?.email || body?.data?.username || body?.email,
    },
    actions: {
      types: {
        label: "Event types",
        risk: "safe",
        request: () => ({ url: "https://api.cal.com/v2/event-types" }),
        summary: (body) =>
          list(
            body?.data?.eventTypeGroups?.flatMap((g) => g.eventTypes || []) || body?.data || [],
            (t) => t.title || t.slug,
          ),
      },
    },
  },

  miro: {
    name: "Miro",
    category: "notes",
    authType: "apiKey",
    description: "Your Miro user and boards.",
    help: "Create a Miro app token (or paste a personal access token) with boards:read.",
    fields: [{ id: "token", label: "Access token", secret: true }],
    auth: async (fields) => ({ Authorization: `Bearer ${text(fields.token)}` }),
    verify: {
      url: "https://api.miro.com/v2/users/me",
      account: (body) => body?.email || body?.name,
    },
    actions: {
      boards: {
        label: "List boards",
        risk: "safe",
        request: () => ({ url: "https://api.miro.com/v2/boards?limit=20" }),
        summary: (body) => list(body?.data ?? [], (b) => b.name),
      },
    },
  },

  webflow: {
    name: "Webflow",
    category: "notes",
    authType: "apiKey",
    description: "The Webflow account that issued this token, and its sites.",
    help: "Site token or site-scoped token from Webflow Apps. This is not live CMS publish.",
    fields: [{ id: "token", label: "API token", secret: true }],
    auth: async (fields) => ({ Authorization: `Bearer ${text(fields.token)}` }),
    verify: {
      url: "https://api.webflow.com/v2/token/authorized_by",
      account: (body) => body?.email || body?.firstName,
    },
    actions: {
      sites: {
        label: "List sites",
        risk: "safe",
        request: () => ({ url: "https://api.webflow.com/v2/sites" }),
        summary: (body) => list(body?.sites ?? [], (s) => s.displayName || s.shortName),
      },
    },
  },

  contentful: {
    name: "Contentful",
    category: "notes",
    authType: "apiKey",
    description: "One Contentful space via a Content Management token.",
    help: "Space ID plus a CMA personal access token. This is not live CMS publish.",
    fields: [
      { id: "space", label: "Space ID", secret: false },
      { id: "token", label: "CMA token", secret: true },
    ],
    auth: async (fields) => ({ Authorization: `Bearer ${text(fields.token)}` }),
    verify: {
      url: (fields) =>
        `https://api.contentful.com/spaces/${encodeURIComponent(text(fields.space))}`,
      account: (body) => body?.name || body?.sys?.id,
    },
    actions: {
      types: {
        label: "Content types",
        risk: "safe",
        request: (fields) => ({
          url: `https://api.contentful.com/spaces/${encodeURIComponent(text(fields.space))}/content_types?limit=20`,
        }),
        summary: (body) => list(body?.items ?? [], (t) => t.name),
      },
    },
  },

  sanity: {
    name: "Sanity",
    category: "notes",
    authType: "apiKey",
    description: "Your Sanity user for one project.",
    help: "Project ID plus a token with Viewer. Dataset is only used for the documents action.",
    fields: [
      { id: "project", label: "Project ID", secret: false },
      { id: "token", label: "API token", secret: true },
      { id: "dataset", label: "Dataset", secret: false, optional: true },
    ],
    auth: async (fields) => ({ Authorization: `Bearer ${text(fields.token)}` }),
    verify: {
      url: (fields) => `https://${text(fields.project)}.api.sanity.io/v2021-06-07/users/me`,
      account: (body) => body?.email || body?.displayName,
    },
    actions: {
      documents: {
        label: "Recent documents",
        risk: "safe",
        request: (fields) => ({
          url:
            `https://${text(fields.project)}.api.sanity.io/v2021-06-07/data/query/${encodeURIComponent(text(fields.dataset || "production"))}` +
            "?query=" +
            encodeURIComponent(
              "*[_type != null] | order(_updatedAt desc)[0...20]{_id,_type,_updatedAt}",
            ),
        }),
        summary: (body) => list(body?.result ?? [], (d) => `${d._type || ""} ${d._id || ""}`),
      },
    },
  },

  ghost: {
    name: "Ghost",
    category: "notes",
    authType: "apiKey",
    description: "A Ghost site via the Content API (read).",
    help: "Site URL plus a Content API key from Ghost → Settings → Integrations. This is not live CMS publish.",
    fields: [
      { id: "site", label: "Site URL", secret: false },
      { id: "token", label: "Content API key", secret: true },
    ],
    auth: async () => ({}),
    verify: {
      url: (fields) =>
        `${text(fields.site).replace(/\/+$/, "")}/ghost/api/content/settings/?key=${encodeURIComponent(text(fields.token))}`,
      account: (body) => body?.settings?.title || "ghost",
    },
    actions: {
      posts: {
        label: "Recent posts",
        risk: "safe",
        request: (fields) => ({
          url: `${text(fields.site).replace(/\/+$/, "")}/ghost/api/content/posts/?key=${encodeURIComponent(text(fields.token))}&limit=10&fields=id,title,url`,
        }),
        summary: (body) => list(body?.posts ?? [], (p) => p.title),
      },
    },
  },

  algolia: {
    name: "Algolia",
    category: "development",
    authType: "apiKey",
    description: "Indexes in one Algolia application.",
    help: "Application ID plus an API key with listIndexes (search-only keys will fail the index list).",
    fields: [
      { id: "appId", label: "Application ID", secret: false },
      { id: "token", label: "API key", secret: true },
    ],
    auth: async (fields) => ({
      "X-Algolia-Application-Id": text(fields.appId),
      "X-Algolia-API-Key": text(fields.token),
    }),
    verify: {
      url: (fields) => `https://${text(fields.appId)}.algolia.net/1/indexes`,
      account: (body) => body?.items?.[0]?.name || text(fields.appId),
    },
    actions: {
      indexes: {
        label: "List indexes",
        risk: "safe",
        request: (fields) => ({ url: `https://${text(fields.appId)}.algolia.net/1/indexes` }),
        summary: (body) => list(body?.items ?? [], (i) => i.name),
      },
    },
  },

  supabase: {
    name: "Supabase",
    category: "development",
    authType: "apiKey",
    description: "One Supabase project REST surface (OpenAPI).",
    help: "Project URL plus the anon or service key. Service keys can write — keep them local; FRIDAY only GETs /rest/v1/ here.",
    fields: [
      { id: "site", label: "Project URL", secret: false },
      { id: "token", label: "API key", secret: true },
    ],
    auth: async (fields) => ({
      apikey: text(fields.token),
      Authorization: `Bearer ${text(fields.token)}`,
    }),
    verify: {
      url: (fields) => `${text(fields.site).replace(/\/+$/, "")}/rest/v1/`,
      account: () => "supabase",
    },
    actions: {
      schema: {
        label: "OpenAPI schema",
        risk: "safe",
        request: (fields) => ({ url: `${text(fields.site).replace(/\/+$/, "")}/rest/v1/` }),
        summary: (body) => [
          typeof body === "string" ? body.slice(0, 400) : JSON.stringify(body).slice(0, 400),
        ],
      },
    },
  },

  railway: {
    name: "Railway",
    category: "development",
    authType: "apiKey",
    description: "Your Railway account via the GraphQL API.",
    help: "Account token from railway.app/account/tokens.",
    fields: [{ id: "token", label: "API token", secret: true }],
    auth: async (fields) => ({
      Authorization: `Bearer ${text(fields.token)}`,
      "content-type": "application/json",
    }),
    verify: {
      url: "https://backboard.railway.app/graphql/v2",
      method: "POST",
      body: JSON.stringify({ query: "{ me { email name } }" }),
      account: (body) => body?.data?.me?.email || body?.data?.me?.name,
      failed: (body) => (body?.errors?.length ? body.errors[0]?.message : null),
    },
    actions: {
      projects: {
        label: "List projects",
        risk: "safe",
        request: () => ({
          url: "https://backboard.railway.app/graphql/v2",
          method: "POST",
          body: JSON.stringify({ query: "{ me { projects { edges { node { name } } } } }" }),
        }),
        summary: (body) =>
          list(
            body?.data?.me?.projects?.edges ?? body?.data?.projects?.edges ?? [],
            (e) => e.node?.name,
          ),
      },
    },
  },

  render: {
    name: "Render",
    category: "development",
    authType: "apiKey",
    description: "Your Render owners and services.",
    help: "API key from Render → Account Settings → API Keys.",
    fields: [{ id: "token", label: "API key", secret: true }],
    auth: async (fields) => ({ Authorization: `Bearer ${text(fields.token)}` }),
    verify: {
      url: "https://api.render.com/v1/owners",
      account: (body) =>
        (Array.isArray(body) ? body[0]?.owner?.email || body[0]?.owner?.name : body?.email) ||
        "render",
    },
    actions: {
      services: {
        label: "List services",
        risk: "safe",
        request: () => ({ url: "https://api.render.com/v1/services?limit=20" }),
        summary: (body) =>
          list(Array.isArray(body) ? body : [], (row) => row.service?.name || row.name),
      },
    },
  },

  fly: {
    name: "Fly.io",
    category: "development",
    authType: "apiKey",
    description: "Apps on your Fly.io account.",
    help: "Access token from fly auth token / fly tokens create.",
    fields: [{ id: "token", label: "Access token", secret: true }],
    auth: async (fields) => ({ Authorization: `Bearer ${text(fields.token)}` }),
    verify: {
      url: "https://api.machines.dev/v1/apps",
      account: (body) => body?.apps?.[0]?.name || "fly.io",
    },
    actions: {
      apps: {
        label: "List apps",
        risk: "safe",
        request: () => ({ url: "https://api.machines.dev/v1/apps" }),
        summary: (body) => list(body?.apps ?? [], (a) => a.name),
      },
    },
  },

  circleci: {
    name: "CircleCI",
    category: "development",
    authType: "apiKey",
    description: "Your CircleCI user and followed projects.",
    help: "Personal API token from CircleCI → User Settings → Personal API Tokens.",
    fields: [{ id: "token", label: "Personal API token", secret: true }],
    auth: async (fields) => ({ "Circle-Token": text(fields.token) }),
    verify: {
      url: "https://circleci.com/api/v2/me",
      account: (body) => body?.login || body?.name,
    },
    actions: {
      projects: {
        label: "Followed projects",
        risk: "safe",
        request: () => ({ url: "https://circleci.com/api/v2/me/collaborations" }),
        summary: (body) =>
          list(
            Array.isArray(body) ? body : (body?.items ?? []),
            (p) => p.name || p.slug || p.vcs_url,
          ),
      },
    },
  },

  datadog: {
    name: "Datadog",
    category: "development",
    authType: "apiKey",
    description: "Validates a Datadog API key (and lists monitors).",
    help: "API key plus Application key from Datadog → Organization Settings. Optional site defaults to datadoghq.com.",
    fields: [
      { id: "token", label: "API key", secret: true },
      { id: "appKey", label: "Application key", secret: true },
      { id: "site", label: "Site host (optional)", secret: false, optional: true },
    ],
    auth: async (fields) => ({
      "DD-API-KEY": text(fields.token),
      "DD-APPLICATION-KEY": text(fields.appKey),
    }),
    verify: {
      url: (fields) => `https://api.${text(fields.site || "datadoghq.com")}/api/v1/validate`,
      account: (body) => (body?.valid ? "datadog" : ""),
      failed: (body) => (body && body.valid === false ? "API key is not valid" : null),
    },
    actions: {
      monitors: {
        label: "Monitors",
        risk: "safe",
        request: (fields) => ({
          url: `https://api.${text(fields.site || "datadoghq.com")}/api/v1/monitor?page_size=20`,
        }),
        summary: (body) => list(Array.isArray(body) ? body : (body?.monitors ?? []), (m) => m.name),
      },
    },
  },

  newrelic: {
    name: "New Relic",
    category: "development",
    authType: "apiKey",
    description: "Your New Relic user via NerdGraph.",
    help: "User API key (NRAK-…) from New Relic → API keys.",
    fields: [{ id: "token", label: "User API key", secret: true }],
    auth: async (fields) => ({
      "Api-Key": text(fields.token),
      "content-type": "application/json",
    }),
    verify: {
      url: "https://api.newrelic.com/graphql",
      method: "POST",
      body: JSON.stringify({ query: "{ actor { user { email name } } }" }),
      account: (body) => body?.data?.actor?.user?.email || body?.data?.actor?.user?.name,
      failed: (body) => (body?.errors?.length ? body.errors[0]?.message : null),
    },
    actions: {
      accounts: {
        label: "Accounts",
        risk: "safe",
        request: () => ({
          url: "https://api.newrelic.com/graphql",
          method: "POST",
          body: JSON.stringify({ query: "{ actor { accounts { id name } } }" }),
        }),
        summary: (body) => list(body?.data?.actor?.accounts ?? [], (a) => `${a.id} ${a.name}`),
      },
    },
  },

  uptimerobot: {
    name: "UptimeRobot",
    category: "development",
    authType: "apiKey",
    description: "Your UptimeRobot account and monitors.",
    help: "Main API key from UptimeRobot → My Settings. Sent as api_key in the POST body.",
    fields: [{ id: "token", label: "API key", secret: true }],
    auth: async () => ({ "content-type": "application/x-www-form-urlencoded" }),
    verify: {
      url: "https://api.uptimerobot.com/v2/getAccountDetails",
      method: "POST",
      body: (fields) =>
        new URLSearchParams({ api_key: text(fields.token), format: "json" }).toString(),
      account: (body) => body?.account?.email || body?.account?.monitor_limit,
      failed: (body) =>
        body?.stat === "fail" ? body?.error?.message || "UptimeRobot refused the key" : null,
    },
    actions: {
      monitors: {
        label: "Monitors",
        risk: "safe",
        request: (fields) => ({
          url: "https://api.uptimerobot.com/v2/getMonitors",
          method: "POST",
          body: new URLSearchParams({
            api_key: text(fields.token),
            format: "json",
            logs: "0",
          }).toString(),
        }),
        summary: (body) => list(body?.monitors ?? [], (m) => `${m.friendly_name} ${m.url || ""}`),
      },
    },
  },

  freshdesk: {
    name: "Freshdesk",
    category: "communication",
    authType: "apiKey",
    description: "Your Freshdesk agent profile and tickets.",
    help: "Helpdesk domain (yourcompany.freshdesk.com) plus an API key from Profile settings.",
    fields: [
      { id: "site", label: "Domain (example.freshdesk.com)", secret: false },
      { id: "token", label: "API key", secret: true },
    ],
    auth: async (fields) => ({
      Authorization: `Basic ${Buffer.from(`${text(fields.token)}:X`).toString("base64")}`,
    }),
    verify: {
      url: (fields) => {
        const host = text(fields.site)
          .replace(/^https?:\/\//, "")
          .replace(/\/+$/, "");
        return `https://${host}/api/v2/agents/me`;
      },
      account: (body) => body?.contact?.email || body?.contact?.name,
    },
    actions: {
      tickets: {
        label: "Open tickets",
        risk: "safe",
        request: (fields) => {
          const host = text(fields.site)
            .replace(/^https?:\/\//, "")
            .replace(/\/+$/, "");
          return { url: `https://${host}/api/v2/tickets?filter=new_and_my_open` };
        },
        summary: (body) =>
          list(Array.isArray(body) ? body : [], (t) => `#${t.id} ${t.subject || ""}`),
      },
    },
  },

  brevo: {
    name: "Brevo",
    category: "mail",
    authType: "apiKey",
    description: "Your Brevo (Sendinblue) account.",
    help: "API key from Brevo → SMTP & API → API Keys.",
    fields: [{ id: "token", label: "API key", secret: true }],
    auth: async (fields) => ({ "api-key": text(fields.token) }),
    verify: {
      url: "https://api.brevo.com/v3/account",
      account: (body) => body?.email || body?.companyName,
    },
    actions: {
      lists: {
        label: "Contact lists",
        risk: "safe",
        request: () => ({ url: "https://api.brevo.com/v3/contacts/lists?limit=20" }),
        summary: (body) => list(body?.lists ?? [], (l) => l.name),
      },
    },
  },

  klaviyo: {
    name: "Klaviyo",
    category: "mail",
    authType: "apiKey",
    description: "Your Klaviyo account.",
    help: "Private API key from Klaviyo → Settings → API Keys. Sent as Klaviyo-API-Key.",
    fields: [{ id: "token", label: "Private API key", secret: true }],
    auth: async (fields) => ({
      Authorization: `Klaviyo-API-Key ${text(fields.token)}`,
      revision: "2024-10-15",
    }),
    verify: {
      url: "https://a.klaviyo.com/api/accounts",
      account: (body) => body?.data?.[0]?.attributes?.contact_information?.email || "klaviyo",
    },
    actions: {
      lists: {
        label: "Lists",
        risk: "safe",
        request: () => ({ url: "https://a.klaviyo.com/api/lists" }),
        summary: (body) => list(body?.data ?? [], (l) => l.attributes?.name),
      },
    },
  },

  replicate: {
    name: "Replicate",
    category: "development",
    authType: "apiKey",
    description: "Your Replicate account (models stay in FRIDAY's model catalog).",
    help: "API token from replicate.com/account/api-tokens. This is not a model provider in FRIDAY's router.",
    fields: [{ id: "token", label: "API token", secret: true }],
    auth: async (fields) => ({ Authorization: `Bearer ${text(fields.token)}` }),
    verify: {
      url: "https://api.replicate.com/v1/account",
      account: (body) => body?.username || body?.github_username,
    },
    actions: {
      models: {
        label: "Your models",
        risk: "safe",
        request: () => ({ url: "https://api.replicate.com/v1/models" }),
        summary: (body) => list(body?.results ?? [], (m) => m.name || m.owner),
      },
    },
  },

  pinecone: {
    name: "Pinecone",
    category: "development",
    authType: "apiKey",
    description: "Indexes in your Pinecone project.",
    help: "API key from Pinecone console. Optional host is unused — this talks to api.pinecone.io.",
    fields: [{ id: "token", label: "API key", secret: true }],
    auth: async (fields) => ({ "Api-Key": text(fields.token) }),
    verify: {
      url: "https://api.pinecone.io/indexes",
      account: (body) => body?.indexes?.[0]?.name || "pinecone",
    },
    actions: {
      indexes: {
        label: "List indexes",
        risk: "safe",
        request: () => ({ url: "https://api.pinecone.io/indexes" }),
        summary: (body) => list(body?.indexes ?? [], (i) => i.name),
      },
    },
  },

  posthog: {
    name: "PostHog",
    category: "development",
    authType: "apiKey",
    description: "Your PostHog user.",
    help: "Personal API key. Optional host defaults to https://us.posthog.com.",
    fields: [
      { id: "token", label: "Personal API key", secret: true },
      { id: "site", label: "Host URL (optional)", secret: false, optional: true },
    ],
    auth: async (fields) => ({ Authorization: `Bearer ${text(fields.token)}` }),
    verify: {
      url: (fields) =>
        `${text(fields.site || "https://us.posthog.com").replace(/\/+$/, "")}/api/users/@me/`,
      account: (body) => body?.email || body?.distinct_id,
    },
    actions: {
      projects: {
        label: "Projects",
        risk: "safe",
        request: (fields) => ({
          url: `${text(fields.site || "https://us.posthog.com").replace(/\/+$/, "")}/api/projects/`,
        }),
        summary: (body) => list(body?.results ?? [], (p) => p.name),
      },
    },
  },

  tmdb: {
    name: "TMDB",
    category: "notes",
    authType: "apiKey",
    description: "The Movie Database configuration (public API key).",
    help: "API key from themoviedb.org/settings/api (v3). Not a social poster.",
    fields: [{ id: "token", label: "API key", secret: true }],
    auth: async () => ({}),
    verify: {
      url: (fields) =>
        `https://api.themoviedb.org/3/configuration?api_key=${encodeURIComponent(text(fields.token))}`,
      account: () => "tmdb",
    },
    actions: {
      trending: {
        label: "Trending movies",
        risk: "safe",
        request: (fields) => ({
          url: `https://api.themoviedb.org/3/trending/movie/day?api_key=${encodeURIComponent(text(fields.token))}`,
        }),
        summary: (body) => list(body?.results ?? [], (m) => m.title),
      },
    },
  },

  devto: {
    name: "DEV.to",
    category: "notes",
    authType: "apiKey",
    description: "Your DEV.to user and articles.",
    help: "API key from dev.to/settings/extensions.",
    fields: [{ id: "token", label: "API key", secret: true }],
    auth: async (fields) => ({ "api-key": text(fields.token) }),
    verify: {
      url: "https://dev.to/api/users/me",
      account: (body) => body?.username || body?.name,
    },
    actions: {
      articles: {
        label: "My articles",
        risk: "safe",
        request: () => ({ url: "https://dev.to/api/articles/me?per_page=10" }),
        summary: (body) => list(Array.isArray(body) ? body : [], (a) => a.title),
      },
    },
  },

  hashnode: {
    name: "Hashnode",
    category: "notes",
    authType: "apiKey",
    description: "Your Hashnode user via GraphQL.",
    help: "Personal access token from Hashnode Developer settings.",
    fields: [{ id: "token", label: "Personal access token", secret: true }],
    auth: async (fields) => ({
      Authorization: `Bearer ${text(fields.token)}`,
      "content-type": "application/json",
    }),
    verify: {
      url: "https://gql.hashnode.com",
      method: "POST",
      body: JSON.stringify({ query: "{ me { username name } }" }),
      account: (body) => body?.data?.me?.username || body?.data?.me?.name,
      failed: (body) => (body?.errors?.length ? body.errors[0]?.message : null),
    },
    actions: {
      posts: {
        label: "Recent posts",
        risk: "safe",
        request: () => ({
          url: "https://gql.hashnode.com",
          method: "POST",
          body: JSON.stringify({
            query:
              "{ me { publications(first: 1) { edges { node { posts(first: 10) { edges { node { title } } } } } } } }",
          }),
        }),
        summary: (body) =>
          list(
            body?.data?.me?.publications?.edges?.[0]?.node?.posts?.edges ?? [],
            (e) => e.node?.title,
          ),
      },
    },
  },

  zotero: {
    name: "Zotero",
    category: "notes",
    authType: "apiKey",
    description: "Your Zotero key and library items.",
    help: "Private key from zotero.org/settings/keys. User id is read from /keys/current.",
    fields: [{ id: "token", label: "API key", secret: true }],
    auth: async (fields) => ({ "Zotero-API-Key": text(fields.token) }),
    verify: {
      url: "https://api.zotero.org/keys/current",
      account: (body) => body?.username || String(body?.userID || "zotero"),
    },
    actions: {
      items: {
        label: "Recent items",
        risk: "safe",
        run: async ({ call }) => {
          const key = await call({ url: "https://api.zotero.org/keys/current" });
          if (!key.ok || !key.body?.userID)
            return { ok: false, error: "Zotero key has no userID." };
          const items = await call({
            url: `https://api.zotero.org/users/${encodeURIComponent(key.body.userID)}/items/top?limit=20`,
          });
          if (!items.ok) return { ok: false, error: "Zotero would not list items." };
          const rows = Array.isArray(items.body) ? items.body : [];
          return {
            ok: true,
            lines: rows.map((row) => row.data?.title || row.key),
            data: rows,
          };
        },
      },
    },
  },

  readwise: {
    name: "Readwise",
    category: "notes",
    authType: "apiKey",
    description: "Your Readwise highlights.",
    help: "Access token from readwise.io/access_token.",
    fields: [{ id: "token", label: "Access token", secret: true }],
    auth: async (fields) => ({ Authorization: `Token ${text(fields.token)}` }),
    verify: {
      url: "https://readwise.io/api/v2/auth/",
      account: () => "readwise",
    },
    actions: {
      highlights: {
        label: "Recent highlights",
        risk: "safe",
        request: () => ({ url: "https://readwise.io/api/v2/highlights/?page_size=20" }),
        summary: (body) => list(body?.results ?? [], (h) => (h.text || "").slice(0, 80)),
      },
    },
  },

  homeassistant: {
    name: "Home Assistant",
    category: "custom",
    authType: "apiKey",
    description: "Your Home Assistant instance (API running probe).",
    help: "Instance URL plus a long-lived access token from your HA profile.",
    fields: [
      { id: "site", label: "Instance URL", secret: false },
      { id: "token", label: "Long-lived token", secret: true },
    ],
    auth: async (fields) => ({ Authorization: `Bearer ${text(fields.token)}` }),
    verify: {
      url: (fields) => `${text(fields.site).replace(/\/+$/, "")}/api/`,
      account: (body) => body?.message || "home assistant",
    },
    actions: {
      states: {
        label: "Entity states",
        risk: "safe",
        request: (fields) => ({ url: `${text(fields.site).replace(/\/+$/, "")}/api/states` }),
        summary: (body) =>
          list(Array.isArray(body) ? body.slice(0, 20) : [], (s) => `${s.entity_id} ${s.state}`),
      },
    },
  },

  shortcut: {
    name: "Shortcut",
    category: "tasks",
    authType: "apiKey",
    description: "Your Shortcut (Clubhouse) member and stories.",
    help: "API token from Shortcut → Settings → API Tokens.",
    fields: [{ id: "token", label: "API token", secret: true }],
    auth: async (fields) => ({ "Shortcut-Token": text(fields.token) }),
    verify: {
      url: "https://api.app.shortcut.com/api/v3/member",
      account: (body) => body?.profile?.mention_name || body?.profile?.name,
    },
    actions: {
      stories: {
        label: "Recent stories",
        risk: "safe",
        request: () => ({
          url: "https://api.app.shortcut.com/api/v3/search/stories",
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query: "is:story", page_size: 20 }),
        }),
        summary: (body) => list(body?.data ?? [], (s) => `sc-${s.id} ${s.name || ""}`),
      },
    },
  },

  coda: {
    name: "Coda",
    category: "notes",
    authType: "apiKey",
    description: "Your Coda user and docs.",
    help: "API token from coda.io/account → API settings.",
    fields: [{ id: "token", label: "API token", secret: true }],
    auth: async (fields) => ({ Authorization: `Bearer ${text(fields.token)}` }),
    verify: {
      url: "https://coda.io/apis/v1/whoami",
      account: (body) => body?.name || body?.loginId,
    },
    actions: {
      docs: {
        label: "List docs",
        risk: "safe",
        request: () => ({ url: "https://coda.io/apis/v1/docs?limit=20" }),
        summary: (body) => list(body?.items ?? [], (d) => d.name),
      },
    },
  },

  smartsheet: {
    name: "Smartsheet",
    category: "notes",
    authType: "apiKey",
    description: "Your Smartsheet user and sheets.",
    help: "API token from Smartsheet Account → Personal Settings → API Access.",
    fields: [{ id: "token", label: "API token", secret: true }],
    auth: async (fields) => ({ Authorization: `Bearer ${text(fields.token)}` }),
    verify: {
      url: "https://api.smartsheet.com/2.0/users/me",
      account: (body) => body?.email || body?.firstName,
    },
    actions: {
      sheets: {
        label: "List sheets",
        risk: "safe",
        request: () => ({ url: "https://api.smartsheet.com/2.0/sheets?includeAll=false" }),
        summary: (body) => list(body?.data ?? [], (s) => s.name),
      },
    },
  },

  vimeo: {
    name: "Vimeo",
    category: "notes",
    authType: "apiKey",
    description: "Your Vimeo user and videos.",
    help: "Personal access token from developer.vimeo.com with public + private video scopes.",
    fields: [{ id: "token", label: "Access token", secret: true }],
    auth: async (fields) => ({
      Authorization: `Bearer ${text(fields.token)}`,
      Accept: "application/vnd.vimeo.*+json;version=3.4",
    }),
    verify: {
      url: "https://api.vimeo.com/me",
      account: (body) => body?.name || body?.link,
    },
    actions: {
      videos: {
        label: "My videos",
        risk: "safe",
        request: () => ({ url: "https://api.vimeo.com/me/videos?per_page=10" }),
        summary: (body) => list(body?.data ?? [], (v) => v.name),
      },
    },
  },

  "azure-devops": {
    name: "Azure DevOps",
    category: "development",
    authType: "apiKey",
    description: "Your Azure DevOps profile and projects.",
    help: "Personal access token with vso.profile and vso.project. Organization is required to list projects.",
    fields: [
      { id: "token", label: "Personal access token", secret: true },
      { id: "org", label: "Organization", secret: false, optional: true },
    ],
    auth: async (fields) => ({
      Authorization: `Basic ${Buffer.from(`:${text(fields.token)}`).toString("base64")}`,
    }),
    verify: {
      url: "https://app.vssps.visualstudio.com/_apis/profile/profiles/me?api-version=7.1-preview.3",
      account: (body) => body?.displayName || body?.emailAddress,
    },
    actions: {
      projects: {
        label: "Projects",
        risk: "safe",
        request: (fields) => ({
          url: `https://dev.azure.com/${encodeURIComponent(text(fields.org))}/_apis/projects?api-version=7.1-preview.4`,
        }),
        summary: (body) => list(body?.value ?? [], (p) => p.name),
      },
    },
  },

  n8n: {
    name: "n8n",
    category: "custom",
    authType: "apiKey",
    description: "An n8n instance via its public REST API.",
    help: "Instance URL plus an API key from n8n Settings → n8n API.",
    fields: [
      { id: "site", label: "Instance URL", secret: false },
      { id: "token", label: "API key", secret: true },
    ],
    auth: async (fields) => ({ "X-N8N-API-KEY": text(fields.token) }),
    verify: {
      url: (fields) => `${text(fields.site).replace(/\/+$/, "")}/api/v1/workflows?limit=1`,
      account: () => "n8n",
    },
    actions: {
      workflows: {
        label: "Workflows",
        risk: "safe",
        request: (fields) => ({
          url: `${text(fields.site).replace(/\/+$/, "")}/api/v1/workflows?limit=20`,
        }),
        summary: (body) => list(body?.data ?? [], (w) => w.name),
      },
    },
  },

  mattermost: {
    name: "Mattermost",
    category: "communication",
    authType: "apiKey",
    description: "Your Mattermost user on one instance.",
    help: "Instance URL plus a personal access token. This is not Slack.",
    fields: [
      { id: "site", label: "Instance URL", secret: false },
      { id: "token", label: "Personal access token", secret: true },
    ],
    auth: async (fields) => ({ Authorization: `Bearer ${text(fields.token)}` }),
    verify: {
      url: (fields) => `${text(fields.site).replace(/\/+$/, "")}/api/v4/users/me`,
      account: (body) => body?.username || body?.email,
    },
    actions: {
      teams: {
        label: "My teams",
        risk: "safe",
        request: (fields) => ({
          url: `${text(fields.site).replace(/\/+$/, "")}/api/v4/users/me/teams`,
        }),
        summary: (body) => list(Array.isArray(body) ? body : [], (t) => t.display_name || t.name),
      },
    },
  },

  postman: {
    name: "Postman",
    category: "development",
    authType: "apiKey",
    description: "Your Postman user and workspaces.",
    help: "API key from Postman → Settings → API keys.",
    fields: [{ id: "token", label: "API key", secret: true }],
    auth: async (fields) => ({ "X-Api-Key": text(fields.token) }),
    verify: {
      url: "https://api.getpostman.com/me",
      account: (body) => body?.user?.username || body?.user?.email,
    },
    actions: {
      workspaces: {
        label: "Workspaces",
        risk: "safe",
        request: () => ({ url: "https://api.getpostman.com/workspaces" }),
        summary: (body) => list(body?.workspaces ?? [], (w) => w.name),
      },
    },
  },

  doppler: {
    name: "Doppler",
    category: "development",
    authType: "apiKey",
    description: "Your Doppler workplace (config names only).",
    help: "Personal token from Doppler → Tokens. FRIDAY lists workplaces; it does not dump secret values.",
    fields: [{ id: "token", label: "Personal token", secret: true }],
    auth: async (fields) => ({ Authorization: `Bearer ${text(fields.token)}` }),
    verify: {
      url: "https://api.doppler.com/v3/workplace",
      account: (body) => body?.workplace?.name || body?.workplace?.slug,
    },
    actions: {
      projects: {
        label: "Projects",
        risk: "safe",
        request: () => ({ url: "https://api.doppler.com/v3/projects" }),
        summary: (body) => list(body?.projects ?? [], (p) => p.name || p.slug),
      },
    },
  },

  neon: {
    name: "Neon",
    category: "development",
    authType: "apiKey",
    description: "Projects in your Neon account.",
    help: "API key from console.neon.tech → Account settings → API keys.",
    fields: [{ id: "token", label: "API key", secret: true }],
    auth: async (fields) => ({ Authorization: `Bearer ${text(fields.token)}` }),
    verify: {
      url: "https://console.neon.tech/api/v2/projects",
      account: (body) => body?.projects?.[0]?.name || "neon",
    },
    actions: {
      projects: {
        label: "Projects",
        risk: "safe",
        request: () => ({ url: "https://console.neon.tech/api/v2/projects" }),
        summary: (body) => list(body?.projects ?? [], (p) => p.name),
      },
    },
  },

  planetscale: {
    name: "PlanetScale",
    category: "development",
    authType: "apiKey",
    description: "Organizations in your PlanetScale account.",
    help: "Service token id and secret from PlanetScale → Settings → Service tokens.",
    fields: [
      { id: "tokenId", label: "Token ID", secret: false },
      { id: "token", label: "Token secret", secret: true },
    ],
    auth: async (fields) => ({ Authorization: `${text(fields.tokenId)}:${text(fields.token)}` }),
    verify: {
      url: "https://api.planetscale.com/v1/organizations",
      account: (body) =>
        (Array.isArray(body) ? body[0]?.name : body?.data?.[0]?.name) || "planetscale",
    },
    actions: {
      orgs: {
        label: "Organizations",
        risk: "safe",
        request: () => ({ url: "https://api.planetscale.com/v1/organizations" }),
        summary: (body) => list(Array.isArray(body) ? body : (body?.data ?? []), (o) => o.name),
      },
    },
  },

  convertkit: {
    name: "Kit (ConvertKit)",
    category: "mail",
    authType: "apiKey",
    description: "Your Kit (ConvertKit) account and forms.",
    help: "API secret from Kit → Settings → Advanced → API secret.",
    fields: [{ id: "token", label: "API secret", secret: true }],
    auth: async () => ({}),
    verify: {
      url: (fields) =>
        `https://api.convertkit.com/v3/account?api_secret=${encodeURIComponent(text(fields.token))}`,
      account: (body) => body?.primary_email_address || body?.name,
    },
    actions: {
      forms: {
        label: "Forms",
        risk: "safe",
        request: (fields) => ({
          url: `https://api.convertkit.com/v3/forms?api_secret=${encodeURIComponent(text(fields.token))}`,
        }),
        summary: (body) => list(body?.forms ?? [], (f) => f.name),
      },
    },
  },

  grafana: {
    name: "Grafana",
    category: "development",
    authType: "apiKey",
    description: "A Grafana instance user (Cloud or self-hosted).",
    help: "Instance URL plus a service account token with Viewer.",
    fields: [
      { id: "site", label: "Instance URL", secret: false },
      { id: "token", label: "Service account token", secret: true },
    ],
    auth: async (fields) => ({ Authorization: `Bearer ${text(fields.token)}` }),
    verify: {
      url: (fields) => `${text(fields.site).replace(/\/+$/, "")}/api/user`,
      account: (body) => body?.email || body?.login,
    },
    actions: {
      dashboards: {
        label: "Search dashboards",
        risk: "safe",
        request: (fields) => ({
          url: `${text(fields.site).replace(/\/+$/, "")}/api/search?type=dash-db&limit=20`,
        }),
        summary: (body) => list(Array.isArray(body) ? body : [], (d) => d.title),
      },
    },
  },

  opsgenie: {
    name: "Opsgenie",
    category: "communication",
    authType: "apiKey",
    description: "Your Opsgenie account and open alerts.",
    help: "API key from Opsgenie → Settings → API key management.",
    fields: [{ id: "token", label: "API key", secret: true }],
    auth: async (fields) => ({ Authorization: `GenieKey ${text(fields.token)}` }),
    verify: {
      url: "https://api.opsgenie.com/v2/account",
      account: (body) => body?.data?.name || body?.data?.userCount,
    },
    actions: {
      alerts: {
        label: "Open alerts",
        risk: "safe",
        request: () => ({ url: "https://api.opsgenie.com/v2/alerts?limit=20&query=status%3Aopen" }),
        summary: (body) => list(body?.data ?? [], (a) => a.message),
      },
    },
  },

  pinboard: {
    name: "Pinboard",
    category: "notes",
    authType: "apiKey",
    description: "Your Pinboard bookmarks.",
    help: "Auth token as username:TOKEN from pinboard.in/settings/password.",
    fields: [{ id: "token", label: "Auth token (user:TOKEN)", secret: true }],
    auth: async () => ({}),
    verify: {
      url: (fields) =>
        `https://api.pinboard.in/v1/user/api_token?auth_token=${encodeURIComponent(text(fields.token))}&format=json`,
      account: () => "pinboard",
    },
    actions: {
      recent: {
        label: "Recent bookmarks",
        risk: "safe",
        request: (fields) => ({
          url: `https://api.pinboard.in/v1/posts/recent?auth_token=${encodeURIComponent(text(fields.token))}&format=json&count=20`,
        }),
        summary: (body) => list(body?.posts ?? [], (p) => p.description || p.href),
      },
    },
  },

  woocommerce: {
    name: "WooCommerce",
    category: "notes",
    authType: "apiKey",
    description: "A WooCommerce store via REST (system status).",
    help: "Store URL plus REST API consumer key and secret. This is not live CMS publish.",
    fields: [
      { id: "site", label: "Store URL", secret: false },
      { id: "key", label: "Consumer key", secret: true },
      { id: "token", label: "Consumer secret", secret: true },
    ],
    auth: async (fields) => ({
      Authorization: `Basic ${Buffer.from(`${text(fields.key)}:${text(fields.token)}`).toString("base64")}`,
    }),
    verify: {
      url: (fields) => `${text(fields.site).replace(/\/+$/, "")}/wp-json/wc/v3/system_status`,
      account: (body) => body?.environment?.site_url || body?.settings?.title || "woocommerce",
    },
    actions: {
      orders: {
        label: "Recent orders",
        risk: "safe",
        request: (fields) => ({
          url: `${text(fields.site).replace(/\/+$/, "")}/wp-json/wc/v3/orders?per_page=10`,
        }),
        summary: (body) =>
          list(Array.isArray(body) ? body : [], (o) => `#${o.id} ${o.status} ${o.total}`),
      },
    },
  },

  mcp: {
    name: "MCP server",
    category: "custom",
    authType: "mcp",
    description:
      "Connect FRIDAY as an MCP client to a local command or a loopback HTTP server and use its tools.",
    help: "Give a launch command (stdio) or a loopback HTTP URL. A public URL is refused. Tools are listed from a real initialize + tools/list handshake. A call uses that list as the allow list. Each call still goes through FRIDAY's approval gate. Tool text stays data.",
    fields: [
      { id: "command", label: "Launch command (stdio)", secret: false, optional: true },
      { id: "url", label: "Server URL (HTTP)", secret: false, optional: true },
      { id: "bearer", label: "Bearer token (optional)", secret: true, optional: true },
    ],
    auth: async () => ({}),
    verify: { url: "mcp://local", account: () => "mcp" },
    actions: {
      tools: {
        label: "List MCP tools",
        risk: "safe",
        run: async ({ fields, params, fetchImpl }) => {
          const listed = await mcpClient.listFromConfig({
            command: text(fields.command),
            url: text(fields.url),
            bearer: text(fields.bearer),
            cwd: text(params.cwd) || undefined,
            fetchImpl,
          });
          if (!listed.ok) return listed;
          return {
            ok: true,
            lines: listed.tools.map(
              (t) => `${t.name}${t.description ? ` — ${t.description}` : ""}`,
            ),
            data: listed,
          };
        },
      },
    },
  },

  "custom-http": {
    name: "Custom HTTP API",
    category: "custom",
    authType: "apiKey",
    description: "Any service with a bearer token — FRIDAY verifies it against a URL you give her.",
    help: "Point the check URL at an endpoint that returns 200 for a valid token.",
    fields: [
      { id: "baseUrl", label: "Check URL", secret: false },
      { id: "token", label: "Bearer token", secret: true },
    ],
    auth: async (fields) => ({ Authorization: `Bearer ${text(fields.token)}` }),
    verify: { url: (fields) => text(fields.baseUrl), account: () => "custom endpoint" },
    actions: {
      get: {
        label: "GET a path",
        risk: "safe",
        inputs: ["url"],
        request: (fields, params) => ({ url: text(params.url || fields.baseUrl) }),
        summary: (body) => [
          typeof body === "string" ? body.slice(0, 400) : JSON.stringify(body).slice(0, 400),
        ],
      },
    },
  },
};

/* ------------------------------------------------------------------ state */

const stateFile = (root) => (root ? path.join(root, STATE_FILE) : null);

function readState(root) {
  const file = stateFile(root);
  if (!file) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

function writeStateFile(root, value) {
  const file = stateFile(root);
  if (!file) return false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

const EXTRA_SECRETS = ["accessToken", "refreshToken"];

/** Public (non-secret) fields from disk + secret fields from the secret store. */
function loadFields(root, id) {
  const spec = CONNECTORS[id];
  if (!spec) return null;
  const stored = readState(root)[id] || {};
  const fields = {};
  for (const field of spec.fields) {
    fields[field.id] = field.secret
      ? credentials.getSecret(root, SECRET_ID(id, field.id))
      : text(stored.fields?.[field.id]);
  }
  for (const extra of EXTRA_SECRETS) {
    const value = credentials.getSecret(root, SECRET_ID(id, extra));
    if (value) fields[extra] = value;
  }
  return fields;
}

function requiredFields(spec) {
  return (spec.fields || []).filter((f) => !f.optional);
}

const complete = (spec, fields) => {
  const type = spec.authType || "apiKey";
  if (type === "oauth") {
    return Boolean(
      text(fields?.accessToken).trim() ||
      text(fields?.token).trim() ||
      text(fields?.refreshToken).trim(),
    );
  }
  if (type === "mcp") {
    return Boolean(text(fields?.command).trim() || text(fields?.url).trim());
  }
  return requiredFields(spec).every((f) => text(fields?.[f.id]).trim().length > 0);
};

async function readBody(res) {
  const raw = await res.text().catch(() => "");
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/* ---------------------------------------------------------------- requests */

async function send(spec, fields, request, fetchImpl) {
  const url = typeof request.url === "function" ? request.url(fields) : request.url;
  if (!url) throw new Error("This connector has no endpoint configured.");
  const method = request.method || "GET";
  const rawBody = typeof request.body === "function" ? request.body(fields) : request.body;
  const headers = {
    ...(await spec.auth(fields, fetchImpl, { url, method, body: rawBody })),
    ...(request.headers || {}),
  };
  const init = { method, headers };
  if (rawBody) init.body = rawBody;
  const started = Date.now();
  const res = await fetchImpl(url, init);
  const body = await readBody(res);
  return { res, body, ms: Date.now() - started };
}

/**
 * A real authenticated call. Nothing is ever reported as connected on the
 * strength of a stored token alone — this is the only thing that can say yes.
 */
async function probe(id, fields, fetchImpl = fetchCompat) {
  const spec = CONNECTORS[id];
  if (!spec) return { ok: false, error: "Unknown connector." };
  if (spec.authType === "mcp") {
    const listed = await mcpClient.listFromConfig({
      command: text(fields.command),
      url: text(fields.url),
      bearer: text(fields.bearer),
      fetchImpl,
    });
    if (!listed.ok) return listed;
    return {
      ok: true,
      account: listed.serverName || "MCP server",
      mcpTools: listed.tools,
      ms: 0,
    };
  }
  if (!complete(spec, fields) && spec.authType !== "phone") {
    return { ok: false, error: "Fill in every field first." };
  }
  if (spec.authType === "phone") {
    if (!text(fields.accountSid) || !text(fields.authToken)) {
      return { ok: false, error: "Account SID and auth token are required." };
    }
  }
  try {
    const { res, body, ms } = await send(spec, fields, spec.verify, fetchImpl);
    if (!res.ok) {
      const detail =
        typeof body === "string"
          ? body.slice(0, 200)
          : body?.message || body?.error_description || body?.error;
      return {
        ok: false,
        error:
          res.status === 401 || res.status === 403
            ? `${spec.name} rejected these credentials.`
            : `${spec.name} answered ${res.status}${detail ? ` — ${text(detail).slice(0, 160)}` : ""}.`,
      };
    }
    // Some providers answer 200 with an error payload (Slack, GraphQL APIs).
    const failed = spec.verify.failed ? spec.verify.failed(body) : null;
    if (failed) return { ok: false, error: `${spec.name} rejected these credentials — ${failed}` };
    return { ok: true, account: text(spec.verify.account?.(body) || "").slice(0, 120), ms };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

/* -------------------------------------------------------------- public api */

function describe(root, id) {
  const spec = CONNECTORS[id];
  const stored = readState(root)[id] || {};
  const fields = root ? loadFields(root, id) : null;
  const mcpTools = Array.isArray(stored.mcpTools) ? stored.mcpTools : [];
  const actions = Object.entries(spec.actions).map(([actionId, action]) => ({
    id: actionId,
    label: action.label,
    risk: action.risk,
    inputs: action.inputs || [],
  }));
  for (const tool of mcpTools) {
    const slug = `mcp:${tool.name}`;
    if (actions.some((a) => a.id === slug)) continue;
    actions.push({
      id: slug,
      label: tool.name,
      risk: /delete|write|send|create|remove|exec|shell/i.test(
        `${tool.name} ${tool.description || ""}`,
      )
        ? "exec"
        : "write",
      inputs: ["arguments"],
    });
  }
  return {
    id,
    name: spec.name,
    category: spec.category,
    authType: spec.authType || "apiKey",
    description: spec.description,
    help: spec.help,
    fields: spec.fields.map((f) => ({ ...f, value: f.secret ? "" : text(fields?.[f.id]) })),
    actions,
    configured: Boolean(fields && complete(spec, fields)),
    connected: Boolean(stored.connected),
    account: text(stored.account),
    lastVerifiedAt: Number(stored.lastVerifiedAt || 0),
    lastError: text(stored.lastError),
  };
}

/** Every connector with its real, last-verified state. Never guesses. */
function listConnectors(root) {
  return {
    ok: true,
    root: root || null,
    connectors: Object.keys(CONNECTORS).map((id) => describe(root, id)),
  };
}

function persist(root, id, patch) {
  const state = readState(root);
  state[id] = { ...(state[id] || {}), ...patch };
  writeStateFile(root, state);
}

function mergeFields(root, id, values = {}) {
  const spec = CONNECTORS[id];
  const existing = loadFields(root, id) || {};
  const fields = {};
  for (const field of spec.fields) {
    const next = text(values[field.id]).trim();
    fields[field.id] = next || text(existing[field.id]);
  }
  for (const extra of EXTRA_SECRETS) {
    const next = text(values[extra]).trim();
    fields[extra] = next || text(existing[extra]);
  }
  return fields;
}

function saveSpecFields(root, id, fields) {
  const spec = CONNECTORS[id];
  const publicFields = {};
  for (const field of spec.fields) {
    if (field.secret) {
      const saved = credentials.setSecret(root, SECRET_ID(id, field.id), text(fields[field.id]));
      if (!saved.ok) return saved;
    } else publicFields[field.id] = text(fields[field.id]);
  }
  persist(root, id, { fields: publicFields });
  return { ok: true, publicFields };
}

function incompleteMessage(spec) {
  if (spec.authType === "oauth") {
    return `Paste a token, or click Connect with ${spec.name}.`;
  }
  if (spec.authType === "mcp") return "Give a launch command or a server URL.";
  return "Fill in every field first.";
}

function connectionPatch(spec, verified) {
  const patch = {
    connected: true,
    account: verified.account || "",
    lastError: "",
    connectedAt: Date.now(),
    lastVerifiedAt: Date.now(),
  };
  if (spec.authType === "mcp") patch.mcpTools = verified.mcpTools || [];
  return patch;
}

function tokensFromPayload(payload) {
  if (payload && typeof payload === "object") {
    return {
      accessToken: text(payload.access_token),
      refreshToken: text(payload.refresh_token),
      refused: payload.ok === false,
      error: text(payload.error_description || payload.error),
    };
  }
  if (typeof payload === "string" && /access_token=/.test(payload)) {
    const params = new URLSearchParams(payload);
    return {
      accessToken: text(params.get("access_token")),
      refreshToken: text(params.get("refresh_token")),
      refused: Boolean(params.get("error")),
      error: text(params.get("error_description") || params.get("error")),
    };
  }
  return {
    accessToken: "",
    refreshToken: "",
    refused: true,
    error: "The provider did not return tokens.",
  };
}

function defaultOpenExternal(url) {
  try {
    const electron = require("electron");
    if (electron?.shell?.openExternal) return electron.shell.openExternal(url);
  } catch {
    /* tests and non-Electron hosts inject openExternal */
  }
  return Promise.reject(new Error("Could not open a browser for OAuth login."));
}

/** Save + verify. Credentials are only stored once the provider accepted them. */
async function connect(root, id, values = {}, fetchImpl = fetchCompat) {
  const spec = CONNECTORS[id];
  if (!spec) return { ok: false, error: "Unknown connector." };
  if (!root) return { ok: false, error: "No FRIDAY workspace is selected." };

  const fields = mergeFields(root, id, values);
  if (!complete(spec, fields) && spec.authType !== "phone") {
    return { ok: false, error: incompleteMessage(spec) };
  }
  if (spec.authType === "phone") {
    const stored = readState(root)[id] || {};
    if (!stored.phoneVerified) {
      return {
        ok: false,
        error:
          "Send the SMS code to that number, then confirm it. FRIDAY will not mark Twilio connected on credentials alone.",
      };
    }
  }

  googleTokens.delete(id);
  const verified = await probe(id, fields, fetchImpl);
  if (!verified.ok) {
    persist(root, id, {
      connected: false,
      lastError: verified.error,
      lastVerifiedAt: Date.now(),
      ...(spec.authType === "mcp" ? { mcpTools: [] } : {}),
    });
    return verified;
  }

  const saved = saveSpecFields(root, id, fields);
  if (!saved.ok) return saved;
  persist(root, id, connectionPatch(spec, verified));
  return { ok: true, account: verified.account || "", connector: describe(root, id) };
}

/**
 * Interactive authorization-code login. Opens the provider URL, captures the
 * loopback redirect, exchanges the real code, then probes before Connected.
 */
async function startOAuth(root, id, values = {}, options = {}) {
  const spec = CONNECTORS[id];
  if (!spec) return { ok: false, error: "Unknown connector." };
  if (spec.authType !== "oauth" || !spec.oauth) {
    return { ok: false, error: `${spec?.name || id} does not support interactive OAuth.` };
  }
  if (!root) return { ok: false, error: "No FRIDAY workspace is selected." };

  const fetchImpl = options.fetchImpl || fetchCompat;
  const openExternal = options.openExternal || defaultOpenExternal;
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 180_000;

  const fields = mergeFields(root, id, values);
  const clientId = text(fields.clientId).trim();
  if (!clientId) return { ok: false, error: "Give the OAuth client id first." };
  if (spec.oauth.clientSecret && !text(fields.clientSecret).trim()) {
    return { ok: false, error: "Give the OAuth client secret first." };
  }

  const saved = saveSpecFields(root, id, fields);
  if (!saved.ok) return saved;

  let listener;
  try {
    listener = await oauthLoopback.listen({
      port: oauthLoopback.DEFAULT_PORT,
      timeoutMs,
    });
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }

  const redirectUri = listener.redirectUri;
  const pkce = spec.oauth.pkce ? oauthLoopback.pkcePair() : null;
  const state = oauthLoopback.randomState();
  const scopeKey = spec.oauth.scopeParam || "scope";
  const authorize = oauthLoopback.authorizeUrl(spec.oauth.authorizeUrl, {
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    state,
    ...(spec.oauth.scopes ? { [scopeKey]: spec.oauth.scopes } : {}),
    ...(pkce ? { code_challenge: pkce.challenge, code_challenge_method: pkce.method } : {}),
    ...(spec.oauth.extraAuth || {}),
  });

  try {
    await openExternal(authorize);
  } catch (error) {
    await listener.close();
    return { ok: false, error: String(error?.message || error) };
  }

  let captured;
  try {
    captured = await listener.wait();
  } catch (error) {
    await listener.close();
    persist(root, id, {
      connected: false,
      lastError: String(error?.message || error),
      lastVerifiedAt: Date.now(),
    });
    return { ok: false, error: String(error?.message || error) };
  }
  await listener.close();

  if (text(captured.state) !== state) {
    persist(root, id, {
      connected: false,
      lastError: "OAuth state mismatch. Try Connect again.",
      lastVerifiedAt: Date.now(),
    });
    return { ok: false, error: "OAuth state mismatch. Try Connect again." };
  }

  const tokenBody = {
    grant_type: "authorization_code",
    code: captured.code,
    redirect_uri: redirectUri,
    client_id: clientId,
  };
  if (pkce) tokenBody.code_verifier = pkce.verifier;
  if (text(fields.clientSecret)) tokenBody.client_secret = text(fields.clientSecret);

  const headers = { ...(spec.oauth.tokenHeaders || {}) };
  if (spec.oauth.tokenBasic && text(fields.clientSecret)) {
    headers.Authorization = `Basic ${Buffer.from(`${clientId}:${text(fields.clientSecret)}`).toString("base64")}`;
    delete tokenBody.client_secret;
  }

  let payload;
  try {
    payload = await oauthLoopback.exchangeCode({
      tokenUrl: spec.oauth.tokenUrl,
      body: tokenBody,
      headers,
      fetchImpl,
    });
  } catch (error) {
    persist(root, id, {
      connected: false,
      lastError: String(error?.message || error),
      lastVerifiedAt: Date.now(),
    });
    return { ok: false, error: String(error?.message || error) };
  }

  const tokens = tokensFromPayload(payload);
  if (tokens.refused || !tokens.accessToken) {
    const error = tokens.error || "The provider did not return an access token.";
    persist(root, id, { connected: false, lastError: error, lastVerifiedAt: Date.now() });
    return { ok: false, error };
  }

  const accessSaved = credentials.setSecret(root, SECRET_ID(id, "accessToken"), tokens.accessToken);
  if (!accessSaved.ok) return accessSaved;
  if (tokens.refreshToken) {
    const refreshSaved = credentials.setSecret(
      root,
      SECRET_ID(id, "refreshToken"),
      tokens.refreshToken,
    );
    if (!refreshSaved.ok) return refreshSaved;
  }

  googleTokens.delete(id);
  const probedFields = loadFields(root, id);
  const verified = await probe(id, probedFields, fetchImpl);
  if (!verified.ok) {
    persist(root, id, { connected: false, lastError: verified.error, lastVerifiedAt: Date.now() });
    return verified;
  }
  persist(root, id, connectionPatch(spec, verified));
  return { ok: true, account: verified.account || "", connector: describe(root, id) };
}

async function twilioVerifyPost(fields, pathSuffix, body, fetchImpl) {
  const service = text(fields.verifyServiceSid).trim();
  const url = `https://verify.twilio.com/v2/Services/${encodeURIComponent(service)}/${pathSuffix}`;
  const headers = {
    ...(await CONNECTORS.twilio.auth(fields)),
    "content-type": "application/x-www-form-urlencoded",
  };
  const res = await fetchImpl(url, {
    method: "POST",
    headers,
    body: new URLSearchParams(body).toString(),
  });
  const payload = await readBody(res);
  return { res, payload };
}

/** Real Twilio Verify SMS. Never marks the connector connected. */
async function startPhoneVerify(root, id, values = {}, fetchImpl = fetchCompat) {
  const spec = CONNECTORS[id];
  if (!spec) return { ok: false, error: "Unknown connector." };
  if (spec.authType !== "phone") {
    return { ok: false, error: `${spec.name} does not use phone verification.` };
  }
  if (!root) return { ok: false, error: "No FRIDAY workspace is selected." };

  const fields = mergeFields(root, id, values);
  const phone = text(fields.phone).trim();
  if (
    !text(fields.accountSid) ||
    !text(fields.authToken) ||
    !text(fields.verifyServiceSid) ||
    !phone
  ) {
    return {
      ok: false,
      error: "Account SID, auth token, Verify Service SID, and an E.164 phone number are required.",
    };
  }

  const saved = saveSpecFields(root, id, fields);
  if (!saved.ok) return saved;

  try {
    const { res, payload } = await twilioVerifyPost(
      fields,
      "Verifications",
      { To: phone, Channel: "sms" },
      fetchImpl,
    );
    const status = text(payload?.status).toLowerCase();
    if (!res.ok || (status && status !== "pending")) {
      const detail =
        payload?.message ||
        payload?.error_message ||
        (typeof payload === "string" ? payload.slice(0, 160) : "");
      persist(root, id, {
        connected: false,
        phoneVerified: false,
        lastError: detail || `Twilio Verify answered ${res.status}.`,
        lastVerifiedAt: Date.now(),
      });
      return {
        ok: false,
        error: detail || `Twilio Verify answered ${res.status}.`,
      };
    }
    persist(root, id, {
      connected: false,
      phoneVerified: false,
      pendingPhone: phone,
      lastError: "",
      lastVerifiedAt: Date.now(),
    });
    return { ok: true, pending: true, status: status || "pending", connector: describe(root, id) };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

/** Confirm the real SMS code. Connected only after Twilio status is approved and account probe succeeds. */
async function confirmPhone(root, id, values = {}, fetchImpl = fetchCompat) {
  const spec = CONNECTORS[id];
  if (!spec) return { ok: false, error: "Unknown connector." };
  if (spec.authType !== "phone") {
    return { ok: false, error: `${spec.name} does not use phone verification.` };
  }
  if (!root) return { ok: false, error: "No FRIDAY workspace is selected." };

  const fields = mergeFields(root, id, values);
  const stored = readState(root)[id] || {};
  const phone = text(values.phone || fields.phone || stored.pendingPhone).trim();
  const code = text(values.code).trim();
  if (!phone || !code) return { ok: false, error: "Give the phone number and the SMS code." };
  if (!text(fields.accountSid) || !text(fields.authToken) || !text(fields.verifyServiceSid)) {
    return { ok: false, error: "Account SID, auth token, and Verify Service SID are required." };
  }

  try {
    const { res, payload } = await twilioVerifyPost(
      fields,
      "VerificationCheck",
      { To: phone, Code: code },
      fetchImpl,
    );
    const status = text(payload?.status).toLowerCase();
    if (!res.ok || status !== "approved") {
      persist(root, id, {
        connected: false,
        phoneVerified: false,
        lastError: "That code was not approved.",
        lastVerifiedAt: Date.now(),
      });
      return { ok: false, error: "That code was not approved." };
    }
    persist(root, id, {
      phoneVerified: true,
      pendingPhone: phone,
      connected: false,
      lastError: "",
    });
    return connect(root, id, { ...values, phone }, fetchImpl);
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

function disconnect(root, id) {
  const spec = CONNECTORS[id];
  if (!spec) return { ok: false, error: "Unknown connector." };
  if (!root) return { ok: false, error: "No FRIDAY workspace is selected." };
  for (const field of spec.fields) {
    if (field.secret) credentials.setSecret(root, SECRET_ID(id, field.id), "");
  }
  for (const extra of EXTRA_SECRETS) {
    credentials.setSecret(root, SECRET_ID(id, extra), "");
  }
  const state = readState(root);
  delete state[id];
  writeStateFile(root, state);
  googleTokens.delete(id);
  return { ok: true, id };
}

/** Re-run the real authenticated check for a stored connection. */
async function verifyConnector(root, id, fetchImpl = fetchCompat) {
  const fields = loadFields(root, id);
  if (!fields) return { ok: false, error: "Unknown connector." };
  const spec = CONNECTORS[id];
  const result = await probe(id, fields, fetchImpl);
  persist(root, id, {
    connected: result.ok,
    account: result.ok ? result.account || "" : "",
    lastError: result.ok ? "" : result.error,
    lastVerifiedAt: Date.now(),
    ...(spec.authType === "mcp" ? { mcpTools: result.ok ? result.mcpTools || [] : [] } : {}),
  });
  return { ...result, connector: describe(root, id) };
}

async function callMcpAction(root, id, actionId, params, fields, fetchImpl) {
  const name = String(actionId).slice(4);
  if (!name) return { ok: false, error: "MCP tool name is missing." };
  let args = params.arguments;
  if (typeof args === "string" && args.trim()) {
    try {
      args = JSON.parse(args);
    } catch {
      return { ok: false, error: "MCP arguments must be a JSON object." };
    }
  }
  if (args == null) args = {};
  if (typeof args !== "object" || Array.isArray(args)) {
    return { ok: false, error: "MCP arguments must be a JSON object." };
  }
  const saved = readState(root)[id] || {};
  const allow = Array.isArray(saved.mcpTools)
    ? saved.mcpTools.map((tool) => (typeof tool === "string" ? tool : tool?.name)).filter(Boolean)
    : [];
  if (!allow.length) {
    return { ok: false, error: "List this server's tools before calling one." };
  }
  const started = Date.now();
  const out = await mcpClient.callFromConfig(
    {
      command: text(fields.command),
      url: text(fields.url),
      bearer: text(fields.bearer),
      fetchImpl,
      allow,
    },
    name,
    args,
  );
  if (!out.ok) {
    persist(root, id, { lastError: `${actionId}: ${text(out.error)}`.slice(0, 200) });
    return { ok: false, error: text(out.error) || "The MCP server refused the call." };
  }
  persist(root, id, { lastError: "", lastUsedAt: Date.now() });
  const content = Array.isArray(out.result?.content) ? out.result.content : [];
  const lines = content
    .map((part) => (part?.type === "text" ? text(part.text) : JSON.stringify(part)))
    .filter(Boolean);
  return {
    ok: true,
    id,
    action: actionId,
    label: name,
    ms: Date.now() - started,
    lines: lines.length ? lines : ["(MCP returned no text)"],
    data: out.result,
  };
}

/** Run one declared action. The caller owns approval for non-safe actions. */
async function callConnector(root, id, actionId, params = {}, fetchImpl = fetchCompat) {
  const spec = CONNECTORS[id];
  if (!spec) return { ok: false, error: "Unknown connector." };
  const fields = loadFields(root, id);
  const stored = readState(root)[id] || {};
  if (!complete(spec, fields) || !stored.connected) {
    return { ok: false, error: `${spec.name} is not connected.` };
  }
  if (spec.authType === "mcp" && String(actionId).startsWith("mcp:")) {
    try {
      return await callMcpAction(root, id, actionId, params, fields, fetchImpl);
    } catch (error) {
      return { ok: false, error: String(error?.message || error) };
    }
  }
  const action = spec.actions[actionId];
  if (!action) return { ok: false, error: `${spec.name} has no "${actionId}" action.` };
  try {
    // Actions that need more than one request (e.g. GitHub's Contents API,
    // which reads the current blob sha before it can update a file) declare a
    // `run` handler and drive the SAME authenticated send() through `call`.
    if (typeof action.run === "function") {
      const started = Date.now();
      const call = async (request) => {
        const { res, body } = await send(spec, fields, request, fetchImpl);
        return { ok: res.ok, status: res.status, body };
      };
      const out = await action.run({ fields, params, call, fetchImpl });
      if (!out?.ok) {
        persist(root, id, { lastError: `${actionId}: ${text(out?.error)}`.slice(0, 200) });
        return { ok: false, error: text(out?.error) || `${spec.name} refused the call.` };
      }
      persist(root, id, { lastError: "", lastUsedAt: Date.now() });
      return {
        ok: true,
        id,
        action: actionId,
        label: action.label,
        ms: Date.now() - started,
        lines: out.lines || [],
        data: out.data,
      };
    }
    const { res, body, ms } = await send(spec, fields, action.request(fields, params), fetchImpl);
    if (!res.ok) {
      const detail = typeof body === "string" ? body : body?.message || body?.error;
      persist(root, id, { lastError: `${actionId}: ${res.status}` });
      return {
        ok: false,
        error: `${spec.name} answered ${res.status}${detail ? ` — ${text(detail).slice(0, 160)}` : ""}.`,
      };
    }
    const failed = spec.verify.failed ? spec.verify.failed(body) : null;
    if (failed) return { ok: false, error: `${spec.name} refused the call — ${failed}` };
    const lines = action.summary(body) || [];
    persist(root, id, { lastError: "", lastUsedAt: Date.now() });
    return { ok: true, id, action: actionId, label: action.label, ms, lines, data: body };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

module.exports = {
  CONNECTORS,
  listConnectors,
  connect,
  disconnect,
  verifyConnector,
  callConnector,
  probe,
  loadFields,
  startOAuth,
  startPhoneVerify,
  confirmPhone,
};
