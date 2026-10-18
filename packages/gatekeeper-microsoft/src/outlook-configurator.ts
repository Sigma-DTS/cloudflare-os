// The capability the Outlook configurator frame holds: it lists what the connected user's mailboxes
// hold (folders, categories, conversations, the people they work with), and turns a draft into the
// resource URL the binding is minted from. Nothing here grants anything. It reads as the user, and
// the binding re-resolves the URL itself (`resolveOutlookUrl`), so a forged draft can at most bind
// something the user could open anyway.
//
// It shows the user their own conversations' subjects and senders. None of it is logged, recorded
// as an observation, or put in a URL.

import { RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type {
  OutlookCategory, OutlookCategoryList, OutlookConfiguratorRpc, OutlookConfiguratorStatus,
  OutlookConversation, OutlookConversationList, OutlookDraft, OutlookFolderKind, OutlookFolderList, OutlookFolderRow,
  OutlookLocated, OutlookPerson, OutlookSharedMailbox,
} from "./configurator/outlook-configurator-types";
import { GraphApi, GraphApiError, type BatchRequest, type BatchResponse } from "./graph-api";
import { accountSource, type StoredIdentity } from "./microsoft-credentials";
import { OUTLOOK_RESOURCE, grantedOutlookAccess, grantedResourcePatterns, grantsSharedMailboxes } from "./microsoft-env";
import { MailApi, isMailId, parseFolder, parseMessage, type GraphFolder, type GraphMessage } from "./outlook-graph";
import { odataString } from "./outlook-query";
import { folderPath, resolveOutlookUrl } from "./outlook-resolve";
import {
  ACCESS_LEVELS, OUTLOOK_ORIGIN, OutlookUrlError, allows, lowerAccess, outlookUrl, parseOutlookUrl,
  type OutlookAccessLevel, type OutlookMailboxRef, type OutlookScope,
} from "./outlook-scope";

/** How the configurator reaches the connection: the account Durable Object, or a token in tests. */
export interface OutlookConnection {
  identity(): Promise<StoredIdentity>;
  grantedScopes(): Promise<string[]>;
  read<T>(op: (api: GraphApi) => Promise<T>): Promise<T>;
}

/** The connection held by the user's account Durable Object. */
export function accountConnection(exports: Cloudflare.Exports, userObjectId: string): OutlookConnection {
  const creds = accountSource(exports, userObjectId);
  const account = () => exports.UserAccount.get(exports.UserAccount.idFromString(userObjectId));
  return {
    identity: async () => await account().getIdentity(),
    grantedScopes: async () => await account().getGrantedScopes(),
    read: async op => await creds.run(credentials => op(new GraphApi(credentials.accessToken)), { replayable: true }),
  };
}

const ME: OutlookMailboxRef = { kind: "me" };
/** How long the identity, grant and folders are reused while the frame is open. */
const CACHE_TTL_MS = 60 * 1000;
/** Folders listed per mailbox, and folders whose subfolders are fetched, at most. */
const MAX_FOLDERS = 500;
const MAX_EXPANDED_FOLDERS = 80;
const MAX_PEOPLE = 8;
const MAILBOX_CONCURRENCY = 4;
const MAX_BATCH_ATTEMPTS = 4;
const MAX_CONVERSATIONS = 25;
const BEGINNING = "1900-01-01T00:00:00Z";

const ADDRESS = /^[^\s@<>()",;:/\\]+@[^\s@<>()",;:/\\]+\.[^\s@<>()",;:/\\]+$/;
const CONVERSATION_SELECT = "id,subject,from,receivedDateTime,conversationId,parentFolderId,isDraft";
const IMMUTABLE_IDS = 'IdType="ImmutableId"';
const FOLDER_SELECT = "id,displayName,parentFolderId,childFolderCount";

const NO_MAILBOX = "This Microsoft 365 account has no Outlook mailbox, so there's nothing to choose from. " +
  "Ask your Microsoft 365 administrator for an Exchange Online license.";

/** What each access level is called in the frame, for messages that name one. */
const ACCESS_TITLES: Record<OutlookAccessLevel, string> = {
  read: "Read only", organize: "Read and organize", draft: "Draft replies", send: "Send with your approval",
};

/** Graph's well-known folder names as the frame's folder kinds, in the order Outlook lists them. */
const FOLDER_KINDS: [string, OutlookFolderKind][] = [
  ["inbox", "inbox"], ["drafts", "drafts"], ["sentitems", "sent"], ["deleteditems", "deleted"], ["junkemail", "junk"],
  ["archive", "archive"], ["conversationhistory", "history"], ["outbox", "outbox"],
];
const KIND_ORDER: OutlookFolderKind[] = ["inbox", "drafts", "sent", "deleted", "junk", "archive", "folder", "history", "outbox"];
/** Folders a narrowed binding leaves out unless narrowed to one, as `admits` does (PRIVATE_WELL_KNOWN). */
const PRIVATE_KINDS = new Set<string>(["drafts", "junkemail", "deleteditems", "outbox", "conversationhistory"]);

/**
 * Outlook's category colors (`preset0`…`preset24`), as Outlook on the web draws them. They are the
 * user's own data, shown so a category is recognizable at a glance.
 */
const CATEGORY_COLORS = [
  "#d13438", "#f7630c", "#8e562e", "#eaa300", "#13a10e", "#00b7c3", "#8ca43a", "#0078d4", "#8764b8", "#c30052",
  "#69797e", "#394146", "#7a7574", "#5d5a58", "#1b1a19", "#750b1c", "#ca5010", "#4d291c", "#c19c00", "#0b6a0b",
  "#038387", "#5c6a1a", "#004e8c", "#5c2e91", "#77004d",
];

/** An address as a binding stores it, or an error saying what's wrong with it. */
export function normalizeAddress(address: string): string {
  const trimmed = address.trim().toLowerCase();
  if (trimmed.length > 254 || !ADDRESS.test(trimmed)) throw new Error(`"${address.trim().slice(0, 80)}" isn't an email address.`);
  return trimmed;
}

/** The access levels a grant allows under the deployment's ceiling, for the user's own and for shared mailboxes. */
export function accessLevels(ceiling: OutlookAccessLevel, grantedScopes: readonly string[]): {
  own: OutlookAccessLevel[]; shared: OutlookAccessLevel[]; limitedByDeployment: boolean;
} {
  const granted = grantedOutlookAccess(grantedScopes);
  if (granted === null) return { own: [], shared: [], limitedByDeployment: false };
  const top = lowerAccess(ceiling, granted);
  const own = ACCESS_LEVELS.filter(level => allows(top, level));
  return {
    own,
    shared: own.filter(level => grantsSharedMailboxes(grantedScopes, level)),
    limitedByDeployment: top !== "send" && top === ceiling,
  };
}

/**
 * A draft as a binding URL, for `resolveOutlookUrl` to check and resolve. The placeholders it
 * leaves (a folder's name, a shared mailbox's ID) are filled in by resolving.
 */
export function draftUrl(draft: OutlookDraft): string {
  if (draft.folder !== undefined && !isMailId(draft.folder.id)) throw new Error("That folder can't be read. Choose it again.");
  for (const category of draft.categories ?? []) {
    if (category.includes(",")) throw new Error(`Category names with commas, like "${category.slice(0, 60)}", can't be used.`);
  }
  return outlookUrl({
    mailbox: draft.mailbox === undefined ? ME : { kind: "shared", id: "", address: normalizeAddress(draft.mailbox) },
    ...(draft.folder ? { folder: { id: draft.folder.id, name: "", subfolders: draft.folder.subfolders } } : {}),
    ...(draft.conversationId !== undefined ? { conversation: { id: draft.conversationId, subject: "" } } : {}),
    ...(draft.senders?.length ? { senders: draft.senders.map(sender => sender.trim().toLowerCase()) } : {}),
    ...(draft.categories?.length ? { categories: draft.categories.map(category => category.trim()).filter(Boolean) } : {}),
    ...(draft.recentDays !== undefined ? { recentDays: draft.recentDays } : {}),
    access: draft.access,
  });
}

/**
 * GETs from one mailbox in `$batch`es, retrying what Exchange throttles. Exchange runs at most four
 * requests per mailbox at once and answers the rest of a batch 429 (seen live), so batches hold four.
 */
export async function mailboxBatch(api: GraphApi, requests: readonly BatchRequest[], wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))): Promise<Map<string, BatchResponse>> {
  const answers = new Map<string, BatchResponse>();
  let pending = [...requests];
  for (let attempt = 0; pending.length > 0; attempt++) {
    if (attempt > 0) await wait(500 * attempt);
    const retry: BatchRequest[] = [];
    for (let start = 0; start < pending.length; start += MAILBOX_CONCURRENCY) {
      const chunk = pending.slice(start, start + MAILBOX_CONCURRENCY);
      const answered = await api.batch(chunk);
      for (const request of chunk) {
        const answer = answered.get(request.id);
        if ((answer === undefined || answer.status === 429 || answer.status === 503) && attempt < MAX_BATCH_ATTEMPTS - 1) retry.push(request);
        else answers.set(request.id, answer ?? { id: request.id, status: 502, body: null });
      }
    }
    pending = retry;
  }
  return answers;
}

/** A subject search as KQL: every word must be in the subject. Drops what KQL would read as syntax. */
export function subjectSearch(query: string): string | undefined {
  const words = query.normalize("NFKC").replace(/[^\p{L}\p{N}'._@-]+/gu, " ").split(" ")
    .map(word => word.replace(/^[-.']+/, "")).filter(word => word !== "" && !/^(and|or|not|near)$/i.test(word)).slice(0, 8);
  return words.length === 0 ? undefined : `"${words.map(word => `subject:${word}`).join(" AND ")}"`;
}

const newestFirst = (a: { receivedAt: string }, b: { receivedAt: string }) => b.receivedAt.localeCompare(a.receivedAt);

type Cached<T> = { at: number; value: Promise<T> };
type SharedMailbox = { ref: OutlookMailboxRef; name: string; inbox: GraphFolder };
type FolderTree = { rows: OutlookFolderRow[]; notice?: string; wellKnown: Map<string, string> };

/** The Outlook configurator frame's capability. */
@validateRpc()
export class OutlookConfiguratorUI extends RpcTarget implements OutlookConfiguratorRpc {
  readonly #connection: OutlookConnection;
  readonly #ceiling: OutlookAccessLevel;
  readonly #now: () => number;
  #state?: Cached<{ identity: StoredIdentity; scopes: string[]; me: string }>;
  readonly #shared = new Map<string, Cached<SharedMailbox>>();
  readonly #folders = new Map<string, Cached<FolderTree>>();

  /** @param ceiling The deployment's Outlook ceiling, `outlookAccess(env)`. */
  constructor(connection: OutlookConnection, ceiling: OutlookAccessLevel, now: () => number = Date.now) {
    super();
    this.#connection = connection;
    this.#ceiling = ceiling;
    this.#now = now;
  }

  async getStatus(): Promise<OutlookConfiguratorStatus> {
    // Asked again after a consent pop-up, so never answered from the cache.
    this.#state = undefined;
    const { identity, scopes, me } = await this.#connected();
    if (!grantedResourcePatterns(scopes).includes(OUTLOOK_RESOURCE.urlPattern)) return { state: "needsAccess" };
    const inbox = await this.#connection.read(api => new MailApi(api, ME).folder("inbox"));
    if (inbox === null) return { state: "unavailable", message: NO_MAILBOX };
    const levels = accessLevels(this.#ceiling, scopes);
    return {
      state: "ready", me: { address: me, name: identity.name || me },
      levels: levels.own, sharedLevels: levels.shared, limitedByDeployment: levels.limitedByDeployment,
    };
  }

  async openSharedMailbox(address: string): Promise<OutlookSharedMailbox> {
    const wanted = normalizeAddress(address);
    if (wanted === (await this.#connected()).me) throw new Error("That's your own mailbox. Choose Your mailbox instead.");
    // Asked for on purpose, so a mailbox shared with the user a moment ago is found.
    this.#shared.delete(wanted);
    const shared = await this.#sharedMailbox(wanted);
    if (shared.ref.kind !== "shared") throw new Error("That's your own mailbox. Choose Your mailbox instead.");
    return { address: shared.ref.address, name: shared.name };
  }

  async listFolders(mailbox: string | null): Promise<OutlookFolderList> {
    const tree = await this.#folderTree(await this.#mailbox(mailbox));
    return { folders: tree.rows, ...(tree.notice ? { notice: tree.notice } : {}) };
  }

  async listCategories(mailbox: string | null): Promise<OutlookCategoryList> {
    const ref = await this.#mailbox(mailbox);
    const body = await this.#connection.read(api => new MailApi(api, ref).find<{ value?: unknown }>("/outlook/masterCategories"));
    // A shared mailbox's categories are its owner's settings, which delegated mail access can't read.
    if (body === null || !Array.isArray(body.value)) return { categories: [], listed: false };
    const categories: OutlookCategory[] = [];
    for (const row of body.value as { displayName?: unknown; color?: unknown }[]) {
      if (typeof row.displayName !== "string" || row.displayName === "" || row.displayName.includes(",")) continue;
      const preset = typeof row.color === "string" ? /^preset(\d{1,2})$/.exec(row.color) : null;
      const color = preset ? CATEGORY_COLORS[Number(preset[1])] : undefined;
      categories.push({ name: row.displayName, ...(color ? { color } : {}) });
    }
    return { categories: categories.toSorted((a, b) => a.name.localeCompare(b.name)), listed: true };
  }

  async searchPeople(query: string): Promise<OutlookPerson[]> {
    const cleaned = query.replace(/["\\]/g, " ").trim().slice(0, 100);
    if (cleaned === "") return [];
    const body = await this.#connection.read(api => api.get<{ value?: unknown }>("/me/people", {
      query: { $search: `"${cleaned}"`, $top: MAX_PEOPLE * 2, $select: "displayName,scoredEmailAddresses" },
    }));
    const people: OutlookPerson[] = [];
    const seen = new Set<string>();
    for (const row of Array.isArray(body.value) ? body.value as { displayName?: unknown; scoredEmailAddresses?: unknown }[] : []) {
      const scored = Array.isArray(row.scoredEmailAddresses) ? row.scoredEmailAddresses as { address?: unknown }[] : [];
      const address = typeof scored[0]?.address === "string" ? scored[0].address.toLowerCase() : "";
      if (!ADDRESS.test(address) || seen.has(address)) continue;
      seen.add(address);
      const name = typeof row.displayName === "string" && row.displayName !== "" && row.displayName.toLowerCase() !== address ? row.displayName : undefined;
      people.push({ address, ...(name ? { name } : {}) });
      if (people.length === MAX_PEOPLE) break;
    }
    return people;
  }

  async findConversations(mailbox: string | null, query: string): Promise<OutlookConversationList> {
    const ref = await this.#mailbox(mailbox);
    const trimmed = query.trim();
    if (/^https?:\/\//i.test(trimmed)) return { items: [await this.#linkedConversation(ref, trimmed)] };
    if (trimmed.length > 200) throw new Error("That search is too long.");
    const search = trimmed === "" ? undefined : subjectSearch(trimmed);
    if (trimmed !== "" && search === undefined) return { items: [] };
    const tree = await this.#folderTree(ref);
    const hidden = new Set([...tree.wellKnown].filter(([name]) => PRIVATE_KINDS.has(name)).map(([, id]) => id));
    const page = await this.#connection.read(api => new MailApi(api, ref).page("/messages", parseMessage, "message", search === undefined
      ? { $select: CONVERSATION_SELECT, $top: 50, $filter: `receivedDateTime ge ${BEGINNING}`, $orderby: "receivedDateTime desc" }
      : { $select: CONVERSATION_SELECT, $top: 50, $search: search }));
    const latest = new Map<string, GraphMessage>();
    for (const message of page.items) {
      if (message.isDraft || message.conversationId === "" || hidden.has(message.parentFolderId)) continue;
      const known = latest.get(message.conversationId);
      if (known === undefined || message.receivedAt > known.receivedAt) latest.set(message.conversationId, message);
    }
    const items = [...latest.values()].toSorted(newestFirst).slice(0, MAX_CONVERSATIONS).map(conversation);
    return search !== undefined && page.nextLink !== undefined
      ? { items, notice: "Showing the most recent matches. Add words to find an older conversation." }
      : { items };
  }

  async resourceUrlFor(draft: OutlookDraft): Promise<string> {
    const { scopes } = await this.#connected();
    const levels = accessLevels(this.#ceiling, scopes);
    const allowed = draft.mailbox === undefined ? levels.own : levels.shared;
    if (!allowed.includes(draft.access)) {
      throw new Error(allowed.length === 0
        ? "This connection can't open that mailbox. Reconnect Microsoft 365 and allow Outlook access."
        : `"${ACCESS_TITLES[draft.access]}" isn't allowed for this mailbox. Choose up to "${ACCESS_TITLES[allowed.at(-1)!]}".`);
    }
    return outlookUrl(await this.#resolve(draft));
  }

  async locate(resourceUrl: string): Promise<OutlookLocated | null> {
    const { scopes, me } = await this.#connected();
    const levels = accessLevels(this.#ceiling, scopes);
    let scope: OutlookScope;
    try {
      scope = await this.#connection.read(api => resolveOutlookUrl(api, resourceUrl, levels.own.at(-1) ?? "read", me));
    } catch (error) {
      if (error instanceof OutlookUrlError) return null;
      throw error;
    }
    const allowed = scope.mailbox.kind === "shared" ? levels.shared : levels.own;
    const access = allowed.includes(scope.access) ? scope.access : allowed.at(-1) ?? "read";
    const located: OutlookLocated = { access };
    if (scope.mailbox.kind === "shared") located.mailbox = { address: scope.mailbox.address, name: await this.#mailboxName(scope.mailbox) };
    if (scope.folder) {
      const ref = scope.mailbox;
      const path = await this.#connection.read(api => folderPath(new MailApi(api, ref), scope.folder!.id));
      located.folder = { id: scope.folder.id, path: path || scope.folder.name, subfolders: scope.folder.subfolders };
    }
    if (scope.conversation) located.conversation = scope.conversation;
    if (scope.senders) located.senders = scope.senders;
    if (scope.categories) located.categories = scope.categories;
    if (scope.recentDays !== undefined) located.recentDays = scope.recentDays;
    return located;
  }

  // -- the connection -------------------------------------------------------------------------

  /** The connected identity and grant, reused briefly. */
  #connected(): Promise<{ identity: StoredIdentity; scopes: string[]; me: string }> {
    return this.#cached(() => this.#state, entry => (this.#state = entry), () => Promise.all([this.#connection.identity(), this.#connection.grantedScopes()])
      .then(([identity, scopes]) => ({ identity, scopes, me: (identity.email ?? identity.username ?? "").toLowerCase() })));
  }

  /** The entry `get` holds while it is fresh, or a new one from `load`. A failure isn't kept, so the next request asks again. */
  #cached<T>(get: () => Cached<T> | undefined, set: (entry: Cached<T> | undefined) => void, load: () => Promise<T>): Promise<T> {
    const now = this.#now();
    const entry = get();
    if (entry !== undefined && now - entry.at < CACHE_TTL_MS) return entry.value;
    const fresh: Cached<T> = { at: now, value: load() };
    set(fresh);
    fresh.value.catch(() => {
      if (get() === fresh) set(undefined);
    });
    return fresh.value;
  }

  #cachedIn<T>(map: Map<string, Cached<T>>, key: string, load: () => Promise<T>): Promise<T> {
    return this.#cached(() => map.get(key), entry => {
      if (entry !== undefined) map.set(key, entry);
      else map.delete(key);
    }, load);
  }

  /** The mailbox a frame names: the user's own for null, or a shared one they have opened. */
  async #mailbox(address: string | null): Promise<OutlookMailboxRef> {
    if (address === null) return ME;
    return (await this.#sharedMailbox(normalizeAddress(address))).ref;
  }

  #sharedMailbox(address: string): Promise<SharedMailbox> {
    return this.#cachedIn(this.#shared, address, async () => {
      const { me } = await this.#connected();
      return await this.#connection.read(async api => {
        // Opening the Inbox by address tells "no such mailbox" from "not shared with you", which
        // the directory lookup that resolves the address to its owner can't.
        const inbox = parseFolder(await new MailApi(api, { kind: "shared", id: address, address }).get<unknown>("/mailFolders/inbox", { $select: FOLDER_SELECT })
          .catch(error => {
            if (!(error instanceof GraphApiError)) throw error;
            if (error.code === "ErrorInvalidUser") throw new Error(`There's no mailbox ${address} in your organization. Check the address.`);
            if (error.status === 403 || error.status === 404) {
              throw new Error(`You haven't been given access to ${address}. Ask its owner or your Microsoft 365 administrator to share it with you.`);
            }
            throw error;
          }));
        const ref = (await resolveOutlookUrl(api, `${OUTLOOK_ORIGIN}/mail/${encodeURIComponent(address)}/`, "read", me)).mailbox;
        if (ref.kind === "me") return { ref, name: me, inbox };
        const user = await api.find<{ displayName?: unknown }>(`/users/${encodeURIComponent(ref.id)}`, { query: { $select: "displayName" } });
        const name = typeof user?.displayName === "string" && user.displayName !== "" ? user.displayName : ref.address;
        return { ref, name, inbox };
      });
    });
  }

  async #mailboxName(ref: OutlookMailboxRef): Promise<string> {
    if (ref.kind === "me") return (await this.#connected()).identity.name || "your";
    return (await this.#sharedMailbox(ref.address)).name;
  }

  /** A draft as the scope it would bind, checked and resolved exactly as the binding will be; access is checked by the caller. */
  async #resolve(draft: OutlookDraft): Promise<OutlookScope> {
    const { me } = await this.#connected();
    return await this.#connection.read(api => resolveOutlookUrl(api, draftUrl(draft), "send", me));
  }

  // -- folders --------------------------------------------------------------------------------

  #folderTree(ref: OutlookMailboxRef): Promise<FolderTree> {
    return this.#cachedIn(this.#folders, ref.kind === "me" ? "" : ref.address, () => this.#connection.read(async api => {
      const mail = new MailApi(api, ref);
      // One after the other, as everything here: Exchange throttles a fifth concurrent request.
      const wellKnown = await this.#wellKnown(api, mail);
      const top = await mail.childFolders(null, MAX_FOLDERS).catch((error: unknown) => {
        if (error instanceof GraphApiError && (error.status === 403 || error.status === 404)) return null;
        throw error;
      });
      if (top === null) {
        // Some shared mailboxes are shared one folder at a time: their folder list can't be read.
        const inbox = await mail.folder("inbox");
        return {
          rows: inbox === null ? [] : [row(inbox, "Inbox", 0, "inbox", 0)],
          notice: "Only this mailbox's Inbox can be listed. Ask its owner for full access to choose another folder.",
          wellKnown,
        };
      }
      const kinds = new Map<string, OutlookFolderKind>(FOLDER_KINDS.flatMap(([name, kind]) => {
        const id = wellKnown.get(name);
        return id === undefined ? [] : [[id, kind]];
      }));
      const children = new Map<string, GraphFolder[]>();
      let count = top.length;
      let expanded = 0;
      let frontier = top.filter(folder => folder.childCount > 0);
      while (frontier.length > 0 && count < MAX_FOLDERS && expanded < MAX_EXPANDED_FOLDERS) {
        const opening = frontier.slice(0, MAX_EXPANDED_FOLDERS - expanded);
        expanded += opening.length;
        const lists: GraphFolder[][] = [];
        for (let start = 0; start < opening.length; start += MAILBOX_CONCURRENCY) {
          lists.push(...await Promise.all(opening.slice(start, start + MAILBOX_CONCURRENCY).map(folder => mail.childFolders(folder.id, MAX_FOLDERS))));
        }
        frontier = [];
        for (const [index, folder] of opening.entries()) {
          const list = lists[index]!.slice(0, Math.max(0, MAX_FOLDERS - count));
          count += list.length;
          children.set(folder.id, list);
          frontier.push(...list.filter(child => child.childCount > 0));
        }
      }
      const truncated = frontier.length > 0 || count >= MAX_FOLDERS;
      const rows: OutlookFolderRow[] = [];
      const byName = (a: GraphFolder, b: GraphFolder) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
      const kindOf = (folder: GraphFolder) => kinds.get(folder.id) ?? "folder";
      const visit = (folder: GraphFolder, path: string, depth: number): number => {
        const at = rows.length;
        rows.push(row(folder, path, depth, depth === 0 ? kindOf(folder) : "folder", 0));
        let descendants = 0;
        for (const child of (children.get(folder.id) ?? []).toSorted(byName)) descendants += 1 + visit(child, `${path}/${child.name}`, depth + 1);
        rows[at]!.descendants = descendants;
        return descendants;
      };
      const ordered = top.toSorted((a, b) => KIND_ORDER.indexOf(kindOf(a)) - KIND_ORDER.indexOf(kindOf(b)) || byName(a, b));
      for (const folder of ordered) visit(folder, folder.name, 0);
      return {
        rows,
        ...(truncated ? { notice: `This mailbox has more folders than can be listed, so only the first ${rows.length} are shown.` } : {}),
        wellKnown,
      };
    }));
  }

  /** The IDs of Outlook's own folders, by well-known name. A folder the mailbox lacks is absent. */
  async #wellKnown(api: GraphApi, mail: MailApi): Promise<Map<string, string>> {
    const names = FOLDER_KINDS.map(([name]) => name);
    const answers = await mailboxBatch(api, names.map(name => ({
      id: name, method: "GET", url: `${mail.base.slice(1)}/mailFolders/${name}?$select=id`, headers: { prefer: IMMUTABLE_IDS },
    })));
    const ids = new Map<string, string>();
    for (const name of names) {
      const answer = answers.get(name);
      if (answer?.status === 200) ids.set(name, parseFolder(answer.body).id);
      // A shared mailbox shared a folder at a time answers 403 for the folders it doesn't share.
      else if (answer && answer.status !== 404 && answer.status !== 403) throw new GraphApiError(answer.status, "Outlook couldn't list the mailbox's folders. Try again in a moment.");
    }
    return ids;
  }

  // -- conversations --------------------------------------------------------------------------

  async #linkedConversation(ref: OutlookMailboxRef, link: string): Promise<OutlookConversation> {
    const { me } = await this.#connected();
    let target;
    try {
      target = parseOutlookUrl(link);
    } catch (error) {
      throw new Error(error instanceof OutlookUrlError ? error.message : "That link can't be read.", { cause: error });
    }
    if (target.messageId === undefined && target.conversationId === undefined) {
      throw new Error("That link isn't to a message. Open the message in Outlook, then copy the link from the address bar.");
    }
    const linked = target.mailbox === undefined || target.mailbox === me ? undefined : target.mailbox;
    const chosen = ref.kind === "shared" ? ref.address : undefined;
    if (linked !== chosen) {
      throw new Error(linked === undefined
        ? "That message is in your own mailbox. Choose Your mailbox above to use it."
        : `That message is in the ${linked} mailbox. Choose that mailbox above to use it.`);
    }
    // The link's own mailbox segment is dropped: the frame's choice is the mailbox, as checked above.
    const scope = await this.#connection.read(api => resolveOutlookUrl(api, link, "read", me));
    const latest = await this.#connection.read(api => new MailApi(api, ref).get<{ value?: unknown[] }>("/messages", {
      $filter: `conversationId eq ${odataString(scope.conversation!.id)}`, $select: CONVERSATION_SELECT, $top: 10,
    }));
    const messages = (latest.value ?? []).map(parseMessage).toSorted(newestFirst);
    const newest = messages[0];
    return conversation(newest ?? { conversationId: scope.conversation!.id, subject: scope.conversation!.subject, receivedAt: "" });
  }
}

function conversation(message: Pick<GraphMessage, "conversationId" | "subject" | "receivedAt" | "fromAddress">): OutlookConversation {
  return {
    id: message.conversationId,
    subject: message.subject || "(no subject)",
    ...(message.fromAddress ? { from: message.fromAddress.name ?? message.fromAddress.address } : {}),
    ...(message.receivedAt ? { receivedAt: message.receivedAt } : {}),
  };
}

function row(folder: GraphFolder, path: string, depth: number, kind: OutlookFolderKind, descendants: number): OutlookFolderRow {
  return { id: folder.id, name: folder.name || path, path, depth, kind, descendants };
}
