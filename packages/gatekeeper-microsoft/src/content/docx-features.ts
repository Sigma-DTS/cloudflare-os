// What rewriting a Word document from Markdown would lose. A Markdown rewrite keeps headings,
// paragraphs, emphasis, links, lists and tables; this names everything else the document has, in
// words an approver understands ("3 images", "2 comments"), so a wholesale replacement is never
// approved without knowing what goes with it.

import { findMainPart, readPartText, readRelationships } from "./ooxml";
import { openZip } from "./zip";

/** Phrases for what a Markdown rewrite of the document would drop, most significant first. */
export async function docxFeatures(bytes: Uint8Array): Promise<string[]> {
  const zip = openZip(bytes);
  const mainPart = await findMainPart(zip, "word/document.xml");
  // A text box or picture is written twice, once as a VML fallback for old readers; count it once.
  const xml = (await readPartText(zip, mainPart)).replace(/<mc:Fallback\b[\s\S]*?<\/mc:Fallback>/g, "");
  const relationships = [...(await readRelationships(zip, mainPart)).values()];
  const count = (pattern: RegExp): number => xml.match(pattern)?.length ?? 0;
  const features: string[] = [];
  const add = (n: number, singular: string, plural = `${singular}s`): void => {
    if (n > 0) features.push(`${n} ${n === 1 ? singular : plural}`);
  };

  const comments = relationships.find(relationship => relationship.type === "comments");
  add(comments && zip.has(comments.target) ? ((await readPartText(zip, comments.target)).match(/<w:comment\b/g)?.length ?? 0) : 0, "comment");
  if (/<w:(ins|del|moveFrom|moveTo)\b[^>]*w:author=/.test(xml) || /<w:(pPrChange|rPrChange)\b/.test(xml)) features.push("unaccepted tracked changes");
  add(count(/<pic:pic\b/g) + count(/<v:imagedata\b/g), "image");
  add(count(/<c:chart\b/g), "chart");
  add(count(/<dgm:relIds\b/g), "SmartArt diagram");
  add(count(/<w:txbxContent\b/g), "text box", "text boxes");
  add(count(/<w:object\b/g), "embedded object");
  add(count(/<m:oMath\b/g), "equation");
  add(count(/<w:footnoteReference\b/g), "footnote");
  add(count(/<w:endnoteReference\b/g), "endnote");
  if (relationships.some(relationship => relationship.type === "header" || relationship.type === "footer")) features.push("headers and footers");
  if (/\bTOC\s\\/.test(xml) || /w:docPartGallery w:val="Table of Contents"/.test(xml)) features.push("a table of contents");
  if (/<w:instrText[^>]*>\s*(REF|PAGEREF|NOTEREF)\s/.test(xml)) features.push("cross-references");
  const controls = count(/<w:sdt\b/g) - count(/w:docPartGallery w:val="Table of Contents"/g);
  add(controls, "content control");
  if (/<w:(gridSpan w:val="[2-9]|vMerge)\b/.test(xml)) features.push("merged table cells");
  if (/<w:tc\b(?:(?!<\/w:tc>)[\s\S])*<w:tbl\b/.test(xml)) features.push("nested tables");
  const sections = count(/<w:sectPr\b/g);
  if (sections > 1) features.push(`${sections} sections`);
  if (/<w:pgSz\b[^>]*w:orient="landscape"/.test(xml)) features.push("landscape pages");
  if (/<w:cols\b[^>]*w:num="[2-9]/.test(xml)) features.push("multiple columns");
  if (/<w:(color w:val="(?!auto|000000)[0-9A-Fa-f]{6}"|highlight\b)/.test(xml)) features.push("text colors and highlighting");
  if (/<w:(u w:val="(?!none)|caps\/|smallCaps\/|vertAlign w:val="(superscript|subscript))/.test(xml)) features.push("underline, capitals or superscript formatting");
  if (/<w:shd\b[^>]*w:fill="(?!auto|FFFFFF)[0-9A-Fa-f]{6}"/.test(xml)) features.push("shading");
  if (/<w:bookmarkStart\b[^>]*w:name="(?!_GoBack)/.test(xml)) features.push("bookmarks");
  if (zip.entries().some(entry => /vbaProject\.bin$/i.test(entry.name))) features.push("macros");
  if (zip.entries().some(entry => entry.name.startsWith("_xmlsignatures/"))) features.push("a digital signature");
  return features;
}
