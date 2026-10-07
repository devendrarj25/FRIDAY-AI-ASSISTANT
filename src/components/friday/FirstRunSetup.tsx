import { CheckCircle2, CircleDashed, Loader2, XCircle } from "lucide-react";
import { useState } from "react";
import { FridayOrb } from "@/components/friday/FridayOrb";
import { TitleStrip } from "@/components/friday/TitleStrip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  BOOTSTRAP_MODEL_ID,
  BOOTSTRAP_VOICE_PACKAGES,
  FREE_TIER_PROVIDERS,
  runFirstRunBootstrap,
  skipFirstRun,
  type BootstrapStep,
} from "@/lib/friday/first-run";
import type { ProviderId } from "@/lib/friday/model-catalog";

/**
 * Optional bootstrap UI (keys + llama3.2-3b + voice packages). Kept for
 * Install Manager / Models callers. It is NOT a startup gate — AppShell opens
 * the normal workspace as soon as a folder exists.
 */
export function FirstRunSetup({ onDone }: { onDone: () => void }) {
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [steps, setSteps] = useState<BootstrapStep[]>([]);
  const [busy, setBusy] = useState(false);

  const start = async () => {
    setBusy(true);
    const entries = FREE_TIER_PROVIDERS.filter((p) => (keys[p.id] ?? "").trim()).map((p) => ({
      id: p.id as ProviderId,
      apiKey: keys[p.id] ?? "",
    }));
    await runFirstRunBootstrap({ keys: entries, onStep: setSteps });
    setBusy(false);
    onDone();
  };

  const skip = async () => {
    setBusy(true);
    await skipFirstRun();
    onDone();
  };

  return (
    <div className="flex h-screen w-full flex-col bg-background">
      <TitleStrip />
      <div className="friday-interactive-region flex min-h-0 flex-1 items-center justify-center p-8">
        <div className="w-full max-w-xl space-y-6">
          <div className="flex items-center gap-4">
            <FridayOrb size={64} />
            <div>
              <h1 className="text-xl font-semibold text-foreground">Setting FRIDAY up</h1>
              <p className="text-sm text-muted-foreground">
                This happens once. FRIDAY downloads a small offline chat model ({BOOTSTRAP_MODEL_ID}
                ) and the voice engines ({BOOTSTRAP_VOICE_PACKAGES.join(", ")}) so chat and Auto
                Mode work straight away.
              </p>
            </div>
          </div>

          {!steps.length && (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Optional: paste an API key for a provider with a free tier. Skip any you don&apos;t
                have — the offline model still gets installed.
              </p>
              {FREE_TIER_PROVIDERS.map((provider) => (
                <label key={provider.id} className="block space-y-1">
                  <span className="text-xs text-muted-foreground">
                    {provider.name} — keys at {provider.keysUrl}
                  </span>
                  <Input
                    type="password"
                    autoComplete="off"
                    placeholder={`${provider.name} API key (optional)`}
                    value={keys[provider.id] ?? ""}
                    onChange={(e) =>
                      setKeys((current) => ({ ...current, [provider.id]: e.target.value }))
                    }
                    disabled={busy}
                  />
                </label>
              ))}
            </div>
          )}

          {steps.length > 0 && (
            <ul className="space-y-2 rounded-lg border border-primary/20 p-4">
              {steps.map((step) => (
                <li key={step.id} className="flex items-start gap-2 text-sm">
                  {step.state === "running" ? (
                    <Loader2 className="mt-0.5 size-4 animate-spin text-primary" />
                  ) : step.state === "done" ? (
                    <CheckCircle2 className="mt-0.5 size-4 text-primary" />
                  ) : step.state === "failed" ? (
                    <XCircle className="mt-0.5 size-4 text-destructive" />
                  ) : (
                    <CircleDashed className="mt-0.5 size-4 text-muted-foreground" />
                  )}
                  <span className="flex-1">
                    <span className="text-foreground">{step.label}</span>{" "}
                    <span className="text-muted-foreground">— {step.detail}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}

          <div className="flex gap-3">
            <Button onClick={() => void start()} disabled={busy}>
              {busy ? "Setting up…" : "Set FRIDAY up"}
            </Button>
            <Button variant="ghost" onClick={() => void skip()} disabled={busy}>
              Skip for now
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
