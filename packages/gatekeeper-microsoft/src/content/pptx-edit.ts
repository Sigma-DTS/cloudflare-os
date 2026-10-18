// Edits to an existing deck, made in place: text replaced within its runs or a placeholder's text
// replaced, slides added on the deck's own layouts, duplicated, moved or deleted, speaker notes set.
// Everything else in the file stays as it was, byte for byte, so an edit never costs the deck its
// animations, images or design.

import { parseMarkdown, plainText } from "./markdown-parse";
import { escapeText, parsePart } from "./ooxml";
import { imageOf, items, paragraphs, fitScale, type ImageItem } from "./pptx-content";
import { Deck, type Box } from "./pptx-deck";
import { placeholderHandles, placeholderKind, slidePlaceholders } from "./pptx-describe";
import { MediaStore, SlideContentError, prepareMarkdown, type PptxImages } from "./pptx-images";
import { PackageError } from "./pptx-package";
import { PartWriter, autofit, notesParagraphs, notesXml, pictureShape, runTemplate, titleScale } from "./pptx-render";
import { insertMarkdownSlides } from "./pptx-write";
import { descendants, decodeEntities, type XmlElement } from "./xml";

export { pptxFeatures } from "./pptx-features";
export { describePptx, type SlideInfo, type SlidePlaceholder } from "./pptx-describe";

/**
 * One edit. Edits apply in order, each to the deck as the edits before it left it: slide numbers
 * are as of that moment (after `deleteSlide: 2`, the old slide 3 is slide 2). Every slide number is
 * 1-based. A call either makes every edit or, when one can't be made, none.
 *   - `find`/`replace`: replaces text on slides (shapes, tables, groups) and in speaker notes.
 *     The match is exact and within one paragraph, wherever the text's formatting changes; the
 *     replacement takes the formatting of the first character matched. Without `all`, the text must
 *     occur exactly once in the deck.
 *   - `setText`: replaces one placeholder's text with Markdown, keeping the placeholder's font and
 *     paragraph styles; bullets become levels. `placeholder` is a name `describePptx` reports
 *     ("title", "body", "body 2", ...). A Markdown image line alone puts that picture in a content
 *     or picture placeholder instead.
 *   - `addSlides`: Markdown, laid out as `markdownToPptx` does, on the deck's own layouts, after
 *     slide `after` (0 puts them first; the end when omitted).
 *   - `duplicateSlide`: copies a slide, with its notes, to just after it or after slide `after`.
 *   - `moveSlide`: moves a slide so it becomes slide `to`.
 *   - `deleteSlide`: removes a slide with its notes and anything only it used.
 *   - `setNotes`: replaces a slide's speaker notes with Markdown, adding notes where it has none.
 */
export type PresentationEdit =
  | { readonly find: string; readonly replace: string; readonly all?: boolean }
  | { readonly setText: { readonly slide: number; readonly placeholder: string; readonly markdown: string } }
  | { readonly addSlides: string; readonly after?: number }
  | { readonly duplicateSlide: number; readonly after?: number }
  | { readonly moveSlide: number; readonly to: number }
  | { readonly deleteSlide: number }
  | { readonly setNotes: { readonly slide: number; readonly markdown: string } };

/** What one edit changed, for showing a person: the slide, the text before and after, and a sentence saying what happened. */
export interface PresentationChange {
  /** The slide's number once the edit was made (for a deletion, the number it had). */
  readonly slide: number;
  readonly before?: string;
  readonly after?: string;
  /** Set when the change was in the slide's speaker notes. */
  readonly notes?: boolean;
  /** What happened, as a sentence: `Moved slide 2 "Roadmap" to position 5.` */
  readonly summary: string;
}

/** An edit that can't be made as asked. The message says what to change. */
export class PresentationEditError extends Error {
  override readonly name = "PresentationEditError";
}

/** How `editPptx` makes its edits. */
export interface EditPptxOptions {
  /** The pictures image lines in `addSlides` and `setText` name, by reference (see `imageRefs`). */
  readonly images?: PptxImages;
}

/** Applies edits to a deck. Throws `PresentationEditError` for an edit that can't be made, and changes nothing. */
export async function editPptx(bytes: Uint8Array, edits: readonly PresentationEdit[], options: EditPptxOptions = {}): Promise<{ bytes: Uint8Array; changes: PresentationChange[] }> {
  if (edits.length === 0) throw new PresentationEditError("No edits were given.");
  let deck: Deck;
  try {
    deck = await Deck.open(bytes);
  } catch (error) {
    if (error instanceof PackageError) throw new PresentationEditError(error.message);
    throw error;
  }
  const media = new MediaStore(deck.pkg, options.images);
  const changes: PresentationChange[] = [];
  for (const [index, edit] of edits.entries()) {
    try {
      changes.push(...applyEdit(deck, edit, media, options.images));
    } catch (error) {
      if (error instanceof SlideContentError || error instanceof PresentationEditError) {
        throw new PresentationEditError(edits.length > 1 ? `Edit ${index + 1}: ${error.message}` : error.message);
      }
      throw error;
    }
  }
  const app = "docProps/app.xml";
  const properties = deck.pkg.text(app);
  if (properties !== undefined && /<Slides>\d+<\/Slides>/.test(properties)) {
    deck.pkg.set(app, properties.replace(/<Slides>\d+<\/Slides>/, `<Slides>${deck.slides().length}</Slides>`));
  }
  return { bytes: await deck.toBytes(), changes };
}

function applyEdit(deck: Deck, edit: PresentationEdit, media: MediaStore, images: PptxImages | undefined): PresentationChange[] {
  if (typeof edit !== "object" || edit === null) throw new PresentationEditError("Each edit must be an object.");
  if ("find" in edit) return replaceText(deck, edit);
  if ("setText" in edit) return [setText(deck, edit.setText, media)];
  if ("addSlides" in edit) return addSlides(deck, edit, images);
  if ("duplicateSlide" in edit) return [duplicateSlide(deck, edit)];
  if ("moveSlide" in edit) return [moveSlide(deck, edit)];
  if ("deleteSlide" in edit) return [deleteSlide(deck, edit.deleteSlide)];
  if ("setNotes" in edit) return [setNotes(deck, edit.setNotes)];
  throw new PresentationEditError("Each edit needs one of: find and replace, setText, addSlides, duplicateSlide, moveSlide, deleteSlide, setNotes.");
}

// ---- Find and replace ----

const PARAGRAPH = /<a:p(?:\s[^>]*)?>([\s\S]*?)<\/a:p>/g;
const TOKEN = new RegExp([
  /<a:pPr\b[^>]*?(?:\/>|>[\s\S]*?<\/a:pPr>)/,
  /<a:r(?:\s[^>]*)?>[\s\S]*?<\/a:r>/,
  /<a:br\b[^>]*?(?:\/>|>[\s\S]*?<\/a:br>)/,
  /<a:fld\b[^>]*?(?:\/>|>[\s\S]*?<\/a:fld>)/,
  /<a:endParaRPr\b[^>]*?(?:\/>|>[\s\S]*?<\/a:endParaRPr>)/,
  /<mc:AlternateContent\b[\s\S]*?<\/mc:AlternateContent>/,
  /<[^>]+>|[^<]+/,
].map(pattern => pattern.source).join("|"), "g");
const RUN_PROPERTIES = /^<a:r(?:\s[^>]*)?>\s*(<a:rPr\b[^>]*?(?:\/>|>[\s\S]*?<\/a:rPr>))?/;
const RUN_TEXT = /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>|<a:t\s*\/>/;

/** A paragraph's content: runs of text, and everything else, which a match can't cross. */
type Token =
  | { kind: "run"; raw: string; properties: string; text: string; changed: boolean }
  | { kind: "other"; raw: string; text: string };

function tokenize(inner: string): Token[] {
  return (inner.match(TOKEN) ?? []).map((raw): Token => {
    if (/^<a:r[\s>]/.test(raw)) {
      const text = RUN_TEXT.exec(raw)?.[1];
      return { kind: "run", raw, properties: RUN_PROPERTIES.exec(raw)?.[1] ?? "", text: text === undefined ? "" : decodeEntities(text), changed: false };
    }
    if (raw.startsWith("<a:br")) return { kind: "other", raw, text: "\n" };
    if (raw.startsWith("<a:fld")) return { kind: "other", raw, text: decodeEntities(RUN_TEXT.exec(raw)?.[1] ?? "") };
    return { kind: "other", raw, text: "" };
  });
}

/** Runs between the things a match can't cross. */
function segments(tokens: readonly Token[]): Extract<Token, { kind: "run" }>[][] {
  const out: Extract<Token, { kind: "run" }>[][] = [[]];
  for (const token of tokens) {
    if (token.kind === "run") out.at(-1)!.push(token);
    else if (token.text || !/^(<a:(pPr|endParaRPr)\b|\s*$)/.test(token.raw)) out.push([]);
  }
  return out.filter(segment => segment.length);
}

function matchStarts(text: string, find: string): number[] {
  const starts: number[] = [];
  for (let at = text.indexOf(find); at !== -1; at = text.indexOf(find, at + find.length)) starts.push(at);
  return starts;
}

/** Replaces every occurrence in one run of runs, right to left so earlier offsets stay valid. */
function replaceInSegment(runs: Extract<Token, { kind: "run" }>[], find: string, replace: string): void {
  const offsets: number[] = [];
  let length = 0;
  for (const run of runs) {
    offsets.push(length);
    length += run.text.length;
  }
  const runAt = (position: number) => {
    let index = 0;
    while (index + 1 < runs.length && offsets[index + 1]! <= position) index++;
    return index;
  };
  for (const start of matchStarts(runs.map(run => run.text).join(""), find).toReversed()) {
    const end = start + find.length;
    const first = runAt(start), last = runAt(end - 1);
    const head = runs[first]!, tail = runs[last]!;
    if (first === last) {
      head.text = head.text.slice(0, start - offsets[first]!) + replace + head.text.slice(end - offsets[first]!);
    } else {
      tail.text = tail.text.slice(end - offsets[last]!);
      tail.changed = true;
      for (let index = first + 1; index < last; index++) {
        runs[index]!.text = "";
        runs[index]!.changed = true;
      }
      head.text = head.text.slice(0, start - offsets[first]!) + replace;
    }
    head.changed = true;
  }
}

function runXml(run: Extract<Token, { kind: "run" }>): string {
  if (!run.changed) return run.raw;
  if (!run.text) return "";
  // A line break in the replacement becomes a PowerPoint line break in the same formatting.
  return run.text.split("\n").map(line => `<a:r>${run.properties}<a:t>${escapeText(line)}</a:t></a:r>`)
    .join(`<a:br>${run.properties}</a:br>`);
}

function plain(tokens: readonly Token[]): string {
  return tokens.map(token => token.text).join("");
}

interface Location {
  readonly part: string;
  readonly slide: number;
  readonly notes: boolean;
}

function locations(deck: Deck): Location[] {
  return deck.slides().flatMap((slide, index) => {
    const notes = deck.notesPart(slide.part);
    return [{ part: slide.part, slide: index + 1, notes: false }, ...(notes ? [{ part: notes, slide: index + 1, notes: true }] : [])];
  });
}

function quoted(text: string): string {
  return JSON.stringify(text.length > 80 ? `${text.slice(0, 77)}...` : text);
}

function listing(labels: readonly string[]): string {
  return labels.length <= 1 ? labels.join("") : `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
}

function replaceText(deck: Deck, edit: { find: string; replace: string; all?: boolean }): PresentationChange[] {
  const { find, replace } = edit;
  if (typeof find !== "string" || find === "") throw new PresentationEditError("find must be the text to replace; it can't be empty.");
  if (typeof replace !== "string") throw new PresentationEditError("replace must be text (use \"\" to delete what find matches).");
  if (/[\r\n]/.test(find)) {
    throw new PresentationEditError("find can't span paragraphs or line breaks. Replace one paragraph's text at a time.");
  }
  const places = locations(deck);
  const counts = places.map(place => {
    let count = 0;
    for (const match of (deck.pkg.text(place.part) ?? "").matchAll(PARAGRAPH)) {
      for (const segment of segments(tokenize(match[1]!))) count += matchStarts(segment.map(run => run.text).join(""), find).length;
    }
    return count;
  });
  const total = counts.reduce((sum, count) => sum + count, 0);
  if (total === 0) {
    throw new PresentationEditError(`${quoted(find)} wasn't found in the presentation. Text is matched exactly, including case and spacing, ` +
      "within one paragraph of a slide, table or speaker notes; read the deck again and copy the current wording.");
  }
  if (total > 1 && !edit.all) {
    const labels = [...new Set(places.filter((_, index) => counts[index]! > 0).map(place => `slide ${place.slide}${place.notes ? " notes" : ""}`))];
    throw new PresentationEditError(`${quoted(find)} appears ${total} times in the presentation (${listing(labels)}). ` +
      "Include more of the surrounding text so it matches once, or pass all: true to replace every occurrence.");
  }

  const changes: PresentationChange[] = [];
  places.forEach((place, index) => {
    if (counts[index] === 0) return;
    const xml = deck.pkg.text(place.part)!;
    const updated = xml.replace(PARAGRAPH, (whole, inner: string) => {
      const tokens = tokenize(inner);
      const found = segments(tokens).filter(segment => matchStarts(segment.map(run => run.text).join(""), find).length);
      if (found.length === 0) return whole;
      const before = plain(tokens);
      for (const segment of found) replaceInSegment(segment, find, replace);
      const after = plain(tokens);
      changes.push({ slide: place.slide, before, after, ...(place.notes ? { notes: true } : {}),
        summary: `Slide ${place.slide}${place.notes ? " notes" : ""}: replaced ${quoted(find)} with ${quoted(replace)}.` });
      const open = whole.slice(0, whole.indexOf(">") + 1);
      return `${open}${tokens.map(token => token.kind === "run" ? runXml(token) : token.raw).join("")}</a:p>`;
    });
    deck.pkg.set(place.part, updated);
  });
  return changes;
}

// ---- Slides ----

function slideNumberError(name: string, value: unknown, min: number, count: number): PresentationEditError {
  return new PresentationEditError(`${name} must be a whole slide number from ${min} to ${count}${min === 0 ? " (0 means before the first slide)" : ""}; ` +
    `${JSON.stringify(value)} isn't. The deck has ${count} ${count === 1 ? "slide" : "slides"}.`);
}

/** The slide `number` names, checked against the deck as it is now. */
function slideAt(deck: Deck, number: unknown, name: string): { part: string; index: number; count: number } {
  const slides = deck.slides();
  if (typeof number !== "number" || !Number.isInteger(number) || number < 1 || number > slides.length) throw slideNumberError(name, number, 1, slides.length);
  return { part: slides[number - 1]!.part, index: number - 1, count: slides.length };
}

function titled(deck: Deck, part: string, number: number): string {
  const title = deck.slideTitle(part);
  return title ? `slide ${number} ${quoted(title)}` : `slide ${number}`;
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function addSlides(deck: Deck, edit: { addSlides: string; after?: number }, images: PptxImages | undefined): PresentationChange[] {
  const count = deck.slides().length;
  const after = edit.after ?? count;
  if (!Number.isInteger(after) || after < 0 || after > count) throw slideNumberError("after", edit.after, 0, count);
  if (typeof edit.addSlides !== "string" || !edit.addSlides.trim()) {
    throw new PresentationEditError("addSlides must be Markdown for the new slides: start each slide with a # heading.");
  }
  const added = insertMarkdownSlides(deck, edit.addSlides, { index: after, ...(images ? { images } : {}) });
  if (added.length === 0) throw new PresentationEditError("addSlides made no slides: start each slide with a # heading and give it content.");
  // The Markdown the slides are made from, as the approver reads them: a title alone would hide what they say.
  const first = after + 1;
  return [{
    slide: first, after: edit.addSlides.trim(),
    summary: added.length === 1
      ? `Added slide ${first}${added[0]!.title ? ` ${quoted(added[0]!.title)}` : ""}.`
      : `Added slides ${first} to ${after + added.length}.`,
  }];
}

function deleteSlide(deck: Deck, number: number): PresentationChange {
  const { part, index } = slideAt(deck, number, "deleteSlide");
  const before = deck.slideTitle(part);
  const label = titled(deck, part, number);
  deck.removeSlide(index);
  return { slide: number, before, summary: `Deleted ${label}.` };
}

function duplicateSlide(deck: Deck, edit: { duplicateSlide: number; after?: number }): PresentationChange {
  const { part, count } = slideAt(deck, edit.duplicateSlide, "duplicateSlide");
  const after = edit.after ?? edit.duplicateSlide;
  if (!Number.isInteger(after) || after < 0 || after > count) throw slideNumberError("after", edit.after, 0, count);
  const label = titled(deck, part, edit.duplicateSlide);
  const copy = deck.duplicateSlide(edit.duplicateSlide - 1, after);
  return { slide: after + 1, after: deck.slideTitle(copy), summary: `${capitalized(label)} copied as slide ${after + 1}.` };
}

function moveSlide(deck: Deck, edit: { moveSlide: number; to: number }): PresentationChange {
  const { part, index, count } = slideAt(deck, edit.moveSlide, "moveSlide");
  if (typeof edit.to !== "number" || !Number.isInteger(edit.to) || edit.to < 1 || edit.to > count) throw slideNumberError("to", edit.to, 1, count);
  const label = titled(deck, part, edit.moveSlide);
  deck.moveSlide(index, edit.to - 1);
  return { slide: edit.to, summary: `Moved ${label} to position ${edit.to}.` };
}

// ---- Placeholder text and notes ----

const SHAPE = /<p:sp\b(?:\s[^>]*)?>[\s\S]*?<\/p:sp>/g;
const TEXT_BODY = /<p:txBody>([\s\S]*?)<\/p:txBody>|<p:txBody\s*\/>/;

/** The raw markup of each `p:sp` in document order, with where it sits. */
function rawShapes(xml: string): { raw: string; start: number }[] {
  return [...xml.matchAll(SHAPE)].map(match => ({ raw: match[0], start: match.index! }));
}

function shapeBox(raw: string): Box | undefined {
  const match = /<a:xfrm\b[^>]*>\s*<a:off x="(-?\d+)" y="(-?\d+)"\/>\s*<a:ext cx="(\d+)" cy="(\d+)"\/>/.exec(raw);
  return match ? { x: Number(match[1]), y: Number(match[2]), cx: Number(match[3]), cy: Number(match[4]) } : undefined;
}

/** A text body's paragraphs replaced, keeping its body and list properties. */
function withParagraphs(raw: string, paragraphXml: string, bodyProperties?: (existing: string) => string): string {
  const body = TEXT_BODY.exec(raw);
  const inner = body?.[1] ?? "";
  let bodyPr = /<a:bodyPr\b[^>]*?(?:\/>|>[\s\S]*?<\/a:bodyPr>)/.exec(inner)?.[0] ?? "<a:bodyPr/>";
  if (bodyProperties) bodyPr = bodyProperties(bodyPr);
  const lstStyle = /<a:lstStyle\b[^>]*?(?:\/>|>[\s\S]*?<\/a:lstStyle>)/.exec(inner)?.[0] ?? "<a:lstStyle/>";
  const txBody = `<p:txBody>${bodyPr}${lstStyle}${paragraphXml}</p:txBody>`;
  return body ? raw.replace(TEXT_BODY, () => txBody) : raw.replace(/<\/p:sp>$/, `${txBody}</p:sp>`);
}

function rawText(raw: string): string {
  return [...raw.matchAll(/<a:p(?:\s[^>]*)?>([\s\S]*?)<\/a:p>/g)]
    .map(match => [...match[1]!.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)].map(text => decodeEntities(text[1]!)).join(""))
    .filter(Boolean).join("\n");
}

function setText(deck: Deck, edit: { slide: number; placeholder: string; markdown: string }, media: MediaStore): PresentationChange {
  if (typeof edit !== "object" || edit === null) throw new PresentationEditError("setText needs slide, placeholder and markdown.");
  const { part } = slideAt(deck, edit.slide, "setText.slide");
  if (typeof edit.markdown !== "string") throw new PresentationEditError("setText.markdown must be the new text, as Markdown.");
  const xml = deck.pkg.text(part)!;
  const root = parsePart(xml);
  const found = slidePlaceholders(root);
  const handles = placeholderHandles(found.map(entry => entry.info));
  const at = handles.findIndex(handle => handle.toLowerCase() === String(edit.placeholder ?? "").trim().toLowerCase());
  if (at === -1) {
    throw new PresentationEditError(handles.length
      ? `Slide ${edit.slide} has no placeholder ${quoted(String(edit.placeholder))}. Its placeholders are: ${handles.join(", ")}.`
      : `Slide ${edit.slide} has no text placeholders. Use find and replace for its text, or addSlides for a new slide.`);
  }
  // The placeholder's markup: the same p:sp, counted among all of them in document order.
  const all = [...descendants(root, "p:sp")];
  const shapes = rawShapes(xml);
  const position = all.indexOf(found[at]!.shape as XmlElement);
  const target = shapes[position];
  if (!target || shapes.length !== all.length) throw new PresentationEditError(`Slide ${edit.slide} is laid out in a way setText can't edit; use find and replace instead.`);
  const { info } = found[at]!;
  const kind = placeholderKind(info.type);
  const writer = new PartWriter(deck, part, media, Number(/<p:cNvPr\b[^>]*\bid="(\d+)"/.exec(target.raw)?.[1] ?? 2));
  const box = shapeBox(target.raw) ?? deck.layoutPlaceholderBox(part, info.type, info.idx);
  const prepared = prepareMarkdown(edit.markdown);
  const blocks = parseMarkdown(prepared.markdown);
  const before = rawText(target.raw);
  let replacement: string;
  let after: string;

  const image = blocks.length === 1 ? imageOf(blocks[0]!, prepared.images) : undefined;
  if (image) {
    if (info.type !== "obj" && info.type !== "pic") throw new PresentationEditError(`The ${handles[at]} placeholder on slide ${edit.slide} holds only text; a picture can go in a content or picture placeholder.`);
    if (!box) throw new PresentationEditError(`Slide ${edit.slide}'s ${handles[at]} placeholder has no position to fit a picture to.`);
    const item = items(blocks, prepared.images, ref => media.get(ref))[0] as ImageItem;
    replacement = pictureShape(writer, item, { placeholder: { type: info.type, idx: info.idx, box }, fit: true });
    after = `[picture: ${image.alt || image.ref}]`;
  } else {
    if (prepared.images.length) throw new PresentationEditError("setText puts either text or one picture (an image line on its own) in a placeholder, not both.");
    const paragraphList = blocks.flatMap(block => paragraphs(block, 0, false));
    const run = runTemplate(/<a:r(?:\s[^>]*)?>\s*(<a:rPr\b[^>]*?(?:\/>|>[\s\S]*?<\/a:rPr>))/.exec(target.raw)?.[1]);
    const levels = new Map<number, string>();
    for (const match of target.raw.matchAll(/<a:p(?:\s[^>]*)?>\s*(<a:pPr\b[^>]*?(?:\/>|>[\s\S]*?<\/a:pPr>))/g)) {
      const level = Number(/\blvl="(\d)"/.exec(match[1]!)?.[1] ?? 0);
      if (!levels.has(level) && !/<a:buNone\b/.test(match[1]!)) levels.set(level, match[1]!);
    }
    const template = { ...(run ? { run } : {}), levels };
    let paragraphXml: string;
    let scale: number | undefined;
    if (kind === "body") {
      paragraphXml = paragraphList.map(paragraph => writer.paragraph(paragraph, undefined, 1, template)).join("");
      scale = box ? fitScale(paragraphList, box, { sizes: deck.bodySizes() }, 0.5) ?? 0.5 : undefined;
    } else {
      paragraphXml = writer.plainParagraphs(paragraphList, template, kind !== "title");
      if (kind === "title") scale = titleScale(blocks.flatMap(block => block.kind === "paragraph" || block.kind === "heading" ? block.inlines : []), box, 36);
    }
    if (!paragraphXml) paragraphXml = `<a:p>${writer.endParagraph({}, run)}</a:p>`;
    replacement = withParagraphs(target.raw, paragraphXml, existing => /<a:normAutofit\b/.test(existing)
      ? existing.replace(/<a:normAutofit\b[^>]*?(?:\/>|>[\s\S]*?<\/a:normAutofit>)/, autofit(scale)) : existing);
    after = paragraphList.map(paragraph => plainText(paragraph.inlines)).filter(Boolean).join("\n");
  }
  deck.pkg.set(part, xml.slice(0, target.start) + replacement + xml.slice(target.start + target.raw.length));
  return { slide: edit.slide, before, after, summary: `Slide ${edit.slide}: replaced the ${handles[at]} text.` };
}

function setNotes(deck: Deck, edit: { slide: number; markdown: string }): PresentationChange {
  if (typeof edit !== "object" || edit === null) throw new PresentationEditError("setNotes needs slide and markdown.");
  const { part } = slideAt(deck, edit.slide, "setNotes.slide");
  if (typeof edit.markdown !== "string") throw new PresentationEditError("setNotes.markdown must be the notes, as Markdown.");
  const prepared = prepareMarkdown(edit.markdown);
  if (prepared.images.length) throw new PresentationEditError("Speaker notes can't hold pictures; describe the picture in words instead.");
  const blocks = parseMarkdown(prepared.markdown);
  const after = blocks.flatMap(block => paragraphs(block, 0, false)).map(paragraph => plainText(paragraph.inlines)).filter(Boolean).join("\n");
  const notes = deck.notesPart(part);
  if (!notes) {
    if (blocks.length) deck.addNotes(part, notesPart => notesXml(deck, notesPart, blocks));
    return { slide: edit.slide, before: "", after, notes: true, summary: `Slide ${edit.slide}: added speaker notes.` };
  }
  const xml = deck.pkg.text(notes)!;
  const writer = new PartWriter(deck, notes);
  const body = rawShapes(xml).find(shape => /<p:ph\b[^>]*\btype="body"/.test(shape.raw));
  const paragraphXml = notesParagraphs(writer, blocks);
  let updated: string;
  let before = "";
  if (body) {
    before = rawText(body.raw);
    updated = xml.slice(0, body.start) + withParagraphs(body.raw, paragraphXml) + xml.slice(body.start + body.raw.length);
  } else {
    const ids = [...xml.matchAll(/<p:cNvPr\b[^>]*\bid="(\d+)"/g)].map(match => Number(match[1]));
    const id = Math.max(1, ...ids) + 1;
    updated = xml.replace(/<\/p:spTree>/, `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Notes Placeholder ${id - 1}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>` +
      `<p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${paragraphXml}</p:txBody></p:sp></p:spTree>`);
  }
  deck.pkg.set(notes, updated);
  return { slide: edit.slide, before, after, notes: true, summary: `Slide ${edit.slide}: ${after ? "replaced" : "cleared"} the speaker notes.` };
}
