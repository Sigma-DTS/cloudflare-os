// The Graph reads the SharePoint sessions and configurator make, one function per question. Each
// takes a `GraphApi`, asks for exactly the fields its parser keeps, and returns parsed values; none
// decides what is in scope (sharepoint-scope.ts) or what an observer may see (the sessions do).

import { GraphApiError, MAX_BATCH_REQUESTS, isGraphUrl, type GraphApi } from "./graph-api";
import {
  DRIVE_SELECT, ITEM_SELECT, LIST_SELECT, PAGE_SELECT, SITE_SELECT,
  parseColumn, parseDrive, parseDriveItem, parseList, parseListItem, parsePage, parseRange, parseSite,
  parseSitePage, parseVersion, parseWorksheet, versionOf,
  type GraphColumn, type GraphDrive, type GraphDriveItem, type GraphList, type GraphListItem, type GraphRange, type GraphSite,
  type GraphSitePage, type GraphVersion, type GraphWorksheet,
} from "./graph-parse";
import type { ItemRef, ListRef, PageRef } from "./sharepoint-scope";

type Page<T> = { items: T[]; nextLink?: string };

/** A `nextLink` Graph returned, checked to still point at Graph before it is followed. */
function next(link: string | undefined): string | undefined {
  if (link === undefined) return undefined;
  if (!isGraphUrl(link)) throw new GraphApiError(502, "Microsoft Graph returned a continuation link to somewhere else.");
  return link;
}

/** One page of a collection: the first from `path` and `query`, later ones from the opaque token. */
async function page<T>(api: GraphApi, token: string | undefined, path: string, query: Record<string, string | number | undefined>,
                       parse: (row: unknown) => T, what: string, prefer?: string[]): Promise<Page<T>> {
  const body = token === undefined
    ? await api.get<unknown>(path, { query, ...(prefer ? { prefer } : {}) })
    : await api.get<unknown>(next(token)!, prefer ? { prefer } : {});
  const parsed = parsePage(body, parse, what);
  return { items: parsed.items, ...(parsed.nextLink ? { nextLink: next(parsed.nextLink) } : {}) };
}

// -- items --------------------------------------------------------------------------------------

/**
 * The user's own roles on an item or a drive's root (`write`, `read`, `owner`), or null when Graph
 * doesn't say. Graph reports them as `shared.effectiveRoles` on whatever is shared, which isn't
 * documented, so a caller may use them only to lower what it allows.
 */
export async function effectiveRoles(api: GraphApi, ref: { driveId: string; itemId?: string }): Promise<string[] | null> {
  const path = ref.itemId === undefined ? `/drives/${ref.driveId}/root` : `/drives/${ref.driveId}/items/${ref.itemId}`;
  const body = await api.find<{ shared?: { effectiveRoles?: unknown } }>(path, { query: { $select: "id,shared" } });
  const roles = body?.shared?.effectiveRoles;
  return Array.isArray(roles) && roles.length > 0 && roles.every(role => typeof role === "string") ? roles : null;
}

/** An item by ID, or null when it does not exist or the user cannot open it. */
export async function getItem(api: GraphApi, ref: ItemRef): Promise<GraphDriveItem | null> {
  const body = await api.find<unknown>(`/drives/${ref.driveId}/items/${ref.itemId}`, { query: { $select: ITEM_SELECT } });
  return body === null ? null : parseDriveItem(body);
}

/**
 * The version of a file the reader is shown, `_UIVersionString` from its list item: `3.0`, or a
 * draft's `3.1`. Undefined where the file has none to report.
 */
export async function fileVersion(api: GraphApi, ref: ItemRef): Promise<string | undefined> {
  const fields = await api.find<unknown>(`/drives/${ref.driveId}/items/${ref.itemId}/listItem/fields`, {
    query: { $select: "_UIVersionString" },
  });
  return versionOf(fields !== null && typeof fields === "object" ? fields as Record<string, unknown> : undefined).version;
}

/** Graph's sort parameter for each listing order. Folders first is the default for "name". */
const ORDER_BY: Record<string, string> = { name: "name", modified: "lastModifiedDateTime desc", size: "size desc" };

/** One page of a folder's children. */
export function listChildren(api: GraphApi, folder: ItemRef, token: string | undefined, top: number,
                             orderBy: "name" | "modified" | "size" = "name"): Promise<Page<GraphDriveItem>> {
  return page(api, token, `/drives/${folder.driveId}/items/${folder.itemId}/children`,
    { $select: ITEM_SELECT, $top: top, $orderby: ORDER_BY[orderBy] }, parseDriveItem, "folder");
}

/** A drive's root folder. */
export async function getRoot(api: GraphApi, driveId: string): Promise<GraphDriveItem | null> {
  const body = await api.find<unknown>(`/drives/${driveId}/root`, { query: { $select: ITEM_SELECT } });
  return body === null ? null : parseDriveItem(body);
}

/** Many items at once, batched; a missing or forbidden one is null. */
export async function getItems(api: GraphApi, refs: readonly ItemRef[]): Promise<(GraphDriveItem | null)[]> {
  const results: (GraphDriveItem | null)[] = Array.from({ length: refs.length }, () => null);
  for (let start = 0; start < refs.length; start += MAX_BATCH_REQUESTS) {
    const chunk = refs.slice(start, start + MAX_BATCH_REQUESTS);
    const answers = await api.batch(chunk.map((ref, index) => ({
      id: String(start + index), method: "GET" as const, url: `drives/${ref.driveId}/items/${ref.itemId}?$select=${ITEM_SELECT}`,
    })));
    chunk.forEach((_, index) => {
      const answer = answers.get(String(start + index));
      if (answer && answer.status === 200) results[start + index] = parseDriveItem(answer.body);
    });
  }
  return results;
}

/** One page of a drive search. Graph searches names and content within the whole drive. */
export function searchDrive(api: GraphApi, driveId: string, query: string, token: string | undefined, top: number): Promise<Page<GraphDriveItem>> {
  // OData string literal inside a function call: single quotes doubled. Graph rejects `#` and `%`
  // unencoded in the path, so the literal is percent-encoded as a whole.
  const literal = encodeURIComponent(`'${query.replace(/'/g, "''")}'`);
  return page(api, token, `/drives/${driveId}/root/search(q=${literal})`, { $select: ITEM_SELECT, $top: top }, parseDriveItem, "search result");
}

/**
 * An agent's search words as a KQL query string. Parentheses and a trailing operator could
 * re-associate a filter appended after them, and carry no meaning a plain search needs.
 */
function searchWords(query: string): string {
  return query.replace(/[()]/g, " ").replace(/\s+(AND|OR|NOT)\s*$/i, "").trim();
}

/** A hit from Microsoft Search: just where the item lives. */
export type SearchHit = ItemRef;

/**
 * One page of Microsoft Search across every site the user can open, optionally narrowed by a KQL
 * `path:` filter. The hits are only hints: the caller re-reads each and re-checks its scope.
 * @returns The hits, and the offset of the next page, if any.
 */
export async function searchAll(api: GraphApi, query: string, pathFilter: string | undefined, from: number, size: number):
    Promise<{ hits: SearchHit[]; nextFrom?: number }> {
  const words = searchWords(query);
  return await searchDriveItems(api, pathFilter ? `(${words}) path:"${pathFilter.replace(/"/g, "")}"` : words, from, size);
}

/**
 * One page of what other people's OneDrives hold that the user can open: what they have shared
 * with the user, as OneDrive's "Shared with you" lists it, newest first, or matching `query`. Graph's
 * own `sharedWithMe` is deprecated, so this is Microsoft Search, which lags a new share by minutes.
 * Files shared from a site rather than a OneDrive aren't included.
 * @param oneDrives Where the tenant's OneDrives live, e.g. `https://contoso-my.sharepoint.com/personal/`.
 * @param mine The user's own OneDrive under it, if they have one.
 */
export async function searchSharedWithMe(api: GraphApi, oneDrives: string, mine: string | undefined, query: string | undefined,
                                         from: number, size: number): Promise<{ hits: SearchHit[]; nextFrom?: number }> {
  const places = `path:"${oneDrives.replace(/"/g, "")}"${mine ? ` -path:"${mine.replace(/"/g, "")}"` : ""}`;
  const words = query === undefined ? "" : searchWords(query);
  return await searchDriveItems(api, words ? `(${words}) ${places}` : places, from, size,
    words ? undefined : [{ name: "LastModifiedTime", isDescending: true }]);
}

async function searchDriveItems(api: GraphApi, queryString: string, from: number, size: number,
                                sortProperties?: { name: string; isDescending: boolean }[]): Promise<{ hits: SearchHit[]; nextFrom?: number }> {
  const body = await api.request<{ value?: unknown }>("POST", "/search/query", {
    body: { requests: [{ entityTypes: ["driveItem"], query: { queryString }, from, size, fields: ["id", "parentReference"],
      ...(sortProperties ? { sortProperties } : {}) }] },
  });
  const container = Array.isArray(body?.value) ? body.value[0] as Record<string, unknown> | undefined : undefined;
  const containers = Array.isArray(container?.hitsContainers) ? container.hitsContainers as Record<string, unknown>[] : [];
  const hits: SearchHit[] = [];
  let moreResults = false;
  for (const hitsContainer of containers) {
    if (hitsContainer.moreResultsAvailable === true) moreResults = true;
    for (const hit of Array.isArray(hitsContainer.hits) ? hitsContainer.hits as Record<string, unknown>[] : []) {
      const resource = hit.resource as Record<string, unknown> | undefined;
      const parent = resource?.parentReference as Record<string, unknown> | undefined;
      if (typeof resource?.id === "string" && typeof parent?.driveId === "string") {
        hits.push({ driveId: parent.driveId, itemId: resource.id });
      }
    }
  }
  return { hits, ...(moreResults ? { nextFrom: from + size } : {}) };
}

/** A file's saved versions, newest first. */
export async function listVersions(api: GraphApi, ref: ItemRef): Promise<GraphVersion[]> {
  const body = await api.get<unknown>(`/drives/${ref.driveId}/items/${ref.itemId}/versions`, { query: { $top: 50 } });
  return parsePage(body, parseVersion, "version").items;
}

// -- drives and sites ---------------------------------------------------------------------------

/** A drive by ID, or null. */
export async function getDrive(api: GraphApi, driveId: string): Promise<GraphDrive | null> {
  const body = await api.find<unknown>(`/drives/${driveId}`, { query: { $select: DRIVE_SELECT } });
  return body === null ? null : parseDrive(body);
}

/** A site by its composite ID, or null. */
export async function getSite(api: GraphApi, siteId: string): Promise<GraphSite | null> {
  const body = await api.find<unknown>(`/sites/${siteId}`, { query: { $select: SITE_SELECT } });
  return body === null ? null : parseSite(body);
}

/** A site's document libraries. */
export async function listDrives(api: GraphApi, siteId: string): Promise<GraphDrive[]> {
  return parsePage(await api.get<unknown>(`/sites/${siteId}/drives`, { query: { $select: DRIVE_SELECT } }), parseDrive, "library").items;
}

/** List templates that are libraries or system lists rather than lists an agent works with. */
const NON_LIST_TEMPLATES = new Set(["documentLibrary", "webPageLibrary", "pictureLibrary", "mySiteDocumentLibrary"]);

/** A site's lists, leaving out libraries (read as drives), page libraries, and hidden system lists. */
export async function listLists(api: GraphApi, siteId: string): Promise<{ lists: GraphList[]; hasPages: boolean }> {
  const [all, pages] = await Promise.all([
    api.get<unknown>(`/sites/${siteId}/lists`, { query: { $select: LIST_SELECT, $top: 200 } }).then(body => parsePage(body, parseList, "list").items),
    // Graph leaves the Site Pages library out of `/lists`, so whether a site has pages is asked of
    // the pages endpoint itself.
    api.find<{ value?: unknown[] }>(`/sites/${siteId}/pages/microsoft.graph.sitePage`, { query: { $select: "id", $top: 1 } }),
  ]);
  return {
    lists: all.filter(list => !list.hidden && !NON_LIST_TEMPLATES.has(list.template ?? "") && !/\/_catalogs\//.test(list.webUrl)),
    hasPages: Array.isArray(pages?.value) && pages.value.length > 0,
  };
}

/** A site's subsites. */
export async function listSubsites(api: GraphApi, siteId: string): Promise<GraphSite[]> {
  return parsePage(await api.get<unknown>(`/sites/${siteId}/sites`, { query: { $select: SITE_SELECT } }), parseSite, "site").items;
}

/** One page of the sites the user follows. */
function listFollowedSites(api: GraphApi, token: string | undefined): Promise<Page<GraphSite>> {
  return page(api, token, "/me/followedSites", { $select: SITE_SELECT }, parseSite, "site");
}

/**
 * One page of Microsoft Search's sites matching `query` (`*` for all). `/sites?search=` reads an
 * older index that a new tenant leaves empty for days; Microsoft Search answers from the start.
 */
async function searchSites(api: GraphApi, query: string, from: number, size: number):
    Promise<{ sites: GraphSite[]; nextFrom?: number }> {
  const queryString = searchWords(query) || "*";
  const body = await api.request<{ value?: unknown }>("POST", "/search/query", {
    body: { requests: [{ entityTypes: ["site"], query: { queryString }, from, size }] },
  });
  const container = Array.isArray(body?.value) ? body.value[0] as Record<string, unknown> | undefined : undefined;
  const sites: GraphSite[] = [];
  let more = false;
  for (const hits of Array.isArray(container?.hitsContainers) ? container.hitsContainers as Record<string, unknown>[] : []) {
    if (hits.moreResultsAvailable === true) more = true;
    for (const hit of Array.isArray(hits.hits) ? hits.hits as Record<string, unknown>[] : []) {
      try {
        sites.push(parseSite(hit.resource));
      } catch {
        // A hit that isn't a readable site is skipped; the rest of the page stands.
      }
    }
  }
  return { sites, ...(more ? { nextFrom: from + size } : {}) };
}

/** The tenant's admin, search and app catalog sites, which nobody means to bind. */
function isSystemSite(site: GraphSite): boolean {
  return /\/sites\/(appcatalog|search|contentTypeHub)\/?$/i.test(site.webUrl) || /-admin\.sharepoint\.com/i.test(site.webUrl);
}

/**
 * One page of the sites a user can open, for browsing: on the first page, the home site and the
 * sites they follow (what they most likely mean), then everything Microsoft Search finds; OneDrives
 * and system sites left out, each site once. With a query, every source is narrowed to it.
 * @returns The sites, the next page's offset, and the search failure when only the first two
 * sources answered.
 */
export async function browseSites(api: GraphApi, query: string | undefined, from: number, size: number):
    Promise<{ sites: GraphSite[]; nextFrom?: number; searchError?: unknown }> {
  const needle = query?.toLowerCase();
  const matches = (site: GraphSite) => needle === undefined || site.name.toLowerCase().includes(needle)
    || (site.description ?? "").toLowerCase().includes(needle);
  const [pinned, search] = await Promise.all([
    from > 0 ? Promise.resolve([]) : Promise.all([
      getSite(api, "root").catch(() => null),
      listFollowedSites(api, undefined).then(followed => followed.items.toSorted((a, b) => a.name.localeCompare(b.name))).catch(() => []),
    ]).then(([root, followed]) => [root, ...followed]),
    searchSites(api, query ?? "*", from, size).then(result => ({ result }), (searchError: unknown) => ({ searchError })),
  ]);
  const seen = new Set<string>();
  const keep = (site: GraphSite | null): site is GraphSite => {
    if (site === null || site.personal || isSystemSite(site) || seen.has(site.id)) return false;
    seen.add(site.id);
    return true;
  };
  const first = pinned.filter((site): site is GraphSite => site !== null && matches(site)).filter(keep);
  if ("searchError" in search) return { sites: first, searchError: search.searchError };
  return {
    sites: [...first, ...search.result.sites.filter(keep)],
    ...(search.result.nextFrom !== undefined ? { nextFrom: search.result.nextFrom } : {}),
  };
}

// -- lists --------------------------------------------------------------------------------------

/** A list by ID, or null. */
export async function getList(api: GraphApi, ref: ListRef): Promise<GraphList | null> {
  const body = await api.find<unknown>(`/sites/${ref.siteId}/lists/${ref.listId}`, { query: { $select: LIST_SELECT } });
  return body === null ? null : parseList(body);
}

/** A list's columns. */
export async function listColumns(api: GraphApi, ref: ListRef): Promise<GraphColumn[]> {
  const body = await api.get<unknown>(`/sites/${ref.siteId}/lists/${ref.listId}/columns`);
  return parsePage(body, parseColumn, "column").items;
}

/**
 * The header that lets Graph filter or sort on a column SharePoint has not indexed. It works on any
 * list under the 5,000-item view threshold; above it SharePoint refuses, and the caller explains.
 */
const UNINDEXED_QUERIES = "HonorNonIndexedQueriesWarningMayFailRandomly";

/** One page of list items for a compiled query. */
export function listItems(api: GraphApi, ref: ListRef, query: Record<string, string>, token: string | undefined, top: number,
                          unindexed: boolean): Promise<Page<GraphListItem>> {
  return page(api, token, `/sites/${ref.siteId}/lists/${ref.listId}/items`, { ...query, $top: top }, parseListItem, "list item",
    unindexed ? [UNINDEXED_QUERIES] : undefined);
}

/** A list item, or null. */
export async function getListItem(api: GraphApi, ref: ListRef, itemId: string): Promise<GraphListItem | null> {
  if (!/^[0-9]{1,10}$/.test(itemId)) return null;
  const body = await api.find<unknown>(`/sites/${ref.siteId}/lists/${ref.listId}/items/${itemId}`, { query: { $expand: "fields" } });
  return body === null ? null : parseListItem(body);
}

// -- pages --------------------------------------------------------------------------------------

/** One page of a site's modern pages. */
export function listPages(api: GraphApi, siteId: string, token: string | undefined, top: number): Promise<Page<GraphSitePage>> {
  return page(api, token, `/sites/${siteId}/pages/microsoft.graph.sitePage`, { $select: PAGE_SELECT, $top: top }, parseSitePage, "page");
}

/** A page with its canvas, or null. */
export async function getPage(api: GraphApi, ref: PageRef): Promise<{ page: GraphSitePage; body: unknown } | null> {
  const body = await api.find<unknown>(`/sites/${ref.siteId}/pages/${ref.pageId}/microsoft.graph.sitePage`, {
    query: { $select: PAGE_SELECT, $expand: "canvasLayout" },
  });
  return body === null ? null : { page: parseSitePage(body), body };
}

// -- workbooks ----------------------------------------------------------------------------------

/** A workbook's worksheets. Reads need no workbook session (verified against SharePoint Online). */
export async function listWorksheets(api: GraphApi, ref: ItemRef): Promise<GraphWorksheet[]> {
  const body = await api.get<unknown>(`/drives/${ref.driveId}/items/${ref.itemId}/workbook/worksheets`, {
    query: { $select: "id,name,visibility" },
  });
  return parsePage(body, parseWorksheet, "worksheet").items;
}

/** A worksheet's used range's address and size, without its cells. */
export async function usedRangeShape(api: GraphApi, ref: ItemRef, sheetId: string):
    Promise<{ address: string; rowCount: number; columnCount: number }> {
  const body = await api.get<Record<string, unknown>>(
    `/drives/${ref.driveId}/items/${ref.itemId}/workbook/worksheets/${encodeURIComponent(sheetId)}/usedRange(valuesOnly=true)`,
    { query: { $select: "address,rowCount,columnCount" } });
  return {
    address: typeof body.address === "string" ? body.address : "",
    rowCount: typeof body.rowCount === "number" ? body.rowCount : 0,
    columnCount: typeof body.columnCount === "number" ? body.columnCount : 0,
  };
}

/** A worksheet range's values and formulas. */
export async function readRange(api: GraphApi, ref: ItemRef, sheetId: string, address: string): Promise<GraphRange> {
  const body = await api.get<unknown>(
    `/drives/${ref.driveId}/items/${ref.itemId}/workbook/worksheets/${encodeURIComponent(sheetId)}/range(address='${encodeURIComponent(address.replace(/'/g, "''"))}')`,
    { query: { $select: "address,values,formulas" } });
  return parseRange(body);
}
