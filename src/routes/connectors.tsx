/**
 * FRIDAY · Connectors — her real link to the outside services the owner uses.
 *
 * Everything on this page is real: credentials are stored by the main process
 * in the encrypted credential store, "Connected" only ever appears after a
 * live authenticated call to the provider succeeded, and every action runs
 * against the provider's own API. Write actions go through the same approval
 * gate as the rest of FRIDAY.
 */
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Loader2, Plug, RefreshCw, Search, Trash2, Zap } from "lucide-react";
import { toast } from "sonner";
import { AppShell } from "@/components/friday/AppShell";
import { FilterTabs, HudPanel, StatTile, StatusPill } from "@/components/friday/ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  confirmConnectorPhoneCode,
  connectConnector,
  disconnectConnector,
  runConnectorAction,
  sendConnectorPhoneCode,
  startOAuthConnector,
  useConnectors,
  verifyConnector,
  type Connector,
  type ConnectorAction,
} from "@/lib/friday/connectors";

export const Route = createFileRoute("/connectors")({
  head: () => ({
    meta: [
      { title: "Connectors — FRIDAY Console" },
      {
        name: "description",
        content:
          "Connect FRIDAY to your calendar, notes, code hosts, task tools and storage with verified credentials kept in her encrypted local store.",
      },
      { property: "og:title", content: "Connectors — FRIDAY Console" },
      {
        property: "og:description",
        content: "Verified external service connections for FRIDAY.",
      },
    ],
  }),
  component: ConnectorsPage,
});

function ConnectorCard({ connector, refresh }: { connector: Connector; refresh: () => void }) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(connector.fields.map((f) => [f.id, f.value])),
  );
  const fieldKey = connector.fields.map((f) => `${f.id}:${f.value}`).join("|");
  useEffect(() => {
    setValues(Object.fromEntries(connector.fields.map((f) => [f.id, f.value])));
  }, [connector.id, fieldKey, connector.fields]);
  const [busy, setBusy] = useState<string | null>(null);
  const [output, setOutput] = useState<string[]>([]);
  const [params, setParams] = useState<Record<string, string>>({});
  const [smsCode, setSmsCode] = useState("");
  const authType = connector.authType || "apiKey";

  const save = async () => {
    setBusy("connect");
    const result = await connectConnector(connector.id, values);
    setBusy(null);
    if (result?.ok) {
      toast.success(`${connector.name} verified${result.account ? ` — ${result.account}` : ""}`);
      refresh();
    } else toast.error(result?.error || "Verification failed.");
  };

  const oauth = async () => {
    setBusy("oauth");
    toast.message(`Waiting for ${connector.name} login in the browser…`);
    const result = await startOAuthConnector(connector.id, values);
    setBusy(null);
    if (result?.ok) {
      toast.success(`${connector.name} verified${result.account ? ` — ${result.account}` : ""}`);
      refresh();
    } else toast.error(result?.error || "OAuth login failed.");
  };

  const sendCode = async () => {
    setBusy("phone-send");
    const result = await sendConnectorPhoneCode(connector.id, values);
    setBusy(null);
    if (result?.ok) {
      toast.success("SMS sent. Enter the code from your phone.");
      refresh();
    } else toast.error(result?.error || "Could not send the SMS code.");
  };

  const confirmCode = async () => {
    setBusy("phone-confirm");
    const result = await confirmConnectorPhoneCode(connector.id, { ...values, code: smsCode });
    setBusy(null);
    if (result?.ok) {
      toast.success(`${connector.name} verified${result.account ? ` — ${result.account}` : ""}`);
      setSmsCode("");
      refresh();
    } else toast.error(result?.error || "That code was not approved.");
  };

  const recheck = async () => {
    setBusy("verify");
    const result = await verifyConnector(connector.id);
    setBusy(null);
    if (result?.ok) toast.success(`${connector.name} still connected.`);
    else toast.error(result?.error || "Verification failed.");
    refresh();
  };

  const remove = async () => {
    setBusy("remove");
    const result = await disconnectConnector(connector.id);
    setBusy(null);
    if (result?.ok) {
      setValues(Object.fromEntries(connector.fields.map((f) => [f.id, ""])));
      toast.success(`${connector.name} disconnected.`);
      refresh();
    } else toast.error(result?.error || "Could not disconnect.");
  };

  const run = async (action: ConnectorAction) => {
    setBusy(action.id);
    const result = await runConnectorAction(
      connector,
      action,
      Object.fromEntries(
        action.inputs.map((input) => [input, params[`${action.id}.${input}`] ?? ""]),
      ),
    );
    setBusy(null);
    if (result.ok) {
      setOutput(result.lines?.length ? result.lines : ["(nothing returned)"]);
      toast.success(`${action.label} — ${result.ms ?? 0} ms`);
    } else {
      setOutput([]);
      toast.error(result.error || "The call failed.");
    }
    refresh();
  };

  return (
    <HudPanel
      title={connector.name}
      hint={connector.category}
      actions={
        <StatusPill
          label={
            connector.connected ? "Connected" : connector.configured ? "Not verified" : "Not set up"
          }
          tone={connector.connected ? "accent" : connector.lastError ? "destructive" : "muted"}
        />
      }
    >
      <div className="space-y-3">
        <p className="text-xs text-muted-foreground">{connector.description}</p>
        {connector.connected && connector.account && (
          <p className="text-xs text-success">Signed in as {connector.account}</p>
        )}
        {connector.lastError && <p className="text-xs text-destructive">{connector.lastError}</p>}

        <div className="grid gap-2 sm:grid-cols-2">
          {connector.fields.map((field) => (
            <div key={field.id} className="space-y-1">
              <Label
                className="text-xs text-muted-foreground"
                htmlFor={`${connector.id}.${field.id}`}
              >
                {field.label}
                {field.optional ? " (optional)" : ""}
              </Label>
              <Input
                id={`${connector.id}.${field.id}`}
                type={field.secret ? "password" : "text"}
                autoComplete="off"
                placeholder={field.secret && connector.connected ? "•••••• (stored)" : ""}
                value={values[field.id] ?? ""}
                onChange={(e) => setValues((prev) => ({ ...prev, [field.id]: e.target.value }))}
              />
            </div>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">{connector.help}</p>

        {authType === "phone" && (
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground" htmlFor={`${connector.id}.sms-code`}>
              SMS code
            </Label>
            <Input
              id={`${connector.id}.sms-code`}
              autoComplete="one-time-code"
              placeholder="code from the SMS"
              value={smsCode}
              onChange={(e) => setSmsCode(e.target.value)}
            />
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          {authType === "oauth" && (
            <Button size="sm" disabled={busy !== null} onClick={() => void oauth()}>
              {busy === "oauth" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Plug className="size-4" />
              )}
              Connect with {connector.name}
            </Button>
          )}
          {authType === "phone" && (
            <>
              <Button size="sm" disabled={busy !== null} onClick={() => void sendCode()}>
                {busy === "phone-send" ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Plug className="size-4" />
                )}
                Send SMS code
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy !== null || !smsCode.trim()}
                onClick={() => void confirmCode()}
              >
                {busy === "phone-confirm" ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Zap className="size-4" />
                )}
                Confirm code
              </Button>
            </>
          )}
          {authType !== "phone" && (
            <Button
              size="sm"
              variant={authType === "oauth" ? "outline" : "default"}
              disabled={busy !== null}
              onClick={save}
            >
              {busy === "connect" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Plug className="size-4" />
              )}
              {connector.connected ? "Re-save & verify" : "Connect & verify"}
            </Button>
          )}
          {connector.connected && (
            <Button size="sm" variant="outline" disabled={busy !== null} onClick={recheck}>
              {busy === "verify" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <RefreshCw className="size-4" />
              )}
              Re-check
            </Button>
          )}
          {(connector.connected || connector.configured || Boolean(connector.lastError)) && (
            <Button size="sm" variant="outline" disabled={busy !== null} onClick={remove}>
              <Trash2 className="size-4" /> Disconnect
            </Button>
          )}
        </div>

        {connector.connected && (
          <div className="space-y-2 rounded-md border border-border/60 p-2">
            {connector.actions.map((action) => (
              <div key={action.id} className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy !== null}
                    onClick={() => void run(action)}
                  >
                    {busy === action.id ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Zap className="size-4" />
                    )}
                    {action.label}
                  </Button>
                  {action.risk !== "safe" && <StatusPill label="asks first" tone="warning" />}
                </div>
                {action.inputs.length > 0 && (
                  <div className="grid gap-2 sm:grid-cols-2">
                    {action.inputs.map((input) => (
                      <Input
                        key={input}
                        placeholder={input}
                        value={params[`${action.id}.${input}`] ?? ""}
                        onChange={(e) =>
                          setParams((prev) => ({
                            ...prev,
                            [`${action.id}.${input}`]: e.target.value,
                          }))
                        }
                      />
                    ))}
                  </div>
                )}
              </div>
            ))}
            {output.length > 0 && (
              <ul className="max-h-48 space-y-1 overflow-auto font-mono text-xs text-muted-foreground">
                {output.map((line, index) => (
                  <li key={`${line}-${index}`}>{line}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </HudPanel>
  );
}

function ConnectorsPage() {
  const { connectors, loading, supported, refresh } = useConnectors();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [tab, setTab] = useState("all");
  const counts = useMemo(
    () => ({
      total: connectors.length,
      connected: connectors.filter((c) => c.connected).length,
      failing: connectors.filter((c) => c.lastError).length,
    }),
    [connectors],
  );
  const categories = useMemo(() => {
    const keys = [...new Set(connectors.map((c) => c.category).filter(Boolean))];
    keys.sort();
    return keys;
  }, [connectors]);
  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return connectors.filter((connector) => {
      if (tab === "connected" && !connector.connected) return false;
      if (tab === "open" && connector.connected) return false;
      if (category !== "all" && connector.category !== category) return false;
      if (!needle) return true;
      const hay = `${connector.name} ${connector.id} ${connector.category} ${connector.description} ${connector.authType || ""}`;
      return hay.toLowerCase().includes(needle);
    });
  }, [connectors, query, category, tab]);

  return (
    <AppShell
      title="Connectors"
      subtitle="Verified links to the outside services you use"
      actions={
        <Button size="sm" variant="outline" onClick={() => void refresh()}>
          <RefreshCw className="size-4" /> Refresh
        </Button>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-3 gap-2">
          <StatTile
            icon={<Plug className="size-4" />}
            label="Available"
            value={counts.total}
            state="services"
          />
          <StatTile label="Connected" value={counts.connected} state="verified" tone="accent" />
          <StatTile
            label="Needs attention"
            value={counts.failing}
            state="last call failed"
            tone="warning"
          />
        </div>

        {!supported && (
          <HudPanel title="Desktop only">
            <p className="text-xs text-muted-foreground">
              Connectors store real credentials in FRIDAY&apos;s encrypted local store, so they are
              only available inside the desktop app.
            </p>
          </HudPanel>
        )}

        {loading && <p className="text-xs text-muted-foreground">Reading connector state…</p>}

        <HudPanel
          title="All connectors"
          hint={`${rows.length} shown`}
          actions={
            <FilterTabs
              value={tab}
              onChange={setTab}
              tabs={[
                { key: "all", label: `All (${counts.total})` },
                { key: "connected", label: `Connected (${counts.connected})` },
                { key: "open", label: `Not connected (${counts.total - counts.connected})` },
              ]}
            />
          }
        >
          <div className="mb-3 flex flex-col gap-2">
            <div className="relative max-w-md">
              <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search name, category, or summary…"
                className="h-8 pl-8 font-mono text-xs"
              />
            </div>
            <FilterTabs
              value={category}
              onChange={setCategory}
              tabs={[
                { key: "all", label: "All categories" },
                ...categories.map((key) => ({
                  key,
                  label: `${key} (${connectors.filter((c) => c.category === key).length})`,
                })),
              ]}
            />
          </div>
        </HudPanel>

        <div className="grid gap-3 lg:grid-cols-2">
          {rows.map((connector) => (
            <ConnectorCard
              key={connector.id}
              connector={connector}
              refresh={() => void refresh()}
            />
          ))}
        </div>
      </div>
    </AppShell>
  );
}
