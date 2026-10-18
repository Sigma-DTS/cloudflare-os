// Every change this gatekeeper can make, as the kit's action set: what each action stores, how the
// approver sees it, and how it is applied and reverted. Nothing here runs before approval; sessions
// stage actions, and the facet applies them when the user approves.
//
// Changes to existing objects carry a version fence. A replace or delete is applied only if the
// file's content is unchanged since the change was proposed (Graph accepts the content tag, `cTag`,
// in `If-Match`), so a colleague's edit in between is never overwritten or binned; a list item
// update is fenced on the item's eTag the same way. A rename or move is not fenced by default:
// it does not lose anyone's work.

import {
  ActionApplyError,
  defineActions,
  type ActionPresentation,
  type TaggedAction,
} from "@gadgets/gatekeeper-kit/actions";
import { buildDescription, plainInline, sanitizeTitle } from "@gadgets/gatekeeper-kit/action-description";
import type { ActionFileReference } from "@gadgets/gatekeeper-kit/action-files";
import { diffTextLines, type GitDiffHunk } from "@gadgets/gatekeeper-kit/git-diff";
import type { ProvisionalIds } from "@gadgets/gatekeeper-kit/simulation";
import { isProvisional } from "./binding";
import { GraphApiError, type GraphApi } from "./graph-api";
import { ITEM_SELECT, parseDriveItem, parseListItem, parseVersion, parsePage } from "./graph-parse";
import { VENDOR_ID } from "./microsoft-env";
import { obsContext } from "./observability";
import { decodeItemRef, encodeItemRef, type ItemRef, type ListRef } from "./sharepoint-scope";
import type { CellValue, FieldValue } from "./types";
import { columnIndex, columnLetters } from "./workbook-ranges";

/** The largest file an upload or replace may carry. Graph's simple upload takes up to 250 MB. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
/** Text up to this size is shown to the approver in full; past it, by size and digest. */
const MAX_SHOWN_TEXT_BYTES = 64 * 1024;

/** A file or folder an action changes, as it was read when the action was proposed. */
export type ItemTarget = {
  ref: ItemRef;
  name: string;
  kind: "file" | "folder";
  /** Where it is, for the approver: "Engineering › Documents › Specs". */
  location: string;
  /** Its path relative to the top of the binding, for simulated reads. */
  path: string;
  webUrl?: string;
};

/** The folder an action creates something in: a real one, or one an earlier pending action creates. */
export type FolderTarget = {
  /** An encoded item reference, or a temporary `~N`. */
  id: string;
  driveId: string;
  name: string;
  location: string;
  /** Its path relative to the top of the binding, for simulated reads. */
  path: string;
};

/** A list an action changes. */
export type ListTarget = ListRef & { name: string; webUrl?: string };

/** The Office format a file's content was written in from Markdown or rows, for the approver. */
export type WrittenAs = "word" | "powerpoint" | "excel";

/** How a written file was made, shown to the approver beside its source text. */
export type Writing = {
  as: WrittenAs;
  /** The name of the file whose look it took. */
  template?: string;
};

/** One paragraph or slide an in-place edit changed, as Markdown before and after. */
export type EditChange = { before?: string; after?: string; slide?: number; notes?: boolean };

/** What each kind of action stores. */
export type SharePointActions = {
  createFolder: { ref: string; parent: FolderTarget; name: string; submittedAt: number; createdId?: string; appliedAt?: number };
  uploadFile: {
    ref: string;
    parent: FolderTarget;
    name: string;
    file: ActionFileReference;
    mimeType: string;
    /** The content as text, when it is text short enough to show the approver in full: for a written file, its source. */
    text?: string;
    writing?: Writing;
    submittedAt: number;
    createdId?: string;
    appliedAt?: number;
  };
  replaceFile: {
    target: ItemTarget;
    file: ActionFileReference;
    mimeType: string;
    text?: string;
    /** The text the file held when the change was proposed, for the approver's diff. */
    previousText?: string;
    writing?: Writing;
    /** What the file had that a rewrite from Markdown or rows can't keep: "3 images", "comments". */
    loses?: string[];
    /** For an in-place edit, what it changed, instead of the whole content. */
    edit?: { kind: "document" | "presentation"; changes: EditChange[]; trackChanges?: boolean };
    /** The content version the change is based on; the apply is refused if it has moved. */
    ifMatch?: string;
    /** The version the replace superseded, recorded when applied: what a revert restores. */
    previousVersionId?: string;
    submittedAt: number;
    appliedAt?: number;
  };
  rename: { target: ItemTarget; name: string; ifMatch?: string; submittedAt: number; appliedAt?: number };
  move: {
    target: ItemTarget;
    /** Where it was, which a revert moves it back to. */
    from: { id: string; location: string };
    to: FolderTarget;
    ifMatch?: string;
    submittedAt: number;
    appliedAt?: number;
  };
  deleteItem: { target: ItemTarget; ifMatch?: string; submittedAt: number; appliedAt?: number };
  createListItem: {
    ref: string;
    list: ListTarget;
    fields: Record<string, FieldValue>;
    /** Display names of the fields, for the approver. */
    labels: Record<string, string>;
    submittedAt: number;
    createdId?: string;
    appliedAt?: number;
  };
  updateListItem: {
    list: ListTarget;
    itemId: string;
    title?: string;
    fields: Record<string, FieldValue>;
    labels: Record<string, string>;
    /** The values these fields held when the change was proposed: what a revert writes back. */
    before: Record<string, FieldValue>;
    ifMatch?: string;
    submittedAt: number;
    appliedAt?: number;
  };
  deleteListItem: { list: ListTarget; itemId: string; title?: string; ifMatch?: string; submittedAt: number; appliedAt?: number };
  updateCells: {
    target: ItemTarget;
    worksheet: string;
    /** The range on the worksheet, normalized: "B2:D4". */
    address: string;
    values: CellValue[][];
    /** The range's formulas (or values) when the change was proposed, for the approver. */
    before: CellValue[][];
    ifMatch?: string;
    previousVersionId?: string;
    submittedAt: number;
    appliedAt?: number;
  };
  copyFile: {
    ref: string;
    source: ItemTarget;
    parent: FolderTarget;
    name: string;
    /** The source's size and type, for showing the copy while it waits. */
    size?: number;
    mimeType?: string;
    submittedAt: number;
    createdId?: string;
    appliedAt?: number;
  };
};

/** One staged action, as the journal holds it. */
export type SharePointAction = TaggedAction<SharePointActions>;

/** What apply handlers may do. */
export type SharePointActionHost = {
  refs: ProvisionalIds<string>;
  /** Runs a write as the connection. Writes are not replayed on a credential refresh unless marked so. */
  graph<T>(op: (api: GraphApi) => Promise<T>, options?: { replayable?: boolean }): Promise<T>;
  readFile(file: ActionFileReference): Promise<Uint8Array>;
  releaseFile(file: ActionFileReference): void;
  invalidate(): Promise<void>;
};

/** The real folder an action writes into, once any temporary ID it named has been created. */
function folderRef(host: SharePointActionHost, parent: FolderTarget): ItemRef {
  const decoded = decodeItemRef(host.refs.requireResolved(parent.id));
  if ("provisional" in decoded) throw new ActionApplyError("The folder this goes in has not been created.");
  return decoded;
}

/** The refusal for a version fence that failed. */
function changedSince(what: string): ActionApplyError {
  return new ActionApplyError(`${what} changed after this was proposed, so it was not applied. Ask the agent to ` +
    "read it again and propose the change afresh.");
}

/** Maps Graph's refusals of a write onto terminal failures; anything else is retried. */
function refusal(error: unknown, what: string): never {
  if (error instanceof GraphApiError) {
    if (error.status === 412 || (error.status === 409 && !error.isNameConflict)) throw changedSince(what);
    if (error.isNameConflict) throw new ActionApplyError(`Something named the same is already there, so ${what.toLowerCase()} was not changed.`);
    if (error.status === 404) throw new ActionApplyError(`${what} no longer exists, or you no longer have access to it.`);
    if (error.status === 403) throw new ActionApplyError(`You don't have permission to change ${what.toLowerCase()} in SharePoint.`);
    if (error.status === 423) throw new ActionApplyError(`${what} is locked, probably because someone has it open. Try again later.`);
    if (error.status === 400 || error.status === 507) throw new ActionApplyError(`SharePoint refused the change: ${error.message}`);
  }
  throw error;
}

/** A worksheet's path in the workbook API, by name (a quote in the name is doubled). */
function worksheetPath(driveId: string, itemId: string, worksheet: string): string {
  return `/drives/${driveId}/items/${itemId}/workbook/worksheets('${encodeURIComponent(worksheet.replace(/'/g, "''"))}')`;
}

const logger = obsContext.createLogger({ component: "gatekeeper.microsoft.sharepoint.actions", vendorId: VENDOR_ID });

/**
 * Has Excel calculate a workbook this gatekeeper wrote, which saves its formulas' results into the
 * file. Without them, previews, the PDF view, search and anything else that reads the file without
 * opening it in Excel shows formula cells empty. Best effort: Excel still calculates on open.
 */
async function calculateWorkbook(host: Pick<SharePointActionHost, "graph">, ref: ItemRef): Promise<void> {
  try {
    await host.graph(api => api.request("POST", `/drives/${ref.driveId}/items/${ref.itemId}/workbook/application/calculate`, {
      body: { calculationType: "Full" },
    }), { replayable: true });
  } catch (error) {
    logger.warn("failed to calculate a written workbook", { event: "workbook.calculate.failed", error });
  }
}

/** How long an approval waits for SharePoint to finish a copy before trying again later. */
const COPY_WAIT_MS = 45_000;

/** Waits for a copy to finish, and returns the new file's ID. */
async function awaitCopy(host: SharePointActionHost, monitor: string): Promise<string> {
  const deadline = Date.now() + COPY_WAIT_MS;
  for (let wait = 500; ; wait = Math.min(wait * 2, 4_000)) {
    const progress = await host.graph(api => api.copyProgress(monitor), { replayable: true });
    if (progress.status === "completed" && progress.resourceId) return progress.resourceId;
    if (progress.status === "failed") {
      throw new ActionApplyError(`SharePoint couldn't copy the file${progress.error ? `: ${progress.error}` : "."}`);
    }
    if (Date.now() + wait > deadline) {
      throw new ActionApplyError("SharePoint is still copying the file. It will appear in the folder when it finishes.");
    }
    await new Promise(resolve => setTimeout(resolve, wait));
  }
}

/** `name` as a path segment Graph's `:/path:` syntax accepts. */
function pathSegment(name: string): string {
  return encodeURIComponent(name).replace(/'/g, "%27");
}

/** A Markdown-free label for a value in prose. */
function label(text: string): string {
  return plainInline(text, 80);
}

/** The approver's view of a text file's new content, or of its bytes when it is not text. */
function addContent(builder: ReturnType<typeof buildDescription>, name: string, payload: { file: ActionFileReference; mimeType: string; text?: string }): void {
  if (payload.text !== undefined) builder.verbatim("Content", payload.text);
  else builder.file("Content", { name, mediaType: payload.mimeType, size: payload.file.size, sha256: payload.file.digest, origin: "agent" });
}

const FORMAT_NAMES: Record<WrittenAs, string> = { word: "a Word document", powerpoint: "a PowerPoint deck", excel: "an Excel workbook" };

/** How a written file was made, in a sentence. */
function writingNote(writing: Writing): string {
  const source = writing.as === "excel" ? "rows" : "Markdown";
  return `Written from the ${source} below as ${FORMAT_NAMES[writing.as]}` +
    (writing.template ? `, in the style of ${label(writing.template)}.` : ".");
}

/** "a, b and c". */
function joinWords(words: readonly string[]): string {
  return words.length <= 1 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

/** The most changed paragraphs or slides shown to an approver in full. */
const MAX_SHOWN_CHANGES = 40;

/** An in-place edit's changes, each paragraph or slide as removed and added lines. */
function addEditChanges(builder: ReturnType<typeof buildDescription>, edit: NonNullable<SharePointActions["replaceFile"]["edit"]>): void {
  const count = edit.changes.length;
  const what = edit.kind === "document" ? "paragraph" : "slide";
  builder.prose(`Changes ${count} ${what}${count === 1 ? "" : "s"} in place; everything else in the file stays as it is.` +
    (edit.trackChanges ? " The changes are recorded as tracked changes, to review and accept in Word." : ""));
  const lines: string[] = [];
  for (const change of edit.changes.slice(0, MAX_SHOWN_CHANGES)) {
    if (lines.length > 0) lines.push("");
    if (change.slide !== undefined) lines.push(`@@ slide ${change.slide}${change.notes ? " notes" : ""} @@`);
    if (change.before !== undefined) for (const line of change.before.split("\n")) lines.push(`-${line}`);
    if (change.after !== undefined) for (const line of change.after.split("\n")) lines.push(`+${line}`);
  }
  if (count > MAX_SHOWN_CHANGES) lines.push("", `… and ${count - MAX_SHOWN_CHANGES} more`);
  builder.verbatim("Changes", lines.join("\n"));
}

/** A cell's value as an approver reads it. */
function cellText(value: CellValue | undefined): string {
  return value === null || value === undefined || value === "" ? "(empty)" : String(value);
}

/** The A1 address of the cell `row` rows and `column` columns from the range's top-left cell. */
export function cellAt(address: string, row: number, column: number): string {
  const match = /^([A-Z]{1,3})([0-9]+)/.exec(address)!;
  return `${columnLetters(columnIndex(match[1]!) + column)}${Number(match[2]) + row}`;
}

/** A field table of list item values, in the order given, under each column's display name. */
function addFieldValues(builder: ReturnType<typeof buildDescription>, fields: Record<string, FieldValue>,
                        labels: Record<string, string>, before?: Record<string, FieldValue>): void {
  for (const [name, value] of Object.entries(fields)) {
    const title = labels[name] ?? name;
    const shown = value === null ? "(empty)" : Array.isArray(value) ? value.join(", ") : String(value);
    if (before !== undefined && name in before) {
      const old = before[name];
      const was = old === null || old === undefined ? "(empty)" : Array.isArray(old) ? old.join(", ") : String(old);
      builder.inline(`${title} (was)`, was);
    }
    builder.inline(title, shown);
  }
}

/** Hunks as the unified diff text people read in code review: `@@` headers, then `-`, `+` and ` ` lines. */
function unifiedDiff(hunks: readonly GitDiffHunk[]): string {
  const marks = { context: " ", added: "+", removed: "-" } as const;
  return hunks.map(hunk => [hunk.header, ...hunk.lines.map(line => `${marks[line.kind]}${line.text}`)].join("\n")).join("\n");
}

/** Creates a folder, or adopts the one an earlier attempt of this same action created. */
async function createFolder(api: GraphApi, parent: ItemRef, name: string): Promise<string> {
  try {
    const created = parseDriveItem(await api.request<unknown>("POST", `/drives/${parent.driveId}/items/${parent.itemId}/children`, {
      body: { name, folder: {}, "@microsoft.graph.conflictBehavior": "fail" },
    }));
    return created.id;
  } catch (error) {
    if (!(error instanceof GraphApiError) || !error.isNameConflict) throw error;
    // At-least-once apply: a crash after Graph created the folder replays into this conflict.
    // A folder of that name is what this action wanted either way.
    const existing = parseDriveItem(await api.get<unknown>(
      `/drives/${parent.driveId}/items/${parent.itemId}:/${pathSegment(name)}`, { query: { $select: ITEM_SELECT } }));
    if (existing.kind !== "folder") throw error;
    return existing.id;
  }
}

/** The action set, bound per binding to its journal and host. */
export const actions = defineActions<SharePointActionHost, SharePointActions>({
  createFolder: {
    kind: { tag: "sharepoint.files.create", label: "Create SharePoint files and folders" },
    autoApprovable: true,
    delivery: "continue-with-simulation",
    describe: payload => {
      const builder = buildDescription(`Create a folder named ${label(payload.name)} in ${label(payload.parent.location)}.`);
      builder.inline("Name", payload.name);
      builder.inline("In", payload.parent.location);
      return {
        title: sanitizeTitle(`Create folder "${payload.name}" in SharePoint`),
        ...builder.finish(),
        implementsRevert: true,
      } satisfies ActionPresentation;
    },
    provides: payload => [payload.ref],
    dependsOn: payload => isProvisional(payload.parent.id) ? [payload.parent.id] : [],
    apply: async (payload, host) => {
      const parent = folderRef(host, payload.parent);
      let id: string;
      try {
        id = await host.graph(api => createFolder(api, parent, payload.name), { replayable: true });
      } catch (error) {
        refusal(error, "The folder");
      }
      host.refs.bind(payload.ref, encodeItemRef({ driveId: parent.driveId, itemId: id }));
      return { action: { ...payload, createdId: id, appliedAt: Date.now() } };
    },
  },

  uploadFile: {
    kind: { tag: "sharepoint.files.create", label: "Create SharePoint files and folders" },
    autoApprovable: true,
    delivery: "continue-with-simulation",
    // Graph's upload is not idempotent under "fail" conflict behavior: a replay after a crash would
    // be refused as a duplicate name, indistinguishable from someone else's file. Claimed instead.
    claimBeforeApply: true,
    describe: payload => {
      const builder = buildDescription(`Upload a new file named ${label(payload.name)} to ${label(payload.parent.location)}.`);
      builder.inline("Name", payload.name);
      builder.inline("In", payload.parent.location);
      if (payload.writing) builder.prose(writingNote(payload.writing));
      addContent(builder, payload.name, payload);
      return {
        title: sanitizeTitle(`Upload "${payload.name}" to SharePoint`),
        ...builder.finish(),
        implementsRevert: true,
      } satisfies ActionPresentation;
    },
    provides: payload => [payload.ref],
    dependsOn: payload => isProvisional(payload.parent.id) ? [payload.parent.id] : [],
    apply: async (payload, host) => {
      const parent = folderRef(host, payload.parent);
      const bytes = await host.readFile(payload.file);
      let id: string;
      try {
        id = await host.graph(async api => parseDriveItem(await api.request<unknown>("PUT",
          `/drives/${parent.driveId}/items/${parent.itemId}:/${pathSegment(payload.name)}:/content`, {
            query: { "@microsoft.graph.conflictBehavior": "fail", $select: ITEM_SELECT },
            rawBody: bytes,
            contentType: payload.mimeType,
          })).id);
      } catch (error) {
        refusal(error, "The file");
      }
      host.refs.bind(payload.ref, encodeItemRef({ driveId: parent.driveId, itemId: id }));
      host.releaseFile(payload.file);
      if (payload.writing?.as === "excel") await calculateWorkbook(host, { driveId: parent.driveId, itemId: id });
      return { action: { ...payload, createdId: id, appliedAt: Date.now() } };
    },
    reject: async (payload, host) => host.releaseFile(payload.file),
  },

  replaceFile: {
    kind: { tag: "sharepoint.files.edit", label: "Edit SharePoint files" },
    autoApprovable: true,
    delivery: "continue-with-simulation",
    describe: payload => {
      const builder = buildDescription(`Replace the content of ${label(payload.target.name)} in ${label(payload.target.location)}. ` +
        "SharePoint keeps the current content as an earlier version." +
        (payload.ifMatch ? " This is applied only if nobody has changed the file since it was proposed." : ""));
      builder.inline("File", payload.target.webUrl ?? `${payload.target.location} › ${payload.target.name}`);
      if (payload.edit) {
        addEditChanges(builder, payload.edit);
        return {
          title: sanitizeTitle(`Edit "${payload.target.name}" in SharePoint`),
          ...builder.finish(),
          implementsRevert: true,
        } satisfies ActionPresentation;
      }
      if (payload.writing) builder.prose(writingNote(payload.writing));
      if (payload.loses && payload.loses.length > 0) {
        builder.prose(`The current file has ${joinWords(payload.loses)}, which the new content doesn't keep. ` +
          "The current file stays in its version history.");
      }
      if (payload.previousText !== undefined && payload.text !== undefined) {
        const diff = diffTextLines(payload.previousText, payload.text);
        builder.prose(`${diff.additions} line${diff.additions === 1 ? "" : "s"} added, ${diff.deletions} removed.`);
        if (diff.hunks.length > 0) builder.verbatim("Changes", unifiedDiff(diff.hunks));
      }
      addContent(builder, payload.target.name, payload);
      return {
        title: sanitizeTitle(`${payload.writing || payload.loses ? "Rewrite" : "Edit"} "${payload.target.name}" in SharePoint`),
        ...builder.finish(),
        implementsRevert: true,
      } satisfies ActionPresentation;
    },
    apply: async (payload, host) => {
      const { driveId, itemId } = payload.target.ref;
      const bytes = await host.readFile(payload.file);
      let previousVersionId: string | undefined;
      try {
        // The current version, recorded first: it is what a revert restores.
        previousVersionId = await host.graph(async api => parsePage(
          await api.get<unknown>(`/drives/${driveId}/items/${itemId}/versions`, { query: { $top: 1 } }),
          parseVersion, "version").items[0]?.id, { replayable: true });
        await host.graph(api => api.request("PUT", `/drives/${driveId}/items/${itemId}/content`, {
          rawBody: bytes, contentType: payload.mimeType, ...(payload.ifMatch ? { ifMatch: payload.ifMatch } : {}),
        }));
      } catch (error) {
        refusal(error, "The file");
      }
      host.releaseFile(payload.file);
      if (payload.writing?.as === "excel") await calculateWorkbook(host, payload.target.ref);
      return { action: { ...payload, ...(previousVersionId ? { previousVersionId } : {}), appliedAt: Date.now() } };
    },
    reject: async (payload, host) => host.releaseFile(payload.file),
  },

  rename: {
    kind: { tag: "sharepoint.files.organize", label: "Rename and move SharePoint files" },
    autoApprovable: true,
    delivery: "continue-with-simulation",
    describe: payload => {
      const builder = buildDescription(`Rename the ${payload.target.kind} ${label(payload.target.name)} in ${label(payload.target.location)}.`);
      builder.inline("From", payload.target.name);
      builder.inline("To", payload.name);
      return {
        title: sanitizeTitle(`Rename "${payload.target.name}" to "${payload.name}" in SharePoint`),
        ...builder.finish(),
        implementsRevert: true,
      } satisfies ActionPresentation;
    },
    apply: async (payload, host) => {
      const { driveId, itemId } = payload.target.ref;
      try {
        await host.graph(api => api.request("PATCH", `/drives/${driveId}/items/${itemId}`, {
          body: { name: payload.name }, ...(payload.ifMatch ? { ifMatch: payload.ifMatch } : {}),
        }), { replayable: true });
      } catch (error) {
        refusal(error, payload.target.kind === "folder" ? "The folder" : "The file");
      }
      return { action: { ...payload, appliedAt: Date.now() } };
    },
  },

  move: {
    kind: { tag: "sharepoint.files.organize", label: "Rename and move SharePoint files" },
    autoApprovable: true,
    delivery: "continue-with-simulation",
    describe: payload => {
      const builder = buildDescription(`Move the ${payload.target.kind} ${label(payload.target.name)} to ${label(payload.to.location)}.` +
        (payload.target.kind === "folder" ? " Everything in it moves too, and keeps its permissions only if they were set on it directly." : ""));
      builder.inline("Name", payload.target.name);
      builder.inline("From", payload.from.location);
      builder.inline("To", payload.to.location);
      return {
        title: sanitizeTitle(`Move "${payload.target.name}" in SharePoint`),
        ...builder.finish(),
        implementsRevert: true,
      } satisfies ActionPresentation;
    },
    dependsOn: payload => isProvisional(payload.to.id) ? [payload.to.id] : [],
    apply: async (payload, host) => {
      const { driveId, itemId } = payload.target.ref;
      const destination = folderRef(host, payload.to);
      try {
        await host.graph(api => api.request("PATCH", `/drives/${driveId}/items/${itemId}`, {
          body: { parentReference: { id: destination.itemId } }, ...(payload.ifMatch ? { ifMatch: payload.ifMatch } : {}),
        }), { replayable: true });
      } catch (error) {
        refusal(error, payload.target.kind === "folder" ? "The folder" : "The file");
      }
      return { action: { ...payload, appliedAt: Date.now() } };
    },
  },

  deleteItem: {
    kind: { tag: "sharepoint.files.delete", label: "Delete SharePoint files" },
    delivery: "continue-with-simulation",
    describe: payload => {
      const builder = buildDescription(`Delete the ${payload.target.kind} ${label(payload.target.name)} from ${label(payload.target.location)}` +
        (payload.target.kind === "folder" ? ", with everything in it" : "") +
        ". It goes to the site's recycle bin, where it can be restored from SharePoint for 93 days." +
        (payload.ifMatch ? " This is applied only if nobody has changed it since it was proposed." : ""));
      builder.inline(payload.target.kind === "folder" ? "Folder" : "File", payload.target.webUrl ?? `${payload.target.location} › ${payload.target.name}`);
      return {
        title: sanitizeTitle(`Delete "${payload.target.name}" from SharePoint`),
        ...builder.finish(),
        implementsRevert: false,
      } satisfies ActionPresentation;
    },
    apply: async (payload, host) => {
      const { driveId, itemId } = payload.target.ref;
      try {
        await host.graph(api => api.request("DELETE", `/drives/${driveId}/items/${itemId}`, {
          ...(payload.ifMatch ? { ifMatch: payload.ifMatch } : {}),
          // A replay after the first attempt deleted it finds nothing, which is the goal.
          allow: [404],
        }), { replayable: true });
      } catch (error) {
        refusal(error, payload.target.kind === "folder" ? "The folder" : "The file");
      }
      return { action: { ...payload, appliedAt: Date.now() } };
    },
  },

  updateCells: {
    kind: { tag: "sharepoint.files.edit", label: "Edit SharePoint files" },
    autoApprovable: true,
    delivery: "continue-with-simulation",
    describe: payload => {
      const builder = buildDescription(`Set ${payload.address} on the worksheet ${label(payload.worksheet)} of ` +
        `${label(payload.target.name)} in ${label(payload.target.location)}. Every other cell, formula, format and sheet ` +
        "stays as it is, and SharePoint keeps the current workbook as an earlier version." +
        (payload.ifMatch ? " This is applied only if nobody has changed the workbook since it was proposed." : ""));
      builder.inline("Workbook", payload.target.webUrl ?? `${payload.target.location} › ${payload.target.name}`);
      builder.inline("Range", `${payload.worksheet}!${payload.address}`);
      const rows: string[] = [];
      payload.values.forEach((row, rowIndex) => row.forEach((value, columnOffset) => {
        const before = payload.before[rowIndex]?.[columnOffset];
        if (cellText(before) !== cellText(value)) rows.push(`${cellAt(payload.address, rowIndex, columnOffset)}: ${cellText(before)} → ${cellText(value)}`);
      }));
      if (rows.length === 0) builder.prose("Every cell already holds what this writes.");
      else builder.list(`${rows.length} cell${rows.length === 1 ? "" : "s"} change`, rows.length > 200 ? [...rows.slice(0, 200), `… and ${rows.length - 200} more`] : rows);
      return {
        title: sanitizeTitle(`Edit cells ${payload.address} in "${payload.target.name}" in SharePoint`),
        ...builder.finish(),
        implementsRevert: true,
      } satisfies ActionPresentation;
    },
    apply: async (payload, host) => {
      const { driveId, itemId } = payload.target.ref;
      let previousVersionId: string | undefined;
      try {
        // The workbook API has no If-Match, so the fence is checked just before the write. It is the
        // content tag a read saw, or the eTag an agent passed as `ifUnchanged`, as Graph's If-Match takes either.
        if (payload.ifMatch) {
          const current = await host.graph(async api => parseDriveItem(await api.get<unknown>(`/drives/${driveId}/items/${itemId}`,
            { query: { $select: ITEM_SELECT } })), { replayable: true });
          if (current.cTag !== payload.ifMatch && current.eTag !== payload.ifMatch) throw changedSince("The workbook");
        }
        previousVersionId = await host.graph(async api => parsePage(
          await api.get<unknown>(`/drives/${driveId}/items/${itemId}/versions`, { query: { $top: 1 } }),
          parseVersion, "version").items[0]?.id, { replayable: true });
        // Writing the same values twice changes nothing, so a replay after a lost answer is safe.
        await host.graph(api => api.request("PATCH", `${worksheetPath(driveId, itemId, payload.worksheet)}/range(address='${payload.address}')`, {
          body: { formulas: payload.values.map(row => row.map(value => value ?? "")) },
        }), { replayable: true });
      } catch (error) {
        if (error instanceof ActionApplyError) throw error;
        refusal(error, "The workbook");
      }
      return { action: { ...payload, ...(previousVersionId ? { previousVersionId } : {}), appliedAt: Date.now() } };
    },
  },

  copyFile: {
    kind: { tag: "sharepoint.files.create", label: "Create SharePoint files and folders" },
    autoApprovable: true,
    delivery: "continue-with-simulation",
    // A replayed copy would make a second file, or be refused as a duplicate name. Claimed instead.
    claimBeforeApply: true,
    describe: payload => {
      const builder = buildDescription(`Copy ${label(payload.source.name)} from ${label(payload.source.location)} to ` +
        `${label(payload.parent.location)}${payload.name !== payload.source.name ? ` as ${label(payload.name)}` : ""}. ` +
        "The copy keeps the file's content, formatting and properties.");
      builder.inline("From", payload.source.webUrl ?? `${payload.source.location} › ${payload.source.name}`);
      builder.inline("To", `${payload.parent.location} › ${payload.name}`);
      return {
        title: sanitizeTitle(`Copy "${payload.source.name}" to "${payload.parent.name}" in SharePoint`),
        ...builder.finish(),
        implementsRevert: true,
      } satisfies ActionPresentation;
    },
    provides: payload => [payload.ref],
    dependsOn: payload => isProvisional(payload.parent.id) ? [payload.parent.id] : [],
    apply: async (payload, host) => {
      const parent = folderRef(host, payload.parent);
      const { driveId, itemId } = payload.source.ref;
      let createdId: string;
      try {
        const monitor = await host.graph(api => api.startCopy(`/drives/${driveId}/items/${itemId}/copy`,
          { parentReference: { driveId: parent.driveId, id: parent.itemId }, name: payload.name },
          { "@microsoft.graph.conflictBehavior": "fail" }));
        createdId = await awaitCopy(host, monitor);
      } catch (error) {
        if (error instanceof ActionApplyError) throw error;
        refusal(error, "The file");
      }
      host.refs.bind(payload.ref, encodeItemRef({ driveId: parent.driveId, itemId: createdId }));
      return { action: { ...payload, createdId, appliedAt: Date.now() } };
    },
  },

  createListItem: {
    kind: { tag: "sharepoint.lists.edit", label: "Add and edit SharePoint list items" },
    autoApprovable: true,
    delivery: "continue-with-simulation",
    // Graph has no idempotency key for list items: a replay would add a second item.
    claimBeforeApply: true,
    describe: payload => {
      const builder = buildDescription(`Add an item to the list ${label(payload.list.name)}.`);
      addFieldValues(builder, payload.fields, payload.labels);
      return {
        title: sanitizeTitle(`Add an item to "${payload.list.name}" in SharePoint`),
        ...builder.finish(),
        implementsRevert: true,
      } satisfies ActionPresentation;
    },
    provides: payload => [payload.ref],
    apply: async (payload, host) => {
      let id: string;
      try {
        id = await host.graph(async api => parseListItem(await api.request<unknown>("POST",
          `/sites/${payload.list.siteId}/lists/${payload.list.listId}/items`, { body: { fields: payload.fields } })).id);
      } catch (error) {
        refusal(error, "The list");
      }
      host.refs.bind(payload.ref, id);
      return { action: { ...payload, createdId: id, appliedAt: Date.now() } };
    },
  },

  updateListItem: {
    kind: { tag: "sharepoint.lists.edit", label: "Add and edit SharePoint list items" },
    autoApprovable: true,
    delivery: "continue-with-simulation",
    describe: payload => {
      const builder = buildDescription(`Change ${Object.keys(payload.fields).length === 1 ? "a value" : "values"} of ` +
        `${payload.title ? `the item ${label(payload.title)}` : `item ${payload.itemId}`} in the list ${label(payload.list.name)}.` +
        (payload.ifMatch ? " This is applied only if nobody has changed the item since it was proposed." : ""));
      addFieldValues(builder, payload.fields, payload.labels, payload.before);
      return {
        title: sanitizeTitle(`Edit ${payload.title ? `"${payload.title}"` : `item ${payload.itemId}`} in "${payload.list.name}"`),
        ...builder.finish(),
        implementsRevert: true,
      } satisfies ActionPresentation;
    },
    dependsOn: payload => isProvisional(payload.itemId) ? [payload.itemId] : [],
    apply: async (payload, host) => {
      const itemId = host.refs.requireResolved(payload.itemId);
      try {
        await host.graph(api => api.request("PATCH",
          `/sites/${payload.list.siteId}/lists/${payload.list.listId}/items/${itemId}/fields`, {
            body: payload.fields, ...(payload.ifMatch ? { ifMatch: payload.ifMatch } : {}),
          }), { replayable: true });
      } catch (error) {
        refusal(error, "The item");
      }
      return { action: { ...payload, appliedAt: Date.now() } };
    },
  },

  deleteListItem: {
    kind: { tag: "sharepoint.lists.delete", label: "Delete SharePoint list items" },
    delivery: "continue-with-simulation",
    describe: payload => {
      const builder = buildDescription(`Delete ${payload.title ? `the item ${label(payload.title)}` : `item ${payload.itemId}`} ` +
        `from the list ${label(payload.list.name)}. It goes to the site's recycle bin.`);
      if (payload.title) builder.inline("Item", payload.title);
      builder.inline("List", payload.list.webUrl ?? payload.list.name);
      return {
        title: sanitizeTitle(`Delete ${payload.title ? `"${payload.title}"` : `item ${payload.itemId}`} from "${payload.list.name}"`),
        ...builder.finish(),
        implementsRevert: false,
      } satisfies ActionPresentation;
    },
    dependsOn: payload => isProvisional(payload.itemId) ? [payload.itemId] : [],
    apply: async (payload, host) => {
      const itemId = host.refs.requireResolved(payload.itemId);
      try {
        await host.graph(api => api.request("DELETE", `/sites/${payload.list.siteId}/lists/${payload.list.listId}/items/${itemId}`, {
          ...(payload.ifMatch ? { ifMatch: payload.ifMatch } : {}), allow: [404],
        }), { replayable: true });
      } catch (error) {
        refusal(error, "The item");
      }
      return { action: { ...payload, appliedAt: Date.now() } };
    },
  },
}, {
  // Every kind acts as one Microsoft 365 user. Fenced on their stable (tenant, object) ID rather than
  // the connection generation, so a reconnect of the same user does not strand pending changes.
  fence: "authority",
  retainApplied: true,
  isResolvedReference: (host, ref) => host.refs.isResolved(ref),
  afterResolve: host => host.invalidate(),
  vendorId: VENDOR_ID,
});

/** The outcome `revertAction` reports. */
export type RevertOutcome = void | { message?: string; canRetry?: boolean; restart?: boolean };

/**
 * Undoes an applied action: a created file, folder or item is deleted, a replaced file's previous
 * version restored, a rename or move put back, and a list item's old values written back. Deletions
 * cannot be undone through Graph, which has no recycle bin restore.
 */
export async function revert(action: SharePointAction, host: SharePointActionHost): Promise<RevertOutcome> {
  switch (action.kind) {
    case "createFolder":
    case "uploadFile": {
      const { payload } = action;
      if (payload.createdId === undefined) return { message: "It was never created, so there is nothing to undo.", canRetry: false };
      const parent = folderRef(host, payload.parent);
      await host.graph(api => api.request("DELETE", `/drives/${parent.driveId}/items/${payload.createdId}`, { allow: [404] }),
        { replayable: true });
      return;
    }
    case "replaceFile": {
      const { payload } = action;
      if (payload.previousVersionId === undefined) {
        return { message: "SharePoint kept no earlier version of this file to restore.", canRetry: false };
      }
      const { driveId, itemId } = payload.target.ref;
      await host.graph(api => api.request("POST", `/drives/${driveId}/items/${itemId}/versions/${payload.previousVersionId}/restoreVersion`),
        { replayable: true });
      return;
    }
    case "rename": {
      const { driveId, itemId } = action.payload.target.ref;
      await host.graph(api => api.request("PATCH", `/drives/${driveId}/items/${itemId}`, { body: { name: action.payload.target.name } }),
        { replayable: true });
      return;
    }
    case "move": {
      const { driveId, itemId } = action.payload.target.ref;
      const from = decodeItemRef(action.payload.from.id);
      if ("provisional" in from) return { message: "The folder it came from no longer exists.", canRetry: false };
      await host.graph(api => api.request("PATCH", `/drives/${driveId}/items/${itemId}`, {
        body: { parentReference: { id: from.itemId } },
      }), { replayable: true });
      return;
    }
    case "updateCells": {
      const { payload } = action;
      if (payload.previousVersionId === undefined) {
        return { message: "SharePoint kept no earlier version of this workbook to restore.", canRetry: false };
      }
      const { driveId, itemId } = payload.target.ref;
      await host.graph(api => api.request("POST", `/drives/${driveId}/items/${itemId}/versions/${payload.previousVersionId}/restoreVersion`),
        { replayable: true });
      return;
    }
    case "copyFile": {
      const { payload } = action;
      if (payload.createdId === undefined) return { message: "It was never copied, so there is nothing to undo.", canRetry: false };
      const parent = folderRef(host, payload.parent);
      await host.graph(api => api.request("DELETE", `/drives/${parent.driveId}/items/${payload.createdId}`, { allow: [404] }),
        { replayable: true });
      return;
    }
    case "deleteItem":
      return { message: "Deleted files can't be restored automatically. Restore it from the site's recycle bin in SharePoint.", canRetry: false };
    case "createListItem": {
      const { payload } = action;
      if (payload.createdId === undefined) return { message: "It was never created, so there is nothing to undo.", canRetry: false };
      await host.graph(api => api.request("DELETE", `/sites/${payload.list.siteId}/lists/${payload.list.listId}/items/${payload.createdId}`,
        { allow: [404] }), { replayable: true });
      return;
    }
    case "updateListItem": {
      const { payload } = action;
      const itemId = host.refs.resolve(payload.itemId);
      await host.graph(api => api.request("PATCH", `/sites/${payload.list.siteId}/lists/${payload.list.listId}/items/${itemId}/fields`, {
        body: payload.before,
      }), { replayable: true });
      return;
    }
    case "deleteListItem":
      return { message: "Deleted list items can't be restored automatically. Restore it from the site's recycle bin in SharePoint.", canRetry: false };
  }
}

/** The temporary IDs an action provides, for working out which pending actions build on it. */
export function providedRefs(action: SharePointAction): string[] {
  switch (action.kind) {
    case "createFolder":
    case "uploadFile":
    case "copyFile":
    case "createListItem":
      return [action.payload.ref];
    default:
      return [];
  }
}

/** The temporary IDs an action depends on. */
export function dependedRefs(action: SharePointAction): string[] {
  switch (action.kind) {
    case "createFolder":
    case "uploadFile":
    case "copyFile":
      return isProvisional(action.payload.parent.id) ? [action.payload.parent.id] : [];
    case "move":
      return isProvisional(action.payload.to.id) ? [action.payload.to.id] : [];
    case "updateListItem":
    case "deleteListItem":
      return isProvisional(action.payload.itemId) ? [action.payload.itemId] : [];
    default:
      return [];
  }
}

/** File handles pending actions still hold, for sweeping captured bytes nothing references. */
export function fileHandles(action: SharePointAction): string[] {
  return action.kind === "uploadFile" || action.kind === "replaceFile" ? [action.payload.file.handle] : [];
}

/** The bytes as text to show the approver in full, or undefined when they are binary or too long. */
export function showableText(bytes: Uint8Array, mimeType: string): string | undefined {
  if (bytes.byteLength > MAX_SHOWN_TEXT_BYTES || !/^text\/|^application\/(json|xml|csv)|\+xml$|\+json$/.test(mimeType)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return undefined;
  }
}
