/**
 * Outside benchmarks (GAIA, SWE-bench Verified and the others) are run by the owner, with his keys and a spend
 * cap. This panel does not run them. It checks, before he starts, that a run could not touch the product or his
 * data (`checkExternalSetup`) and lists exactly what is missing, so "ready" is a fact and not a hope.
 */
import { useMemo, useState } from "react";
import { FolderOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { HudPanel, StatusPill } from "@/components/friday/ui";
import { modelRegistry } from "@/lib/friday/brain/model-registry";
import { pickFolder, useWorkspaceRootState } from "@/lib/friday/desktop";
import { EXTERNAL_BENCHMARKS, checkExternalSetup } from "@/lib/friday/self/external-eval";

export function ExternalReadinessPanel() {
  const root = useWorkspaceRootState() ?? "";
  const [dataDir, setDataDir] = useState("");
  const [resultsDir, setResultsDir] = useState("");
  const [cap, setCap] = useState("");
  const [terms, setTerms] = useState(false);
  const keysPresent = useMemo(
    () => modelRegistry.available().some((record) => record.kind === "cloud"),
    [],
  );
  const capValue = cap.trim() === "" ? null : Number(cap);
  const rows = EXTERNAL_BENCHMARKS.map((spec) => ({
    spec,
    check: checkExternalSetup({
      benchmark: spec.id,
      dataDir,
      resultsDir,
      // The folder FRIDAY keeps its own data in is the workspace root; the checkout is not known to the renderer,
      // so a folder inside FRIDAY's data is the case that can be told here.
      repoRoot: "",
      fridayRoot: root,
      spendCapUsd: capValue !== null && Number.isFinite(capValue) ? capValue : null,
      keysPresent,
      dockerAvailable: false,
      vmAvailable: false,
      datasetTermsAccepted: terms,
    }),
  }));

  const choose = async (set: (value: string) => void) => {
    const folder = await pickFolder();
    if (folder) set(folder);
  };

  return (
    <HudPanel title="Outside benchmarks" hint="what a run would still need">
      <div className="grid gap-2">
        <div className="flex flex-wrap items-center gap-2 text-meta-sm text-muted-foreground">
          <Button size="sm" variant="outline" onClick={() => void choose(setDataDir)}>
            <FolderOpen className="size-4" /> Data folder
          </Button>
          <span className="break-all">{dataDir || "not set"}</span>
          <Button size="sm" variant="outline" onClick={() => void choose(setResultsDir)}>
            <FolderOpen className="size-4" /> Results folder
          </Button>
          <span className="break-all">{resultsDir || "not set"}</span>
        </div>
        <label className="flex flex-wrap items-center gap-2 text-meta-sm text-muted-foreground">
          Spend cap (USD)
          <input
            value={cap}
            onChange={(event) => setCap(event.target.value)}
            inputMode="decimal"
            className="w-24 rounded-md border border-border bg-background px-1 text-data"
            aria-label="Spend cap in US dollars"
          />
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={terms}
              onChange={(event) => setTerms(event.target.checked)}
            />
            I accepted the dataset's access terms myself
          </label>
        </label>
        <ul className="grid gap-2">
          {rows.map(({ spec, check }) => (
            <li key={spec.id} className="grid gap-1">
              <div className="flex items-center gap-2 text-data text-foreground">
                {spec.title}
                <StatusPill
                  label={check.ok ? "could start" : "not ready"}
                  tone={check.ok ? "accent" : "warning"}
                />
              </div>
              {check.ok ? null : (
                <p className="text-meta-sm text-muted-foreground">{check.problems.join("; ")}.</p>
              )}
            </li>
          ))}
        </ul>
        <p className="text-meta-sm text-muted-foreground">
          Docker and a dedicated virtual machine are not detected from here, so a benchmark that
          needs one stays "not ready". Nothing is run or sent from this panel.
        </p>
      </div>
    </HudPanel>
  );
}
