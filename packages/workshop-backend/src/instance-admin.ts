// The rules and texts the Workshop applies to the instance admin Gatekeeper's binding
// (packages/gatekeeper-instanceadmin): how a call's arguments are queued, the approval cards and
// observations the owner reads, which turns may use the binding, and what a result may hold. Pure,
// so each rule is tested on its own; the Overseer applies them (see docs/admin-access.md).

import { RpcStub, RpcTarget } from "cloudflare:workers";
import type {
  AdminApi, AdminWorkspaceMethod, AiChatMessage,
} from "@gadgets/workshop-shared/api";
import {
  ACTION_FIELD_INVISIBLE_CHARS, actionFieldJson, type ActionDescription, type ActionField,
  type ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import {
  INSTANCE_ADMIN_APPROVAL_LIFETIME_SECONDS, INSTANCE_ADMIN_RUN_LIMIT_SECONDS,
  INSTANCE_ADMIN_VENDOR_ID,
} from "@gadgets/workshop-shared/instance-admin";
import { isTurnPrompt } from "./agent-compaction";
import type { GatekeeperRecord } from "./storage-schema/overseer-storage";

/**
 * The most UTF-16 code units the strings of one instance admin action may hold together: the
 * call's canonical JSON, and its card's title, description, field labels and values. V8 stores a
 * string in at most two bytes a code unit, so this keeps the action's record under 96 KiB (the bound
 * gatekeeper-kit's MAX_ACTION_DESCRIPTION_BYTES keeps), inside the 128 KiB a Durable Object value may
 * take. The longest text an AdminApi setter keeps is 8,000 characters
 * (MAX_INSTANCE_INSTRUCTIONS_LENGTH): ordinary text of that length fits, and text dense in
 * characters the call's JSON or its card escapes (controls, zero-width or bidirectional
 * characters, six characters each once escaped) is refused with R13.
 */
export const MAX_INSTANCE_ADMIN_ACTION_CHARS = 40_000;

/** A call's arguments as the Workshop queues them: canonical JSON (own enumerable string keys sorted
 * at every level, "__proto__" an ordinary key, trailing undefined arguments dropped, undefined
 * properties dropped) and the values parsed back from it, which the card shows and the apply passes. */
export type CanonicalAdminCall = { json: string; args: unknown[] };

// The deepest a queued argument, or a walked result, may nest: containers within containers,
// counting the outermost.
const MAX_DEPTH = 64;

// The longest value an inline field shows, as gatekeeper-kit's MAX_INLINE_TEXT.
const MAX_INLINE_CHARS = 120;

// How much of a call's arguments an observation keeps, in UTF-8 bytes of their JSON.
const MAX_OBSERVED_ARGUMENTS_BYTES = 16 * 1024;

// The most an observation walks of a call's arguments before writing their JSON: values visited,
// plus the length of each key and string. Far more than a read's or a queued call's arguments hold;
// it bounds the walk because RPC keeps a value two branches share, which JSON writes once for each.
const MAX_OBSERVED_ARGUMENTS_WALK = 1024 * 1024;

// How much of a directory title a full inspection's card shows, and of an error an observation keeps.
const MAX_CARD_TITLE_CHARS = 256;
const MAX_OBSERVED_ERROR_CHARS = 2_000;

const INVISIBLE = new RegExp(`[${ACTION_FIELD_INVISIBLE_CHARS}]`, "u");

const APPROVAL_MINUTES = INSTANCE_ADMIN_APPROVAL_LIFETIME_SECONDS / 60;

// "40000" -> "40,000", without depending on the runtime's locale data.
function withThousands(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

const TOO_LARGE = "This call's arguments are too large for an approval card: with the card that " +
    `shows them, they may take at most ${withThousands(MAX_INSTANCE_ADMIN_ACTION_CHARS)} characters.`;

// A capability the binding must never hand on: a function (every stub is callable), a stub, or an
// RpcTarget. capnweb's RpcTarget is workerd's own inside workerd, so one check covers both.
function isCapability(value: unknown): boolean {
  return typeof value === "function" || value instanceof RpcTarget || value instanceof RpcStub;
}

function pathTo(path: string, key: string | number): string {
  if (typeof key === "number") return `${path}[${key}]`;
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

function notQueueable(path: string, what: string): TypeError {
  return new TypeError(`${path}: ${what} can't be queued for approval; only JSON values can.`);
}

// What a value JSON can't represent is, for R12.
function nonJsonKind(value: unknown): string {
  switch (typeof value) {
    case "function": return "a function or stub";
    case "undefined": return "undefined";
    case "bigint": return "a bigint";
    case "symbol": return "a symbol";
    case "number": return String(value);
  }
  if (isCapability(value)) return value instanceof RpcTarget ? "an RpcTarget" : "a stub";
  if (value instanceof Date) return "a Date";
  if (value instanceof Map) return "a Map";
  if (value instanceof Set) return "a Set";
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return "bytes";
  return "an object that isn't plain";
}

// The characters of a call's JSON written so far, and the object keys visited, undefined members
// included, counted across the whole walk. A value two branches share is visited once for each, and
// RPC keeps such sharing, so a small message can stand for a JSON that doubles with each level, or
// for one object of many undefined members visited many times: R13 is thrown as soon as either
// count passes MAX_INSTANCE_ADMIN_ACTION_CHARS, which keeps the walk within it.
type JsonSize = { chars: number; keys: number };

function grow(size: JsonSize, chars: number): void {
  size.chars += chars;
  if (size.chars > MAX_INSTANCE_ADMIN_ACTION_CHARS) throw new Error(TOO_LARGE);
}

function visitKeys(size: JsonSize, keys: number): void {
  size.keys += keys;
  if (size.keys > MAX_INSTANCE_ADMIN_ACTION_CHARS) throw new Error(TOO_LARGE);
}

// The canonical JSON of `value`, which sits at `path`, `depth` containers deep counting itself.
// `open` holds the containers enclosing it, to tell a cycle from a value shared by two branches.
function canonicalJson(value: unknown, path: string, depth: number, open: Set<object>,
    size: JsonSize): string {
  if (value === null || typeof value === "boolean" || typeof value === "string" ||
      typeof value === "number" && Number.isFinite(value)) {
    let json = JSON.stringify(value);
    grow(size, json.length);
    return json;
  }
  if (typeof value !== "object" || isCapability(value)) throw notQueueable(path, nonJsonKind(value));
  let prototype = Object.getPrototypeOf(value);
  let isArray = Array.isArray(value) && prototype === Array.prototype;
  if (!isArray && prototype !== Object.prototype && prototype !== null) {
    throw notQueueable(path, nonJsonKind(value));
  }
  if (open.has(value)) throw notQueueable(path, "a cycle");
  if (depth > MAX_DEPTH) throw notQueueable(path, `nesting deeper than ${MAX_DEPTH} levels`);
  open.add(value);
  grow(size, 2);
  let json: string;
  if (isArray) {
    let array = value as unknown[];
    let items: string[] = [];
    for (let i = 0; i < array.length; i++) {
      if (!Object.hasOwn(array, i)) throw notQueueable(pathTo(path, i), "an empty array slot");
      if (i > 0) grow(size, 1);
      items.push(canonicalJson(array[i], pathTo(path, i), depth + 1, open, size));
    }
    json = `[${items.join(",")}]`;
  } else {
    let record = value as Record<string, unknown>;
    let members: string[] = [];
    let keys = Object.keys(record);
    visitKeys(size, keys.length);
    for (let key of keys.toSorted()) {
      let member = record[key];
      if (member === undefined) continue;
      let name = JSON.stringify(key);
      grow(size, name.length + (members.length > 0 ? 2 : 1));
      members.push(`${name}:${canonicalJson(member, pathTo(path, key), depth + 1, open, size)}`);
    }
    json = `{${members.join(",")}}`;
  }
  open.delete(value);
  return json;
}

/** Throws a TypeError (R12) naming the path for anything but JSON values: functions, stubs and
 * RpcTargets, Date, Map, Set, bytes and buffers, bigint, symbols, non-finite numbers, undefined inside
 * an array or before the last argument, cycles, depth over 64. Throws R13 when the JSON alone
 * passes MAX_INSTANCE_ADMIN_ACTION_CHARS, since no card can then fit, as soon as the walk gets
 * there; a value refused on both counts may give either. */
export function canonicalAdminCall(args: readonly unknown[]): CanonicalAdminCall {
  // One past the last argument that isn't undefined, found from the elements present: a sparse
  // array's length can be billions with nothing in it. A hole before it is refused by the walk.
  let count = 0;
  for (let key of Object.keys(args)) {
    let index = Number(key);
    if (Number.isInteger(index) && args[index] !== undefined) count = Math.max(count, index + 1);
  }
  let open = new Set<object>();
  let size: JsonSize = { chars: 0, keys: 0 };
  grow(size, 2);
  let items: string[] = [];
  for (let i = 0; i < count; i++) {
    if (i > 0) grow(size, 1);
    items.push(canonicalJson(args[i], `args[${i}]`, 1, open, size));
  }
  let json = `[${items.join(",")}]`;
  return { json, args: JSON.parse(json) as unknown[] };
}

const encoder = new TextEncoder();

function utf8Length(text: string): number {
  return encoder.encode(text).byteLength;
}

// `text` cut to at most `maxChars` code units, never between the halves of a surrogate pair.
function cutChars(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  let cut = maxChars;
  let last = text.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut--;
  return text.slice(0, cut);
}

// `text` cut to at most `maxBytes` of UTF-8, on a code point boundary.
function cutBytes(text: string, maxBytes: number): string {
  let bytes = encoder.encode(text);
  if (bytes.byteLength <= maxBytes) return text;
  let cut = maxBytes;
  // A continuation byte is 10xxxxxx; step back to the start of the code point it belongs to.
  while (cut > 0 && (bytes[cut]! & 0xc0) === 0x80) cut--;
  return new TextDecoder().decode(bytes.subarray(0, cut));
}

// A value one line shows exactly, as gatekeeper-kit's fitsInline: short, with no line break, tab,
// run of spaces or edge whitespace a reader would miss.
function fitsInline(value: string): boolean {
  return value.length <= MAX_INLINE_CHARS && !/[\r\n\t]| {2}/.test(value) &&
      value.trim() === value;
}

/** The field for one string an instance admin card shows, so no invisible or reordering character
 * hides in it: inline when it fits one line exactly (at most 120 characters; no CR, LF, tab, run of
 * spaces or edge whitespace) and holds no ACTION_FIELD_INVISIBLE_CHARS character; text when it holds
 * neither such a character nor a CR; otherwise json (actionFieldJson). `maxChars` cuts the value
 * first and sets `truncated`. */
export function instanceAdminStringField(label: string, value: string, maxChars?: number):
    ActionField {
  let shown = maxChars === undefined ? value : cutChars(value, maxChars);
  let truncated = shown === value
      ? {} : { truncated: { shownBytes: utf8Length(shown), totalBytes: utf8Length(value) } };
  if (INVISIBLE.test(shown) || shown.includes("\r")) {
    // A string always has a JSON text.
    return { label, kind: "json", value: actionFieldJson(shown)!, ...truncated };
  }
  return { label, kind: fitsInline(shown) ? "inline" : "text", value: shown, ...truncated };
}

// The field for one queued argument: a string as instanceAdminStringField shows it, any other
// value as JSON. The value came from JSON.parse, so it has a JSON text.
function argumentField(label: string, value: unknown): ActionField {
  return typeof value === "string"
      ? instanceAdminStringField(label, value)
      : { label, kind: "json", value: actionFieldJson(value)! };
}

// Whether JSON.stringify(args) walks at most MAX_OBSERVED_ARGUMENTS_WALK; it stops as soon as it
// would pass. Each value also counts the indentation its line, and an object's closing line, get
// when pretty-printed: two spaces per level, which nothing else bounds, since a read's arguments are
// never canonicalized. Undefined when the arguments have no JSON (a cycle, a bigint).
function argumentsWalkFits(args: readonly unknown[]): boolean | undefined {
  let left = MAX_OBSERVED_ARGUMENTS_WALK;
  // The depth of each object being written; the stringify wrapper around `args` is absent, at -1.
  // A shared object is written again at its new depth, and its members follow at once.
  let depths = new Map<object, number>();
  try {
    JSON.stringify(args, function(this: object, key: string, value: unknown) {
      let depth = (depths.get(this) ?? -1) + 1;
      let lines = 1;
      if (typeof value === "object" && value !== null) {
        depths.set(value, depth);
        lines = 2;
      }
      left -= lines * (1 + 2 * depth) + key.length +
          (typeof value === "string" ? value.length : 0);
      if (left < 0) throw new RangeError("too large");
      return value;
    });
    return true;
  } catch {
    return left < 0 ? false : undefined;
  }
}

// A call's arguments as an observation keeps them: their JSON, cut over 16 KiB.
function observedArgumentsField(args: readonly unknown[]): ActionField {
  let fits = argumentsWalkFits(args);
  if (fits === false) return { label: "Arguments", kind: "inline", value: "(too large to show)" };
  let json = fits ? actionFieldJson(args) : undefined;
  if (json === undefined) {
    return { label: "Arguments", kind: "inline", value: "(not representable as JSON)" };
  }
  let shown = cutBytes(json, MAX_OBSERVED_ARGUMENTS_BYTES);
  return shown === json
      ? { label: "Arguments", kind: "json", value: json }
      : { label: "Arguments", kind: "json", value: shown,
          truncated: { shownBytes: utf8Length(shown), totalBytes: utf8Length(json) } };
}

/** `method` as words: "setAnnouncement" -> "Set announcement". */
export function sentenceCase(method: string): string {
  let words = method.replace(/[A-Z]/g, c => ` ${c.toLowerCase()}`).trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// Every instance admin card: complete, never revertible, waited on, and with no actionKind or
// autoApprovable, so no auto-approval rule can ever match it.
const CARD = { descriptionIsComplete: true, implementsRevert: false, awaitDecision: true } as const;

function activationIntro(again: string): string {
  return `Lets this workspace's agent use the deployment's Admin API as you${again}, while you ` +
    "are a deployment admin, in turns that answer a message you wrote yourself here: not one a " +
    "gadget's callback or a connection's slash command started, nor in a spawned chat or a " +
    "blueprint update's review. Reads (the settings, the user and workspace directory, the admin " +
    "audit log, update status and workspace metadata) run at once and are recorded in this " +
    "workspace's activity. Every settings change, every gateway test (which the providers bill) " +
    "and every opening of a workspace's content waits for your approval, call by call, and the " +
    "deployment's admin audit log records inspections and changes as yours, made through this agent.";
}

const OTHER_ADMINS = "Other deployment admins can still inspect it, as they can any workspace; " +
  "their inspections are recorded in the admin audit log.";

const PERMANENCE = "**Part of this is permanent.** From now on only you can open this workspace, " +
  "because what its agent reads here is deployment admin data: it can't be shared and takes no " +
  "external messages. It is also restricted: no public web fetches, and every action waits for " +
  "your approval. You can turn admin access off again at any time from the Activity panel; the " +
  `workspace stays yours alone. ${OTHER_ADMINS}`;

const STILL_PRIVATE = "This workspace already is yours alone and restricted, and stays so. You " +
  "can turn admin access off again at any time from the Activity panel. " + OTHER_ADMINS;

const EXFILTRATION_WARNING = "**Prompt injection can leak what the agent reads.** Everything it " +
  "reads goes into this chat, to the chat's AI model provider and into the deployment's AI Gateway " +
  "logs. Text it reads (a user's name, a workspace title, a chat, an audit reason, a web page), and " +
  "text others put in every agent's instructions (the deployment's instance instructions, which " +
  "any admin sets, and the names of its standard formats, which blueprint authors write), can " +
  "steer it to send admin data out through this workspace's other connections (web search, MCP " +
  "servers, other gatekeepers), through its gadgets, or through blueprints you publish from it. " +
  "Use a dedicated workspace, and connect nothing else to it. Connections that every one of your " +
  "workspaces gets, such as Web Search, are in this one too, and a search query can carry data " +
  "out: remove the optional ones from Connectors (which removes them from all your workspaces), " +
  "or ask an admin to disable them.";

/** The card asking the owner to turn deployment admin access on in the workspace: the first time,
 * or, with `reactivation`, again after they turned it off. */
export function instanceAdminActivationCard(reactivation: boolean): ActionDescription {
  return reactivation
    ? {
      title: "Turn deployment admin access back on in this workspace",
      description: [activationIntro(" again"), STILL_PRIVATE, EXFILTRATION_WARNING].join("\n\n"),
      ...CARD,
    }
    : {
      title: "Turn on deployment admin access in this workspace",
      description: [activationIntro(""), PERMANENCE, EXFILTRATION_WARNING].join("\n\n"),
      ...CARD,
    };
}

const CALL_DESCRIPTIONS = {
  change: "Approving makes this call to the deployment's Admin API as you, with exactly the " +
    "arguments below, once. The deployment's admin audit log records the change as yours, made " +
    "through this workspace's agent.",
  confirm: "Approving lets your agent make this one call to the deployment's Admin API as you, " +
    "with exactly the arguments below, as its next identical call in this chat within " +
    `${APPROVAL_MINUTES} minutes. It sends requests through the deployment's AI Gateway, which ` +
    "the providers bill. It changes no setting.",
  inspect: "Approving lets your agent open this workspace with full access as you (its chats, " +
    "files and the descriptions of its actions, as far as the deployment's admin access level " +
    "allows), as its next identical call in this chat within " +
    `${APPROVAL_MINUTES} minutes; the view works only until that executeCode call ends. The ` +
    "deployment's admin audit log records the open and every read as yours, made through this " +
    "agent, with this reason.",
};

/** The card asking the owner to approve one queued AdminApi call: a change (`kind` "change"), a
 * paid call ("confirm"), or an inspection asking for "full" ("inspect"), for which
 * `workspaceTitle` is the directory's title of the workspace it opens. */
export function instanceAdminCallCard(kind: "change" | "confirm" | "inspect", method: keyof AdminApi,
    call: CanonicalAdminCall, workspaceTitle?: string): ActionDescription {
  let title = kind === "inspect"
    ? "Inspect a workspace with full access (deployment admin)"
    : `${sentenceCase(method)} (deployment admin${kind === "confirm" ? ", billed" : ""})`;
  let fields: ActionField[] = [
    { label: "Method", kind: "inline", value: `AdminApi.${method}` },
    ...call.args.map((arg, i) => argumentField(`Argument ${i + 1}`, arg)),
  ];
  if (kind === "inspect" && call.args.length > 0) {
    fields.push(argumentField("Workspace", call.args[0]));
    if (workspaceTitle !== undefined) {
      fields.push(instanceAdminStringField(
          "Title in the directory", workspaceTitle, MAX_CARD_TITLE_CHARS));
    }
  }
  return { title, description: CALL_DESCRIPTIONS[kind], fields, ...CARD };
}

/** The UTF-16 code units the record of an action queued for `call` with `card` holds in those
 * strings: call.json, the card's title and description, and each field's label and value. */
export function instanceAdminActionChars(call: CanonicalAdminCall, card: ActionDescription): number {
  let chars = call.json.length + card.title.length + card.description.length;
  for (let field of card.fields ?? []) {
    chars += field.label.length;
    switch (field.kind) {
      case "list": for (let item of field.items) chars += item.length; break;
      case "file": chars += field.name.length + field.mediaType.length; break;
      default: chars += field.value.length;
    }
  }
  return chars;
}

/** Throws R13 when instanceAdminActionChars(call, card) passes MAX_INSTANCE_ADMIN_ACTION_CHARS.
 * The Overseer calls it right before it queues the action, so a call too large to store is refused
 * in words rather than failing in the storage write. */
export function assertInstanceAdminActionFits(call: CanonicalAdminCall, card: ActionDescription):
    void {
  if (instanceAdminActionChars(call, card) > MAX_INSTANCE_ADMIN_ACTION_CHARS) {
    throw new Error(TOO_LARGE);
  }
}

// What an observation says of a call's result: each top-level array's length and boolean, as
// "users: 12, ok: true"; "items: N" for a result that is an array and "value: B" for a boolean.
// The data itself stays out of it.
function resultSummary(value: unknown): string {
  if (Array.isArray(value)) return `items: ${value.length}`;
  if (typeof value === "boolean") return `value: ${value}`;
  if (typeof value !== "object" || value === null) return "";
  let parts: string[] = [];
  for (let [key, member] of Object.entries(value)) {
    if (Array.isArray(member)) parts.push(`${key}: ${member.length}`);
    else if (typeof member === "boolean") parts.push(`${key}: ${member}`);
  }
  return parts.join(", ");
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return String(error);
  } catch {
    return "(an error that can't be shown as text)";
  }
}

/** The observation of an AdminApi call that ran: a read, or a call the owner approved one at a
 * time (`approvedAs`, the approving action's id), which is recorded whether it returned or threw.
 * `outcome` is {value} for a call that returned (undefined for inspectWorkspace(), whose value is a
 * view) and {error} for one that threw or whose result assertPlainAdminResult refused. */
export function instanceAdminReadObservation(method: keyof AdminApi, args: readonly unknown[],
    outcome: { value: unknown } | { error: unknown }, approvedAs?: number): ObservationDescription {
  let description = approvedAs === undefined
    ? "Your agent read deployment admin data through the Admin API, as you."
    : "error" in outcome
    ? "Your agent made the call you approved to the deployment's Admin API, as you, and it failed."
    : "Your agent made the call you approved to the deployment's Admin API, as you.";
  let fields: ActionField[] = [
    { label: "Method", kind: "inline", value: `AdminApi.${method}` },
    observedArgumentsField(args),
  ];
  if ("error" in outcome) {
    fields.push(instanceAdminStringField(
        "Error", errorText(outcome.error), MAX_OBSERVED_ERROR_CHARS));
  } else {
    let summary = resultSummary(outcome.value);
    if (summary !== "") fields.push(instanceAdminStringField("Result", summary));
  }
  if (approvedAs !== undefined) {
    fields.push({ label: "Approved as", kind: "inline", value: `action ${approvedAs}` });
  }
  return {
    title: `${sentenceCase(method)} (deployment admin)`, description, fields,
    containsRestrictedData: true,
  };
}

/** The observation of one call the agent made on an admin view it opened with inspectWorkspace():
 * `view` is the workspace it reads and the reason it was opened with. */
export function instanceAdminViewObservation(view: { workspaceId: string; reason: string },
    method: Exclude<AdminWorkspaceMethod, "inspectWorkspace">, args: readonly unknown[]):
    ObservationDescription {
  return {
    title: `Inspect workspace: ${method} (deployment admin)`,
    description: "Your agent read a workspace through an admin view, as you. The deployment's " +
      "admin audit log records the call.",
    fields: [
      instanceAdminStringField("Workspace", view.workspaceId),
      instanceAdminStringField("Reason", view.reason),
      { label: "Method", kind: "inline", value: `AdminWorkspaceView.${method}` },
      observedArgumentsField(args),
    ],
    containsRestrictedData: true,
  };
}

/** The sentence a resumed agent reads after its user approved deployment admin requests that ran
 * nothing yet (turning access on, one-call approvals), naming their titles. */
export function instanceAdminApprovedNudge(titles: readonly string[]): string {
  return `Your user approved ${titles.map(t => `"${t}"`).join(", ")}. Nothing ran when you ` +
    "asked: make those calls again now, with the same arguments. An approved single call runs " +
    `once, as the identical call, within ${APPROVAL_MINUTES} minutes.`;
}

/** Throws R14 when `value` holds a function, stub or RpcTarget at any depth, and a TypeError naming
 * `label` when it nests deeper than 64 containers, so a value too deep to walk is refused rather
 * than passed on unchecked. A cycle is not a capability: the walk visits each object once. `label`
 * is "AdminApi.<m>" or "AdminWorkspaceView.<m>". */
export function assertPlainAdminResult(label: string, value: unknown): void {
  let visited = new Set<object>();
  let walk = (member: unknown, depth: number): void => {
    if (isCapability(member)) {
      throw new Error(`${label} returned a capability, which the instance admin binding passes ` +
          "on only from AdminApi.inspectWorkspace().");
    }
    if (typeof member !== "object" || member === null || visited.has(member)) return;
    if (member instanceof ArrayBuffer || ArrayBuffer.isView(member)) return;
    if (depth > MAX_DEPTH) {
      throw new TypeError(`${label} returned a value nested deeper than ${MAX_DEPTH} levels.`);
    }
    visited.add(member);
    let members = member instanceof Map ? [...member.keys(), ...member.values()]
        : member instanceof Set ? [...member] : Object.values(member);
    for (let next of members) walk(next, depth + 1);
  };
  walk(value, 1);
}

/** Whether `record` is an instance admin capsule: ambient, of INSTANCE_ADMIN_VENDOR_ID. */
export function isInstanceAdminCapsule(record: GatekeeperRecord | undefined): boolean {
  let spec = record?.creationSpec;
  return spec?.type === "ambient" && spec.vendorId === INSTANCE_ADMIN_VENDOR_ID;
}

/**
 * Whether the turn whose chat log is `newestFirst` (newest record first) answers a message
 * `ownerProfileId` wrote themselves: whether the newest record that starts a task is a prompt
 * (isTurnPrompt) they wrote. A callback starts a task that is not theirs, and so does a slash
 * command's expansion: the message carrying generatedBySlashCommandSequence, whose text the
 * command's provider wrote, although the chat logs it as the invoking user's. Every other record
 * continues the task before it and is passed over: nudges (a decision, a retry, a stop), accepted
 * connections, steers, the agent's records, and slashCommand records. That includes the built-in
 * /compact. It is the user's own command, not a connection's, so it never fails a turn closed; but
 * it holds no task text and its turn runs no tools, so a retry after it continues whatever task came
 * before it. Were it a task start, a retry after compacting a callback's or a slash command's task
 * would run that task as the owner's. A gatekeeper command's own record holds no text either: its
 * expansion, when it has one, is newer and is met first. False when the log runs out.
 */
export function turnAnswersOwner(newestFirst: Iterable<AiChatMessage>, ownerProfileId: string):
    boolean {
  for (let record of newestFirst) {
    if (record.type === "agentCallback") return false;
    if (record.type === "message" && isTurnPrompt(record)) {
      if (record.generatedBySlashCommandSequence !== undefined) return false;
      return record.author.type === "user" && record.author.id === ownerProfileId;
    }
  }
  return false;
}

/** Whether `first`, a chat's first record, makes it a blueprint update's review: a user's "changes"
 * record carrying blueprintMerges, which only applyBlueprint writes, as the first record of the chat it
 * creates. */
export function isBlueprintProposal(first: AiChatMessage | undefined): boolean {
  return first?.type === "changes" && first.author.type === "user" &&
      (first.blueprintMerges?.length ?? 0) > 0;
}

/** Whether a code run that started at `startedAt` has outlived INSTANCE_ADMIN_RUN_LIMIT_SECONDS at
 * `now` (both from Date.now()). */
export function instanceAdminRunExpired(startedAt: number, now: number): boolean {
  return now - startedAt > INSTANCE_ADMIN_RUN_LIMIT_SECONDS * 1000;
}
