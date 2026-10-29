/**
 * Scanned (image-only) PDFs fall through to PyMuPDF + Tesseract on the same
 * document-extract path. Digital text PDFs still use the stream parser.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const extract = require_("../../electron/document-extract.cjs") as {
  parsePdf: (bytes: Buffer) => {
    text: string;
    error?: string;
    ocr?: boolean;
    engine?: string;
  };
  extract: (input: { filename?: string; bytes?: Buffer }) => {
    text: string;
    error?: string;
    ocr?: boolean;
    kind?: string;
  };
  probePdfOcr: () => {
    ok?: boolean;
    pymupdf?: boolean;
    pytesseract?: boolean;
    tesseract?: boolean;
  };
};

const ROOT = path.resolve(__dirname, "../..");
const FIXTURE = path.join(__dirname, "fixtures", "scanned-ward-office.pdf");

describe("scanned PDF OCR fallback", () => {
  it("still extracts a digital text PDF without OCR", () => {
    const stream = "BT /F1 12 Tf 72 720 Td (Scope of work: paint the ward office) Tj ET";
    const pdf = Buffer.from(
      `%PDF-1.1\n1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj\n2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj\n3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>endobj\n4 0 obj<< /Length ${stream.length} >>stream\n${stream}\nendstream\nendobj\n`,
    );
    const result = extract.parsePdf(pdf);
    expect(result.text).toMatch(/paint the ward office/);
    expect(result.ocr).toBe(false);
    expect(result.engine).toBe("pdf-stream");
  });

  it("refuses an empty PDF honestly after OCR also fails", () => {
    const empty = extract.parsePdf(Buffer.from("%PDF-1.1 empty"));
    expect(empty.text).toBe("");
    expect(empty.error).toMatch(/will not invent/i);
  });

  it("OCRs a real image-only scanned PDF when the toolchain is present", () => {
    expect(fs.existsSync(FIXTURE)).toBe(true);
    const bytes = fs.readFileSync(FIXTURE);
    const probe = extract.probePdfOcr();
    const result = extract.extract({ filename: path.join(ROOT, "scanned.pdf"), bytes });
    if (probe.pymupdf && probe.tesseract) {
      expect(result.error).toBeFalsy();
      expect(result.text).toMatch(/paint the ward office/i);
      expect(result.text).toMatch(/GST registered/i);
      expect(result.text).toMatch(/30 September 2026/i);
      expect(result.ocr).toBe(true);
    } else {
      expect(result.text).toBe("");
      expect(result.error).toMatch(/will not invent/i);
    }
  });
});
