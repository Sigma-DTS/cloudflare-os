// What an Office file the agent passes as bytes may hold. Such a file is shown to the approver as
// its text, if at all, and its upload can be approved automatically, so it gets the limits a file
// written here has by construction: no macros or ActiveX, nothing fetched from elsewhere when it is
// opened (a remote template, linked picture or workbook link), no DDE, and no formula
// `checkFormula` refuses. Links people click stay allowed, as a written file may have them.

import { parsePart, readPartText } from "./ooxml";
import { checkFormula, FormulaError } from "./xlsx-write";
import { attribute, childElements, decodeEntities } from "./xml";
import { openZip, ZipError, type ZipArchive } from "./zip";

/** Extensions of Office packages this checks; any other bytes pass through. */
const OFFICE_PACKAGES = new Set(["docx", "xlsx", "pptx", "docm", "xlsm", "pptm", "dotx", "potx", "xltx"]);

/** Parts that run code or reach elsewhere whenever the file is opened, by what they are. */
const REFUSED_PARTS: readonly [RegExp, string][] = [
  [/(^|\/)vbaProject\.bin$/i, "macros"],
  [/(^|\/)activeX\//i, "ActiveX controls"],
  [/^xl\/externalLinks\//i, "links to other workbooks"],
  [/^xl\/connections\.xml$/i, "external data connections"],
];

/** Word fields that run a program or fetch content from elsewhere. */
const REFUSED_FIELD = /^\s*(DDE|DDEAUTO|INCLUDETEXT|INCLUDEPICTURE|IMPORT|LINK)\b/i;

/** Throws an error the agent can act on when `bytes`, an Office file named by `ext`, holds what a written file can't. */
export async function checkOfficePackage(ext: string, bytes: Uint8Array): Promise<void> {
  if (!OFFICE_PACKAGES.has(ext)) return;
  let zip: ZipArchive;
  try {
    zip = openZip(bytes);
  } catch (error) {
    if (error instanceof ZipError) throw new Error(`Those bytes aren't a readable ${ext} file.`, { cause: error });
    throw error;
  }
  const refuse = (what: string): never => {
    throw new Error(`That ${ext} file has ${what}, which files uploaded here can't have. Remove them, or write the file from ${ext.startsWith("xl") ? "rows or CSV" : "Markdown"} instead.`);
  };
  for (const { name } of zip.entries()) {
    for (const [pattern, what] of REFUSED_PARTS) if (pattern.test(name)) refuse(what);
    if (name.toLowerCase().endsWith(".rels")) await checkRelationships(zip, name, refuse);
    if (/^word\/[^/]+\.xml$/i.test(name) && hasRefusedField(await readPartText(zip, name))) refuse("DDE or fields that fetch content from elsewhere");
    if (/^xl\/(worksheets\/[^/]+|workbook)\.xml$/i.test(name)) await checkFormulas(zip, name, ext);
  }
}

async function checkRelationships(zip: ZipArchive, name: string, refuse: (what: string) => never): Promise<void> {
  for (const relationship of childElements(parsePart(await readPartText(zip, name)), "pr:Relationship")) {
    if (attribute(relationship, "TargetMode") !== "External") continue;
    const type = attribute(relationship, "Type") ?? "";
    if (!type.endsWith("/hyperlink")) refuse(`content it fetches from elsewhere when opened (${type.slice(type.lastIndexOf("/") + 1) || "an external link"})`);
  }
}

/**
 * Whether a Word part has a refused field. A field's instruction can be split across runs, and fields
 * nest, so instruction text is joined in order and broken at every field boundary.
 */
function hasRefusedField(xml: string): boolean {
  let instructions = "";
  for (const match of xml.matchAll(/<w:fldChar\b[^>]*>|<w:instrText\b[^>]*>([^<]*)<\/w:instrText>|\bw:instr="([^"]*)"/g)) {
    if (match[1] !== undefined) instructions += decodeEntities(match[1]);
    else instructions += `\n${match[2] !== undefined ? decodeEntities(match[2]) : ""}\n`;
  }
  return instructions.split("\n").some(line => REFUSED_FIELD.test(line));
}

async function checkFormulas(zip: ZipArchive, name: string, ext: string): Promise<void> {
  const xml = await readPartText(zip, name);
  for (const match of xml.matchAll(/<(f|definedName)\b[^>]*>([^<]*)<\/\1>/g)) {
    const formula = decodeEntities(match[2]!);
    if (formula.trim() === "") continue;
    try {
      checkFormula(formula);
    } catch (error) {
      if (error instanceof FormulaError) throw new Error(`That ${ext} file has a formula files uploaded here can't have. ${error.message}`, { cause: error });
      throw error;
    }
  }
}
