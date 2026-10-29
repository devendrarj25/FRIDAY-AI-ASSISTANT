/**
 * FRIDAY reads the common office, book, mail, web, and source formats. Each
 * fixture is built here (real ZIP containers through packZip), not downloaded.
 */
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { OFFICE_EXT } from "../../src/lib/friday/attachments";

const require_ = createRequire(import.meta.url);
const doc = require_("../../electron/document-extract.cjs");

const zip = (files: Record<string, string>) =>
  doc.packZip(Object.entries(files).map(([name, data]) => ({ name, data: Buffer.from(data) })));

describe("document formats", () => {
  it("reads PowerPoint slides in slide order", () => {
    const bytes = zip({
      "ppt/slides/slide10.xml": "<p:sld><a:t>Ten</a:t></p:sld>",
      "ppt/slides/slide2.xml": "<p:sld><a:t>Two</a:t><a:t>Q&amp;A</a:t></p:sld>",
      "ppt/slides/slide1.xml": "<p:sld><a:t>Title</a:t></p:sld>",
    });
    const out = doc.extract({ filename: "deck.pptx", bytes });
    expect(out.kind).toBe("pptx");
    expect(out.text).toBe("Slide 1: Title\nSlide 2: Two Q&A\nSlide 3: Ten");
  });

  it("reads OpenDocument text and sheets", () => {
    const bytes = zip({
      "content.xml":
        "<office:text><text:h>Plan</text:h><text:p>Buy &apos;milk&apos; &#x20B9;50</text:p>" +
        "<table:table-row><table:table-cell><text:p>a</text:p></table:table-cell><table:table-cell><text:p>b</text:p></table:table-cell></table:table-row></office:text>",
    });
    const out = doc.extract({ filename: "notes.odt", bytes });
    expect(out.kind).toBe("opendocument");
    expect(out.text).toContain("Plan");
    expect(out.text).toContain("Buy 'milk' ₹50");
    expect(doc.extract({ filename: "sheet.ods", bytes }).text).toMatch(/a\s*\n?\s*\t?b/);
  });

  it("reads EPUB chapters and drops scripts", () => {
    const bytes = zip({
      "OEBPS/ch1.xhtml":
        "<html><head><title>x</title></head><body><p>Chapter one.</p><script>evil()</script></body></html>",
      "OEBPS/ch2.xhtml": "<html><body><p>Chapter two.</p></body></html>",
    });
    const out = doc.extract({ filename: "book.epub", bytes });
    expect(out.text).toBe("Chapter one.\n\nChapter two.");
  });

  it("reads RTF, HTML, and source files", () => {
    const rtf = Buffer.from(
      "{\\rtf1\\ansi{\\fonttbl\\f0 Arial;}\\f0\\fs24 Hello\\par World caf\\'e9}",
    );
    const text = doc.extract({ filename: "a.rtf", bytes: rtf }).text;
    expect(text).toContain("Hello");
    expect(text).toContain("World café");
    const html = doc.extract({
      filename: "page.html",
      bytes: Buffer.from(
        "<html><style>p{}</style><body><h1>Hi</h1><p>there &amp; you</p></body></html>",
      ),
    });
    expect(html.kind).toBe("html");
    expect(html.text).toBe("Hi\nthere & you");
    expect(doc.extract({ filename: "main.py", bytes: Buffer.from("print('x')") }).text).toBe(
      "print('x')",
    );
    expect(doc.extract({ filename: "x.yaml", bytes: Buffer.from("a: 1") }).kind).toBe("text");
  });

  it("reads an email: headers and the plain text part, quoted-printable decoded", () => {
    const eml = [
      "From: Asha <asha@example.com>",
      "To: owner@example.com",
      "Subject: Invoice",
      'Content-Type: multipart/alternative; boundary="b1"',
      "",
      "--b1",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: quoted-printable",
      "",
      "Total is =E2=82=B9500 and due fri=",
      "day.",
      "--b1",
      "Content-Type: text/html",
      "",
      "<p>html copy</p>",
      "--b1--",
    ].join("\r\n");
    const out = doc.extract({ filename: "mail.eml", bytes: Buffer.from(eml) });
    expect(out.kind).toBe("email");
    expect(out.text).toContain("Subject: Invoice");
    expect(out.text).toContain("due friday.");
    expect(out.text).not.toContain("html copy");
  });

  it("routes these formats from the chat attachment path to the extractor", () => {
    for (const name of [
      "a.pptx",
      "b.odt",
      "c.ods",
      "d.odp",
      "e.epub",
      "f.rtf",
      "g.eml",
      "h.pdf",
      "i.docx",
    ]) {
      expect(OFFICE_EXT.test(name), name).toBe(true);
    }
    expect(doc.extract({ filename: "x.unknownext", bytes: Buffer.from("x") }).kind).toBe("unknown");
  });
});
