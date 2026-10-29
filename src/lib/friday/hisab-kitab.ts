/**
 * FRIDAY · hisab-kitab (books)
 *
 * Import real rows, categorise them, keep running totals on the persisted
 * ledger (so a restart does not re-parse the file), and report P&L only from
 * those records. Cloud-bound payloads are marked FRIDAY_LEDGER so the existing
 * privacy firewall treats them as SENSITIVE.
 */

import { readLocalState, restoreFromDisk, writeState } from "./persist";
import {
  applyTxn,
  emptyTotals,
  markLedgerPayload,
  parseCsv,
  parsePayeeAsk,
  payeeTotals,
  profitAndLoss,
  rowToTxn,
  type LedgerTotals,
  type MoneyTxn,
} from "./owner-work-logic";

export type HisabState = {
  transactions: MoneyTxn[];
  totals: LedgerTotals;
  lastImportAt: number | null;
  lastSource: string;
};

const STORAGE_KEY = "friday.hisab.v1";
let seq = 0;
const nextId = () => `hk-${Date.now().toString(36)}-${(seq += 1).toString(36)}`;

class HisabKitab {
  private transactions: MoneyTxn[] = [];
  private totals: LedgerTotals = emptyTotals();
  private lastImportAt: number | null = null;
  private lastSource = "";
  private loaded = false;

  private load() {
    if (this.loaded) return;
    this.loaded = true;
    if (typeof window === "undefined") return;
    const local = readLocalState<HisabState>(STORAGE_KEY);
    if (local) this.adopt(local);
    restoreFromDisk<HisabState>(STORAGE_KEY, (disk) => {
      if (disk) this.adopt(disk);
    });
  }

  private adopt(state: HisabState) {
    if (Array.isArray(state.transactions)) this.transactions = state.transactions;
    if (state.totals && typeof state.totals.net === "number") this.totals = state.totals;
    this.lastImportAt = state.lastImportAt ?? null;
    this.lastSource = state.lastSource ?? "";
  }

  private emit() {
    if (typeof window === "undefined") return;
    writeState(STORAGE_KEY, this.getSnapshot());
  }

  reset() {
    this.loaded = true;
    this.transactions = [];
    this.totals = emptyTotals();
    this.lastImportAt = null;
    this.lastSource = "";
    this.emit();
  }

  restore(state: HisabState) {
    this.loaded = true;
    this.adopt(state);
    this.emit();
  }

  getSnapshot(): HisabState {
    this.load();
    return {
      transactions: [...this.transactions],
      totals: { ...this.totals, byCategory: { ...this.totals.byCategory } },
      lastImportAt: this.lastImportAt,
      lastSource: this.lastSource,
    };
  }

  /** Re-importing the same Library file replaces prior rows from that file — never double-count. */
  private replaceLibrarySource(source: string) {
    if (!source.startsWith("library:")) return;
    const before = this.transactions.length;
    this.transactions = this.transactions.filter((txn) => txn.source !== source);
    if (this.transactions.length !== before) this.rebuildTotals();
  }

  /**
   * Parse CSV/TSV text into transactions and fold them into the stored running
   * totals. The spreadsheet may stay in Library; the ledger is the books SOT.
   */
  importCsv(
    text: string,
    source = "csv",
  ): { added: number; skipped: number; totals: LedgerTotals } {
    this.load();
    this.replaceLibrarySource(source);
    const rows = parseCsv(text);
    let added = 0;
    let skipped = 0;
    for (const row of rows) {
      const txn = rowToTxn(row, nextId(), source);
      if (!txn) {
        skipped += 1;
        continue;
      }
      this.transactions.push(txn);
      this.totals = applyTxn(this.totals, txn);
      added += 1;
    }
    this.lastImportAt = Date.now();
    this.lastSource = source;
    this.emit();
    return { added, skipped, totals: this.getSnapshot().totals };
  }

  importRows(rows: Record<string, string>[], source = "rows") {
    this.load();
    this.replaceLibrarySource(source);
    let added = 0;
    for (const row of rows) {
      const txn = rowToTxn(row, nextId(), source);
      if (!txn) continue;
      this.transactions.push(txn);
      this.totals = applyTxn(this.totals, txn);
      added += 1;
    }
    this.lastImportAt = Date.now();
    this.lastSource = source;
    this.emit();
    return { added, totals: this.getSnapshot().totals };
  }

  payeeReport(
    payee: string,
    range?: { from?: string; to?: string },
  ): { text: string; count: number } {
    this.load();
    const needle = String(payee || "").trim();
    if (!needle)
      return { text: "Name the payee. I will not invent a person or a figure.", count: 0 };
    if (!this.transactions.length) {
      return {
        text: "The books are empty — import a statement or attach a CSV/XLSX first. I will not invent figures.",
        count: 0,
      };
    }
    const found = payeeTotals(this.transactions, needle, range);
    if (!found.count) {
      return {
        text: `No imported rows match “${needle}”. I will not invent what ${needle} was paid.`,
        count: 0,
      };
    }
    const window = range?.from || range?.to ? ` (${range.from || "…"} to ${range.to || "…"})` : "";
    return {
      count: found.count,
      text: [
        `${needle}${window} from imported rows only:`,
        `Paid/given ${found.given.toFixed(2)} · Received ${found.received.toFixed(2)} · Net ${found.net.toFixed(2)} · ${found.count} record(s).`,
        found.rows
          .slice(0, 8)
          .map((row) => `${row.date} ${row.side} ${row.amount.toFixed(2)} ${row.payee}`)
          .join("; "),
        "These numbers come from imported rows, not an estimate.",
      ].join("\n"),
    };
  }

  recategorise(id: string, category: string): MoneyTxn | null {
    this.load();
    const txn = this.transactions.find((item) => item.id === id);
    if (!txn) return null;
    txn.category = category.trim().toLowerCase().slice(0, 40) || txn.category;
    this.rebuildTotals();
    this.emit();
    return txn;
  }

  /** Stored running totals for all time — not a fresh walk unless they drifted. */
  runningTotals(): LedgerTotals {
    this.load();
    const check = profitAndLoss(this.transactions);
    if (check.net !== this.totals.net || check.count !== this.totals.count) {
      this.totals = check;
      this.emit();
    }
    return this.getSnapshot().totals;
  }

  report(range?: { from?: string; to?: string }): {
    totals: LedgerTotals;
    fromStoredRunning: boolean;
    count: number;
  } {
    this.load();
    if (!range?.from && !range?.to) {
      return {
        totals: this.runningTotals(),
        fromStoredRunning: true,
        count: this.transactions.length,
      };
    }
    return {
      totals: profitAndLoss(this.transactions, range),
      fromStoredRunning: false,
      count: this.transactions.filter(
        (txn) => (!range.from || txn.date >= range.from) && (!range.to || txn.date <= range.to),
      ).length,
    };
  }

  formatReport(range?: { from?: string; to?: string }): string {
    const { totals, fromStoredRunning, count } = this.report(range);
    if (!count)
      return "The books are empty — import a statement or expense sheet first. I will not invent figures.";
    const cats = Object.entries(totals.byCategory)
      .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
      .slice(0, 8)
      .map(([name, n]) => `${name} ${n.toFixed(2)}`)
      .join("; ");
    return [
      fromStoredRunning
        ? "Profit & loss (from the stored running totals):"
        : "Profit & loss for the dates you asked:",
      `Income ${totals.income.toFixed(2)} · Expense ${totals.expense.toFixed(2)} · Net ${totals.net.toFixed(2)} · ${count} record(s).`,
      cats ? `By category: ${cats}.` : "",
      "These numbers come from imported rows, not an estimate.",
    ]
      .filter(Boolean)
      .join("\n");
  }

  /** Only call this when a model would actually see the books. */
  payloadForModel(): string {
    this.load();
    return markLedgerPayload({
      totals: this.totals,
      sample: this.transactions.slice(0, 40),
    });
  }

  private rebuildTotals() {
    this.totals = profitAndLoss(this.transactions);
  }
}

export const hisab = new HisabKitab();
