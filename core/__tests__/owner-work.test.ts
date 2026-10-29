/**
 * Real owner-work skills: personal desk, hisab-kitab, tender extract, site/social honesty.
 * Numbers and quotes must come from imported/pasted data — never invented.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { baselineRespond } from "../../src/lib/friday/brain/baseline-responder";
import { listSkills, invokeSkill } from "../../src/lib/friday/brain/skill-forge";
import { capabilityRegistry } from "../../src/lib/friday/brain/capability-registry";
import { personalDesk } from "../../src/lib/friday/personal-desk";
import { hisab } from "../../src/lib/friday/hisab-kitab";
import { memory } from "../../src/lib/friday/self/memory-engine";
import {
  NOTE_TAG,
  LEDGER_MARK,
  SOCIAL_DRAFT_TAG,
  structureAdvice,
  formatAdvice,
  interpretSiteStatus,
} from "../../src/lib/friday/owner-work-logic";
import { describeTender, tenderModelPlan } from "../../src/lib/friday/tender-reader";
import { MARKET_PACKS } from "../../src/lib/friday/marketplace";
import { actionNeedsApproval } from "../../src/lib/friday/brain/action-risk";
import {
  SITE_PLATFORM_NEEDED,
  SOCIAL_UNSUPPORTED,
  cmsConnectHint,
  socialConnectHint,
} from "../../src/lib/friday/owner-work-logic";
import { notifications } from "../../src/lib/friday/notifications";

const privacy = createRequire(import.meta.url)("../../electron/privacy-firewall.cjs");
const extract = createRequire(import.meta.url)("../../electron/document-extract.cjs");

function wipeNotes() {
  for (const item of [...memory.getSnapshot().items]) {
    if (item.tags.includes(NOTE_TAG) || item.tags.includes(SOCIAL_DRAFT_TAG))
      memory.forget(item.id);
  }
}

describe("personal desk", () => {
  beforeEach(() => {
    personalDesk.reset();
    wipeNotes();
  });

  it("persists a task and a reminder without being a demo list", () => {
    const added = baselineRespond("remind me to call the accountant tomorrow");
    expect(added.handled).toBe(true);
    expect(added.text).toMatch(/Tracked: call the accountant/i);
    const listed = baselineRespond("what is on my list");
    expect(listed.text).toMatch(/call the accountant/);
    const snap = personalDesk.getSnapshot();
    personalDesk.reset();
    expect(personalDesk.list()).toHaveLength(0);
    personalDesk.restore(snap);
    expect(personalDesk.list()[0]?.title).toMatch(/call the accountant/);
  });

  it("files and retrieves notes through memory-engine, not a second store", () => {
    baselineRespond("note that: Northwind GST filing uses Form GSTR-3B");
    const found = baselineRespond("find my notes about GST");
    expect(found.text).toMatch(/GSTR-3B/);
    expect(personalDesk.listNotes().every((item) => item.tags.includes(NOTE_TAG))).toBe(true);
  });

  it("summarises only real recorded activity", () => {
    const empty = baselineRespond("daily summary");
    expect(empty.text).toMatch(/no recorded activity/i);
    personalDesk.add("buy toner");
    const filled = baselineRespond("daily summary");
    expect(filled.text).toMatch(/buy toner|task/i);
  });

  it("structures a decision from the owner's words and does not invent advice", () => {
    const frame = structureAdvice("Should I hire a designer or do it myself?");
    expect(frame.options.length).toBe(2);
    expect(frame.fromOwner).toEqual([]);
    expect(formatAdvice(frame)).not.toMatch(/synergy|in my experience|you should definitely/i);
    const withReasons = structureAdvice(
      "Should I hire a designer or do it myself? because hiring is faster but costs more",
    );
    expect(withReasons.fromOwner.some((row) => /faster/i.test(row.text))).toBe(true);
    expect(withReasons.fromOwner.some((row) => /costs more/i.test(row.text))).toBe(true);
  });

  it("fires a due reminder through the existing notification centre", () => {
    const task = personalDesk.add("file GST", Date.now() - 1000);
    const due = personalDesk.fireDueReminders();
    expect(due.map((item) => item.id)).toContain(task.id);
    expect(notifications.getSnapshot().items.some((item) => item.title.includes("file GST"))).toBe(
      true,
    );
    expect(personalDesk.fireDueReminders()).toHaveLength(0);
  });
});

describe("hisab kitab", () => {
  beforeEach(() => hisab.reset());

  it("imports real rows, categorises them, and reports P&L from stored totals", () => {
    const csv = [
      "Date,Description,Amount,Type",
      "2026-04-01,Client invoice Northwind,50000,income",
      "2026-04-03,Office rent April,15000,expense",
      "2026-04-04,Petrol for site visit,2000,expense",
    ].join("\n");
    const reply = baselineRespond(`import these expenses\n${csv}`);
    expect(reply.text).toMatch(/Imported 3 record/);
    expect(reply.text).toMatch(/Income 50000/);
    expect(reply.text).toMatch(/Expense 17000/);
    expect(reply.text).toMatch(/Net 33000/);
    expect(reply.text).toMatch(/rent/);
    expect(reply.text).toMatch(/travel/);

    const stored = hisab.getSnapshot();
    expect(stored.totals.net).toBe(33000);
    hisab.reset();
    hisab.restore(stored);
    const again = hisab.report();
    expect(again.fromStoredRunning).toBe(true);
    expect(again.totals.net).toBe(33000);
    expect(again.totals.count).toBe(3);
  });

  it("reads debit/credit columns without treating description as a debit", () => {
    const csv = [
      "Date,Description,Debit,Credit",
      "2026-04-01,Office rent,15000,",
      "2026-04-02,Client invoice Northwind,,20000",
    ].join("\n");
    const result = hisab.importCsv(csv, "bank");
    expect(result.added).toBe(2);
    expect(result.skipped).toBe(0);
    expect(hisab.report().totals.income).toBe(20000);
    expect(hisab.report().totals.expense).toBe(15000);
    expect(hisab.report().totals.net).toBe(5000);
  });

  it("marks ledger payloads so cloud egress is SENSITIVE every time", () => {
    hisab.importCsv("Date,Description,Amount,Type\n2026-04-01,Sale,100,income");
    const payload = hisab.payloadForModel();
    expect(payload.startsWith(LEDGER_MARK)).toBe(true);
    expect(privacy.classify(payload).level).toBe("sensitive");
    const cloud = privacy.guardEgress({
      model: { type: "cloud", id: "gpt", label: "GPT" },
      content: payload,
      connected: true,
    });
    expect(cloud.requiresConfirmation).toBe(true);
    expect(cloud.reason).toMatch(/SENSITIVE/);
    const local = privacy.guardEgress({
      model: { type: "local", id: "llama" },
      content: payload,
    });
    expect(local.requiresConfirmation).toBe(false);
  });
});

describe("tender / RFP extract", () => {
  const document = `
Tender title: Supply of LED street lamps
Issued by: Northwind Municipal Corporation
Last date: 12 October 2026
Eligibility criteria: Bidder must have GST registration and three similar works. Turnover TBD.
Scope of work: Supply and install 400 LED street lamps in Ward 4.
Submission requirements: Upload the bid on the e-procurement portal in two covers.
Earnest money: Rs 50,000
`;

  it("quotes clauses that are in the document and flags what is missing or vague", () => {
    const text = describeTender(document);
    expect(text).toMatch(/Supply of LED street lamps/);
    expect(text).toMatch(/12 October 2026/);
    expect(text).toMatch(/GST registration/);
    expect(text).toMatch(/Estimated value: not stated/);
    expect(text).toMatch(/unspecified|TBD|unclear/i);
    expect(text).not.toMatch(/Acme Widgets/);
  });

  it("routes the reasoning pass through the existing orchestrator, not the cheapest default", () => {
    const plan = tenderModelPlan();
    expect(plan.steps.map((step) => step.role)).toContain("reasoner");
    expect(plan.notes.some((note) => /local/i.test(note))).toBe(true);
  });
});

describe("website and social — honest about what is actually connected", () => {
  it("refuses to guess a CMS when the platform is not named", () => {
    const reply = baselineRespond("publish this page to my website");
    expect(reply.text).toBe(SITE_PLATFORM_NEEDED);
  });

  it("names WordPress and asks to connect it instead of inventing credentials", () => {
    const reply = baselineRespond("publish this page to wordpress: ward lamps");
    expect(reply.text).toBe(cmsConnectHint("WordPress"));
    expect(reply.action).toBeUndefined();
  });

  it("files a local Instagram draft and asks to connect instead of posting silently", () => {
    wipeNotes();
    const reply = baselineRespond("draft a post to instagram: hello from FRIDAY");
    expect(reply.text).toContain(socialConnectHint("Instagram"));
    expect(reply.text).toMatch(/Filed a local draft/);
    expect(reply.action).toBeUndefined();
    expect(
      personalDesk.listSocialDrafts().some((item) => /hello from FRIDAY/.test(item.text)),
    ).toBe(true);
  });

  it("files a local social draft in memory instead of claiming a silent save", () => {
    wipeNotes();
    const reply = baselineRespond("draft a post: shipping the ward lamps tomorrow");
    expect(reply.text).toMatch(/Filed a local draft/);
    expect(reply.text).toContain(SOCIAL_UNSUPPORTED);
    expect(personalDesk.listSocialDrafts().some((item) => /ward lamps/.test(item.text))).toBe(true);
  });

  it("checks site status through the existing http.fetch tool and formats the real code", () => {
    const reply = baselineRespond("is https://example.com up");
    expect(reply.action?.tool).toBe("http.fetch");
    expect(reply.action?.args["url"]).toBe("https://example.com");
    expect(reply.action?.risk).toBe("write");
    const up = interpretSiteStatus({
      url: "https://example.com",
      status: 200,
      ok: true,
      body: "<title>Example Domain</title>",
    });
    expect(up.up).toBe(true);
    expect(up.note).toMatch(/Example Domain/);
    const down = interpretSiteStatus({ url: "https://example.com", error: "ENOTFOUND" });
    expect(down.up).toBe(false);
    expect(down.note).toMatch(/ENOTFOUND/);
  });

  it("keeps Slack posting behind the existing write/exec approval gate", () => {
    expect(actionNeedsApproval("write", "auto")).toBe(true);
    const source = readFileSync(resolve(__dirname, "../../electron/connectors.cjs"), "utf8");
    expect(source).toContain("conversations.history");
    const post = source.slice(source.indexOf("Post a message"));
    expect(post.slice(0, 400)).toMatch(/risk:\s*"write"/);
  });

  it("does not hardcode skill invocations as safe", () => {
    const source = readFileSync(
      resolve(__dirname, "../../src/lib/friday/brain/baseline-responder.ts"),
      "utf8",
    );
    const block = source.slice(
      source.indexOf("function matchSkill"),
      source.indexOf("function matchAction"),
    );
    expect(block).toContain("hit.risk");
    expect(block).not.toMatch(/risk:\s*"safe"/);
  });
});

describe("registry — one skill list across chat, voice and skill-router", () => {
  beforeEach(() => {
    personalDesk.reset();
    hisab.reset();
    wipeNotes();
  });

  it("exposes owner-work skills without the desktop bridge", async () => {
    const skills = await listSkills();
    expect(skills.map((s) => s.id)).toEqual(
      expect.arrayContaining(["desk.tasks", "hisab.import", "tender.read", "site.status"]),
    );
    const snapshot = capabilityRegistry.refresh();
    expect(snapshot.resources.some((r) => r.ref === "desk.tasks")).toBe(true);
  });

  it("runs hisab.import through invokeSkill with a real parse", async () => {
    const result = await invokeSkill("hisab.import", {
      csv: "Date,Description,Amount,Type\n2026-05-01,Client fee,8000,income\n2026-05-02,Office rent,3000,expense",
    });
    expect(result.ok).toBe(true);
    expect(hisab.report().totals.net).toBe(5000);
  });

  it("registers desk/hisab/tender agents in the one marketplace catalog", () => {
    const slugs = MARKET_PACKS.map((pack) => pack.slug);
    expect(slugs).toEqual(
      expect.arrayContaining([
        "desk-agent",
        "hisab-agent",
        "tender-agent",
        "daily-desk",
        "weekly-books",
      ]),
    );
  });
});

describe("document extract (csv / xlsx / docx / pdf)", () => {
  it("parses CSV bytes into rows", () => {
    const csv = "Date,Amount,Type\n2026-01-01,10,income";
    const result = extract.extract({ filename: "books.csv", bytes: Buffer.from(csv) });
    expect(result.rows[0].amount).toBe("10");
  });

  it("reads xlsx cell text from a real workbook zip", () => {
    const py = `
from zipfile import ZipFile, ZIP_DEFLATED
from pathlib import Path
import sys
out = Path(sys.argv[1])
sheet = '''<?xml version="1.0"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1">
      <c r="A1" t="inlineStr"><is><t>Date</t></is></c>
      <c r="B1" t="inlineStr"><is><t>Description</t></is></c>
      <c r="C1" t="inlineStr"><is><t>Amount</t></is></c>
      <c r="D1" t="inlineStr"><is><t>Type</t></is></c>
    </row>
    <row r="2">
      <c r="A2" t="inlineStr"><is><t>2026-06-01</t></is></c>
      <c r="B2" t="inlineStr"><is><t>Client invoice</t></is></c>
      <c r="C2" t="inlineStr"><is><t>12000</t></is></c>
      <c r="D2" t="inlineStr"><is><t>income</t></is></c>
    </row>
  </sheetData>
</worksheet>'''
types = '''<?xml version="1.0"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>'''
rels = '''<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>'''
wb = '''<?xml version="1.0"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>
</workbook>'''
wbrels = '''<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>'''
with ZipFile(out, "w", ZIP_DEFLATED) as z:
    z.writestr("[Content_Types].xml", types)
    z.writestr("_rels/.rels", rels)
    z.writestr("xl/workbook.xml", wb)
    z.writestr("xl/_rels/workbook.xml.rels", wbrels)
    z.writestr("xl/worksheets/sheet1.xml", sheet)
`;
    const dir = mkdtempSync(join(tmpdir(), "friday-xlsx-"));
    const script = join(dir, "make.py");
    const file = join(dir, "books.xlsx");
    writeFileSync(script, py);
    const spawned = spawnSync("python3", [script, file], { encoding: "utf8" });
    expect(spawned.status).toBe(0);
    const result = extract.parseXlsx(readFileSync(file));
    expect(result.rows[0].description).toMatch(/Client invoice/);
    expect(result.rows[0].amount).toBe("12000");
    hisab.reset();
    const imported = hisab.importRows(result.rows, "xlsx");
    expect(imported.added).toBe(1);
    expect(hisab.report().totals.income).toBe(12000);
    expect(hisab.report().fromStoredRunning).toBe(true);
  });

  it("reads text from a real docx zip", () => {
    const py = `
from zipfile import ZipFile, ZIP_DEFLATED
from pathlib import Path
import sys
out = Path(sys.argv[1])
doc = '''<?xml version="1.0"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body><w:p><w:r><w:t>Last date: 30 September 2026. Eligibility: GST required.</w:t></w:r></w:p></w:body>
</w:document>'''
types = '''<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>'''
rels = '''<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>'''
with ZipFile(out, "w", ZIP_DEFLATED) as z:
    z.writestr("[Content_Types].xml", types)
    z.writestr("_rels/.rels", rels)
    z.writestr("word/document.xml", doc)
`;
    const dir = mkdtempSync(join(tmpdir(), "friday-docx-"));
    const script = join(dir, "make.py");
    const file = join(dir, "tender.docx");
    writeFileSync(script, py);
    expect(spawnSync("python3", [script, file]).status).toBe(0);
    const result = extract.parseDocx(readFileSync(file));
    expect(result.text).toMatch(/30 September 2026/);
    expect(result.text).toMatch(/GST required/);
  });

  it("extracts visible text from a simple PDF and refuses to invent it when none exists", () => {
    const stream = "BT /F1 12 Tf 72 720 Td (Scope of work: paint the ward office) Tj ET";
    const pdf = Buffer.from(
      `%PDF-1.1\n1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj\n2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj\n3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>endobj\n4 0 obj<< /Length ${stream.length} >>stream\n${stream}\nendstream\nendobj\n`,
    );
    const result = extract.parsePdf(pdf);
    expect(result.text).toMatch(/paint the ward office/);
    const empty = extract.parsePdf(Buffer.from("%PDF-1.1 empty"));
    expect(empty.text).toBe("");
    expect(empty.error).toMatch(/will not invent/i);
  });
});
