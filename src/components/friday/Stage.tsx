import { ChevronLeft, ChevronRight, Trash2, X } from "lucide-react";
import { stage, type StageItem } from "@/lib/friday/stage";
import { useStage } from "@/lib/friday/use-stage";

/**
 * The presentation surface on FRIDAY's main window. When she needs to show
 * something — a picture, a clip, a file, a table, a chart, a diagram or a
 * longer explanation — it appears here over the console, without disturbing
 * the layout underneath. Closing it returns to the normal view.
 */

function Chart({ series }: { series: NonNullable<StageItem["series"]> }) {
  const max = Math.max(1, ...series.map((s) => Math.abs(s.value)));
  return (
    <div className="flex h-full min-h-40 items-end gap-2 px-1 pt-4">
      {series.map((s) => (
        <div key={s.label} className="flex min-w-0 flex-1 flex-col items-center gap-1">
          <span className="font-mono text-[10px] text-primary/80">{s.value}</span>
          <div
            className="w-full rounded-t-sm bg-primary/60"
            style={{ height: `${Math.max(2, (Math.abs(s.value) / max) * 140)}px` }}
          />
          <span className="w-full truncate text-center text-[10px] text-muted-foreground">
            {s.label}
          </span>
        </div>
      ))}
    </div>
  );
}

function Body({ item }: { item: StageItem }) {
  switch (item.kind) {
    case "image":
      return item.src ? (
        <img
          src={item.src}
          alt={item.title}
          className="max-h-[52vh] w-full rounded-md object-contain"
        />
      ) : null;
    case "video":
      return item.src ? (
        <video src={item.src} controls className="max-h-[52vh] w-full rounded-md" />
      ) : null;
    case "file":
      return (
        <div className="space-y-2 text-xs">
          <p className="font-mono break-all text-primary">{item.fileName ?? item.src}</p>
          {item.body ? <p className="text-muted-foreground">{item.body}</p> : null}
          {item.src ? (
            <a
              href={item.src}
              target="_blank"
              rel="noreferrer"
              className="inline-block rounded-sm border border-primary/30 px-2 py-1 text-[11px] text-primary hover:bg-primary/10"
            >
              Open file
            </a>
          ) : null}
        </div>
      );
    case "table":
      return (
        <div className="overflow-auto">
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr>
                {(item.columns ?? []).map((c) => (
                  <th
                    key={c}
                    className="border-b border-primary/20 px-2 py-1 text-left text-[11px] text-primary/80"
                  >
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(item.rows ?? []).map((row, i) => (
                <tr key={i} className="odd:bg-primary/5">
                  {row.map((cell, j) => (
                    <td key={j} className="px-2 py-1 text-muted-foreground">
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "chart":
      return item.series?.length ? <Chart series={item.series} /> : null;
    case "code":
    case "diagram":
      return (
        <pre className="overflow-auto rounded-md bg-background/60 p-3 font-mono text-[11px] leading-relaxed text-primary/90">
          {item.body}
        </pre>
      );
    default:
      return (
        <p className="text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground">
          {item.body}
        </p>
      );
  }
}

export function Stage() {
  const state = useStage();
  const item = state.items.find((i) => i.id === state.activeId);
  if (!state.open || !item) return null;

  return (
    <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center p-4">
      <div className="hud-panel pointer-events-auto flex max-h-full w-full max-w-3xl flex-col rounded-lg border border-primary/30 bg-sidebar/95 shadow-[0_10px_60px_-10px_var(--color-primary)]">
        <div className="flex items-center justify-between gap-2 border-b border-primary/15 px-3 py-2">
          <div className="min-w-0">
            <p className="truncate text-xs font-medium text-primary">{item.title}</p>
            <p className="font-mono text-[10px] text-muted-foreground">
              {item.source} · {item.kind}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              aria-label="Previous"
              onClick={() => stage.step(-1)}
              className="grid size-6 place-items-center rounded-sm text-muted-foreground hover:text-primary"
            >
              <ChevronLeft className="size-3.5" />
            </button>
            <button
              type="button"
              aria-label="Next"
              onClick={() => stage.step(1)}
              className="grid size-6 place-items-center rounded-sm text-muted-foreground hover:text-primary"
            >
              <ChevronRight className="size-3.5" />
            </button>
            <button
              type="button"
              aria-label="Remove from stage"
              onClick={() => stage.remove(item.id)}
              className="grid size-6 place-items-center rounded-sm text-muted-foreground hover:text-destructive"
            >
              <Trash2 className="size-3.5" />
            </button>
            <button
              type="button"
              aria-label="Close"
              onClick={() => stage.close()}
              className="grid size-6 place-items-center rounded-sm text-muted-foreground hover:text-primary"
            >
              <X className="size-3.5" />
            </button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-3">
          <Body item={item} />
        </div>
      </div>
    </div>
  );
}
