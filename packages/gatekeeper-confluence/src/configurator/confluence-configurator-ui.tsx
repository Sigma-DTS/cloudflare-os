import {
  Button, Field, Fragment, h, Notice, Section,
  type ConfiguratorUIRenderContext, type ConfiguratorUISpec,
} from "@gadgets/configurator-ui";
import type {
  ConfluenceBrowsePage as Page,
  ConfluenceBrowseRequest as Request,
  ConfluenceConfiguratorRpc as Rpc,
  ConfluenceConfiguratorStatus as Status,
  ConfluenceConfiguratorValues as Values,
  ConfluenceCrumb as Crumb,
  ConfluenceNode as Node,
  ConfluenceNodeKind as Kind,
  ConfluenceSite as Site,
} from "./confluence-configurator-types";

// Must equal the urlPatterns of SITE_RESOURCE, SPACE_RESOURCE and PAGE_RESOURCE in confluence.ts;
// __tests__/configurator-patterns.test.ts keeps the copies in step.
const SITE_PATTERN = "https://*.atlassian.net/wiki";
const SPACE_PATTERN = "https://*.atlassian.net/wiki/spaces/:spaceKey";
const PAGE_PATTERN = "https://*.atlassian.net/wiki/spaces/:spaceKey/pages/:pageId/*?";

const FIELD_LABEL = "What to connect";
const SEARCH_DELAY_MS = 300;
const TYPEAHEAD_MS = 700;
/** A listing stops offering more once it holds this many rows. */
const MAX_ROWS = 1000;
const SKELETON_ROWS = 7;
const PATH_SEPARATOR = " › ";
/** How many recently viewed pages the start page shows. */
const RECENT_ROWS = 5;

type Context = ConfiguratorUIRenderContext<Rpc, Values>;
type Connection = { state: "loading" } | { state: "failed"; message: string } | Status;

/**
 * The little of the frame's DOM this module touches: the nodes refs and events hand it. `h` builds
 * virtual nodes, which never are DOM nodes; the package's types have no DOM.
 */
type FrameNode = {
  isConnected: boolean; value: string; tabIndex: number;
  scrollTop: number; clientHeight: number; scrollHeight: number; offsetLeft: number;
  style: { minHeight: string; left: string };
  getAttribute(name: string): string | null;
  getBoundingClientRect(): { top: number; bottom: number; height: number };
  focus(options?: { preventScroll: boolean }): void;
  select(): void;
  contains(node: FrameNode | null): boolean;
  closest(selector: string): FrameNode | null;
};
type FrameEvent = {
  currentTarget: FrameNode; target: FrameNode; relatedTarget: FrameNode | null; detail: number;
  key: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean; isComposing: boolean;
  preventDefault(): void; stopPropagation(): void;
};
const frameDocument = (globalThis as unknown as { document?: { activeElement: FrameNode | null } }).document;

const errorMessage = (error: unknown, fallback: string) => error instanceof Error && error.message ? error.message : fallback;

// -- the connection -----------------------------------------------------------------------------

let connection: Connection = { state: "loading" };
let asked = false;
/**
 * A pre-filled resource URL the picker couldn't open, said in place of a choice: one this connection
 * can't open, or one whose lookup failed (`failed` says how), which can be tried again.
 */
let missing: { url: string; failed?: string } | null = null;
// Re-renders with what has loaded. Every render installs its own, so a late reply reaches the
// current tree. It changes no values, so it never invalidates a resource URL being collected.
let rerender: () => void = () => {};

function loadStatus({ ui }: Context): void {
  if (asked) return;
  asked = true;
  ui.getStatus().then(status => {
    connection = status;
    rerender();
  }, error => {
    connection = { state: "failed", message: errorMessage(error, "Couldn't reach Confluence.") };
    rerender();
  });
}

// -- space avatars ------------------------------------------------------------------------------

/** The most refs one `spaceAvatars` call may carry. */
const AVATAR_BATCH = 100;
/** Space avatars by ref, as the gatekeeper answered: a data URL, or null for a space with none. */
const avatars = new Map<string, string | null>();
const avatarsAsked = new Set<string>();

/** Asks for the avatars of the spaces among `nodes` not asked for yet, and redraws when they arrive. */
function requestAvatars(ui: Rpc, nodes: Node[]): void {
  const refs = nodes
    .filter(node => (node.kind === "space" || node.kind === "personalSpace") && !avatars.has(node.ref) && !avatarsAsked.has(node.ref))
    .map(node => node.ref);
  for (let from = 0; from < refs.length; from += AVATAR_BATCH) {
    const batch = refs.slice(from, from + AVATAR_BATCH);
    for (const ref of batch) avatarsAsked.add(ref);
    ui.spaceAvatars(batch).then(found => {
      for (const ref of batch) avatars.set(ref, found[ref] ?? null);
      if (Object.keys(found).length > 0) rerender();
    }, () => {
      // Initials stand in. A later render asks again.
      for (const ref of batch) avatarsAsked.delete(ref);
    });
  }
}

// -- what a choice is ---------------------------------------------------------------------------

const PATTERN_OF: Partial<Record<Kind, string>> = {
  site: SITE_PATTERN, space: SPACE_PATTERN, personalSpace: SPACE_PATTERN,
  overview: PAGE_PATTERN, page: PAGE_PATTERN, liveDoc: PAGE_PATTERN, blogpost: PAGE_PATTERN,
};
const NOUN_OF_PATTERN: Record<string, string> = {
  [SITE_PATTERN]: "a whole site", [SPACE_PATTERN]: "a space", [PAGE_PATTERN]: "a page or blog post",
};

/** Whether the Workshop takes what `kind` binds. An older Workshop does not say, and takes any. */
function accepts(accepted: readonly string[] | undefined, kind: Kind): boolean {
  const pattern = PATTERN_OF[kind];
  return pattern !== undefined && (accepted === undefined || accepted.includes(pattern));
}

/** Why a node can't be chosen here, or undefined when it can. */
function refusal(accepted: readonly string[] | undefined, node: Pick<Node, "kind" | "selectable" | "unselectableReason">): string | undefined {
  if (!node.selectable) return node.unselectableReason ?? "This can't be connected.";
  if (accepts(accepted, node.kind)) return undefined;
  const nouns = (accepted ?? []).map(pattern => NOUN_OF_PATTERN[pattern]).filter(Boolean);
  return nouns.length > 0 ? `This connection needs ${nouns.join(" or ")}.` : "This can't be connected here.";
}

/** What a choice covers, in a sentence the summary finishes. Fixed words, matching what each session allows. */
function covers(kind: Kind, siteName: string): string {
  switch (kind) {
    case "site": return `: every space, page and blog post you can open on ${siteName}, including new ones.`;
    case "space":
    case "personalSpace": return ": its pages and blog posts, including new ones.";
    case "overview":
    case "page":
    case "liveDoc": return ": this page and the pages under it, including new ones.";
    case "blogpost": return ": just this blog post.";
    default: return ".";
  }
}

/** The place row's second line: what choosing the open place covers. */
const PLACE_COVERS: Partial<Record<Kind, string>> = {
  space: "Every page and blog post in it, including new ones",
  personalSpace: "Every page and blog post in it, including new ones",
  overview: "This page and the pages under it",
  page: "This page and the pages under it",
  liveDoc: "This page and the pages under it",
};

const siteRefOf = (ref: string) => `site:${ref.slice(ref.indexOf(":") + 1).split("/")[0]}`;

function parsePath(json: string | null | undefined): Crumb[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((crumb): crumb is Crumb => typeof crumb?.ref === "string" && typeof crumb?.title === "string" && typeof crumb?.kind === "string")
      : [];
  } catch {
    return [];
  }
}

/** The places a breadcrumb names, kept as rows so the place's own row can be drawn and chosen. */
function placesOf(crumbs: Crumb[]): Node[] {
  return crumbs.map(crumb => ({ ...crumb, expandable: true, selectable: PATTERN_OF[crumb.kind] !== undefined }));
}
const crumbsOf = (places: Node[]): Crumb[] => places.map(({ ref, title, kind }) => ({ ref, title, kind }));

// -- the picker's state -------------------------------------------------------------------------

/** One listing, as loaded. */
type Listing =
  | { state: "loading" }
  | { state: "failed"; message: string }
  | { state: "ready"; page: Page; more?: "loading" | "failed" };
/** A listing, and the row last focused in it, which is where the listing's tab stop returns to. */
type Entry = { listing: Listing; focusId?: string };

type SectionName = "recent" | "starred" | "spaces";

/** What the picker keeps across renders, since every render rebuilds its tree. */
const picker = {
  /** The open site's ref, once the connection is known. */
  site: null as string | null,
  /** Each site's open places, outermost first. */
  paths: {} as Record<string, Node[]>,
  /** What is typed in the search box, and the search it has become once the typing paused. */
  input: "",
  query: "",
  debounce: undefined as ReturnType<typeof setTimeout> | undefined,
  /**
   * Listings by {@link listingKey}. Only each site's open places, its start page and the current
   * search are kept, so going back up is instant without holding every place ever opened.
   */
  entries: new Map<string, Entry>(),
  /**
   * Where focus goes once it exists, by `data-cf-focus` id, or `first` (the listing's first row),
   * `checked` (the chosen row), `after:<id>` (the row after one) or `place:<ref>` (the row of a
   * place just left). It stands only while focus stays in the picker.
   */
  pending: null as string | null,
  /** Said once the place a navigation or search asked for has loaded. */
  announcement: null as { kind: "search" } | { kind: "open"; title: string } | null,
  /** Where the chosen row is, so "Show" can go back to it. */
  chosenAt: null as { site: string; path: Node[] } | null,
  /** Scrolls the chosen row into view once its place has loaded. */
  revealChosen: false,
  initialApplied: false,
  crumbMenuOpen: false,
  /** The tallest the listing has been: it never shrinks back, so the frame's height stays put. */
  minListHeight: 0,
  typeahead: { text: "", at: 0 },
  renders: 0,
};

function listingKey(site: string, place: string | null, query: string, section?: SectionName): string {
  return JSON.stringify([site, place, query, section ?? null]);
}

/** Loads a listing's first page, or its next one when it has loaded. A reply a retry or a newer page overtook is dropped. */
function fetchPage(ui: Rpc, entry: Entry, request: Request): void {
  const previous = entry.listing.state === "ready" ? entry.listing : undefined;
  const listing: Listing = previous ? { ...previous, more: "loading" } : { state: "loading" };
  entry.listing = listing;
  ui.loadItems(previous ? { ...request, cursor: previous.page.nextCursor } : request).then(page => {
    if (entry.listing !== listing) return;
    if (previous) {
      const known = new Set(previous.page.items.map(item => item.ref));
      const added = page.items.filter(item => !known.has(item.ref));
      const items = [...previous.page.items, ...added].slice(0, MAX_ROWS);
      entry.listing = {
        state: "ready",
        page: { items, nextCursor: items.length < MAX_ROWS ? page.nextCursor : undefined, notice: page.notice ?? previous.page.notice },
      };
      announce(`Showing ${added.length} more`);
    } else {
      entry.listing = { state: "ready", page };
    }
    rerender();
  }, error => {
    if (entry.listing !== listing) return;
    if (previous) {
      entry.listing = { ...previous, more: "failed" };
      announce("Couldn't load more");
    } else {
      entry.listing = { state: "failed", message: errorMessage(error, "Something went wrong.") };
    }
    rerender();
  });
}

/**
 * Opens the picker where a pre-filled choice lives. The runtime fills it in before the first
 * render, so only that render looks; a later choice is the user's, made where they can see it.
 */
function applyInitialLocation(values: Values, sites: Site[]): void {
  if (picker.initialApplied) return;
  picker.initialApplied = true;
  if (!values.ref) return;
  const site = siteRefOf(values.ref);
  if (!sites.some(candidate => candidate.ref === site)) return;
  picker.site = site;
  if (values.kind === "site") return;
  picker.paths[site] = placesOf(parsePath(values.path));
  picker.chosenAt = { site, path: picker.paths[site]! };
  picker.revealChosen = true;
}

// -- pieces -------------------------------------------------------------------------------------

/** What the picker last did, read out by the live region `render` keeps outside the picker. */
let announced = "";
// Repeating a message must still change the region, or it is not read out again. The caller
// re-renders, as every announcement comes with a change to show.
function announce(message: string): void {
  announced = announced === message ? `${message} ` : message;
}

// Atlassian's own 16px glyphs (@atlaskit/icon and @atlaskit/icon-lab, Apache-2.0): the ones
// Confluence draws for each kind of content, so every row reads as it does there.
const ATLASKIT = {
  page: ["M1 3a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2zm2-.5a.5.5 0 0 0-.5.5v10a.5.5 0 0 0 .5.5h10a.5.5 0 0 0 .5-.5V3a.5.5 0 0 0-.5-.5zM12 6H4V4.5h8zm-2 3.5H4V8h6z"],
  liveDoc: ["M15 3.5H1V2h14zm-9 5H1V7h5zM6 14H1v-1.5h5zm2.72-6.78a.75.75 0 0 1 .79-.17l6 2.25a.75.75 0 0 1-.08 1.43l-2.56.64-.64 2.56a.75.75 0 0 1-1.43.08l-2.25-6a.75.75 0 0 1 .17-.79"],
  blog: ["M0 4a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v6a4 4 0 0 1-4 4v-1.5A2.5 2.5 0 0 0 5.5 10V9H2a2 2 0 0 1-2-2zm5.5 3.5V4a.5.5 0 0 0-.5-.5H2a.5.5 0 0 0-.5.5v3a.5.5 0 0 0 .5.5zM9 4a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v6a4 4 0 0 1-4 4v-1.5a2.5 2.5 0 0 0 2.5-2.5V9H11a2 2 0 0 1-2-2zm5.5 3.5V4a.5.5 0 0 0-.5-.5h-3a.5.5 0 0 0-.5.5v3a.5.5 0 0 0 .5.5z"],
  home: ["M6.646.727a2 2 0 0 1 2.708 0l5 4.6A2 2 0 0 1 15 6.799V13a2 2 0 0 1-2 2H9.75a.75.75 0 0 1-.75-.75V9.5H7v4.75a.75.75 0 0 1-.75.75H3a2 2 0 0 1-2-2V6.799a2 2 0 0 1 .646-1.472zM8.339 1.83a.5.5 0 0 0-.678 0l-5 4.6a.5.5 0 0 0-.161.368V13a.5.5 0 0 0 .5.5h2.5V8.75A.75.75 0 0 1 6.25 8h3.5a.75.75 0 0 1 .75.75v4.75H13a.5.5 0 0 0 .5-.5V6.799a.5.5 0 0 0-.162-.368z"],
  folder: ["M3 2.5a.5.5 0 0 0-.5.5v3h11V4.75a.5.5 0 0 0-.5-.5H7.69L5.94 2.5zm10.5 5h-11V13a.5.5 0 0 0 .5.5h10a.5.5 0 0 0 .5-.5zM1 3a2 2 0 0 1 2-2h3.56l1.75 1.75H13a2 2 0 0 1 2 2V13a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2z"],
  whiteboard: ["M9.162 2.177c-.714.282-1.28.817-1.449 1.338l-1.426-.463C6.637 1.97 7.633 1.168 8.61.782c.943-.372 2.248-.49 3.09.375.346.356.536.777.548 1.236.011.437-.14.827-.323 1.144-.228.394-.557.761-.876 1.074 1.466-.136 2.717.239 3.421 1.134.827 1.05.644 2.464-.256 3.697l-1.212-.884c.66-.905.556-1.547.29-1.885-.305-.387-1.095-.757-2.524-.512-.521.09-.935.138-1.236.13a1.4 1.4 0 0 1-.537-.11.9.9 0 0 1-.345-.278.85.85 0 0 1-.164-.495 1.02 1.02 0 0 1 .197-.586c.077-.112.171-.215.256-.3.14-.143.323-.306.499-.464l.101-.09c.453-.407.87-.806 1.087-1.181.102-.178.124-.292.123-.354-.002-.04-.01-.113-.124-.23-.2-.204-.716-.321-1.464-.026M3.75 5.5a2.25 2.25 0 1 0 0 4.5 2.25 2.25 0 0 0 0-4.5M0 7.75a3.75 3.75 0 1 1 7.5 0 3.75 3.75 0 0 1-7.5 0m10.25.75a.75.75 0 0 1 .643.364l3 5A.75.75 0 0 1 13.25 15h-6a.75.75 0 0 1-.643-1.136l3-5a.75.75 0 0 1 .643-.364m-1.675 5h3.35l-1.675-2.792z"],
  database: ["M1 3a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2zm2-.5a.5.5 0 0 0-.5.5v3.5h11V3a.5.5 0 0 0-.5-.5zM13.5 8H8.75v2h4.75zm0 3.5H8.75v2H13a.5.5 0 0 0 .5-.5zm-6.25 2v-2H2.5V13a.5.5 0 0 0 .5.5zM2.5 10h4.75V8H2.5z"],
  embed: ["M1 3a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2zm2-.5a.5.5 0 0 0-.5.5v4h11V3a.5.5 0 0 0-.5-.5zm10.5 6h-11V13a.5.5 0 0 0 .5.5h10a.5.5 0 0 0 .5-.5zm-8-3H4V4h1.5zm6.5 0H7V4h5z"],
  personAvatar: ["M8 1.5a6.5 6.5 0 0 0-4.148 11.505A2.75 2.75 0 0 1 6.5 11h3c1.26 0 2.323.848 2.648 2.005A6.5 6.5 0 0 0 8 1.5m2.75 12.392v-.142c0-.69-.56-1.25-1.25-1.25h-3c-.69 0-1.25.56-1.25 1.25v.142l.06.027c.82.373 1.73.581 2.69.581s1.87-.208 2.69-.58q.03-.016.06-.028M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8m8-3.5a2 2 0 1 0 0 4 2 2 0 0 0 0-4m-3.5 2a3.5 3.5 0 1 1 7 0 3.5 3.5 0 0 1-7 0"],
  chevronRight: ["m6.03 1.47 6 6a.75.75 0 0 1 .052 1.004l-.052.056-6 6-1.06-1.06L10.44 8 4.97 2.53z"],
  chevronLeft: ["m9.97 1.47-6 6a.75.75 0 0 0-.052 1.004l.052.056 6 6 1.06-1.06L5.56 8l5.47-5.47z"],
  search: ["M7 2.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9M1 7a6 6 0 1 1 10.74 3.68l3.29 3.29-1.06 1.06-3.29-3.29A6 6 0 0 1 1 7"],
  cross: ["M13.53 3.53 9.06 8l4.47 4.47-1.06 1.06L8 9.06l-4.47 4.47-1.06-1.06L6.94 8 2.47 3.53l1.06-1.06L8 6.94l4.47-4.47z"],
  information: ["M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8m7.25.25H6.5v-1.5H8a.75.75 0 0 1 .75.75v5h-1.5z", "M9 4.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0"],
  shield: ["M8.53.22a.75.75 0 0 0-1.06 0C6.172 1.518 4.686 2.41 3.515 2.982a16 16 0 0 1-1.434.615 11 11 0 0 1-.51.174l-.023.007-.005.001A.75.75 0 0 0 1 4.5c0 4.338 1.651 7.176 3.334 8.926.836.87 1.672 1.463 2.304 1.842a9 9 0 0 0 .999.519l.066.027.02.008.006.002.003.001a.76.76 0 0 0 .535 0h.004l.006-.003.02-.008.066-.027q.083-.035.227-.103c.19-.09.456-.226.772-.416a11.3 11.3 0 0 0 2.304-1.842C13.349 11.676 15 8.838 15 4.5a.75.75 0 0 0-.544-.721l-.004-.001-.024-.007-.103-.033a11 11 0 0 1-.406-.141c-.35-.13-.85-.33-1.434-.615C11.314 2.412 9.828 1.518 8.53.22M8 1.783C6.69 2.963 5.286 3.788 4.172 4.33a17 17 0 0 1-1.663.707c.128 3.604 1.532 5.92 2.907 7.35a9.8 9.8 0 0 0 1.993 1.595c.24.144.443.25.591.322.148-.072.35-.178.59-.322a9.8 9.8 0 0 0 1.994-1.596c1.375-1.43 2.779-3.745 2.907-7.349l-.09-.032a17 17 0 0 1-1.573-.675C10.714 3.788 9.31 2.963 8 1.783"],
  clock: ["M14.5 8a6.5 6.5 0 1 0-13 0 6.5 6.5 0 0 0 13 0M8.75 3.25v4.389l2.219 1.775-.938 1.172-2.5-2-.281-.226V3.25zM16 8A8 8 0 1 1 0 8a8 8 0 0 1 16 0"],
  star: ["M8 0a.75.75 0 0 1 .7.48l1.705 4.434 4.403.338a.75.75 0 0 1 .422 1.324l-3.38 2.818 1.25 4.662a.75.75 0 0 1-1.148.813L8 12.159l-3.95 2.71a.75.75 0 0 1-1.15-.813l1.251-4.662L.77 6.576a.75.75 0 0 1 .422-1.324l4.403-.338L7.3.48A.75.75 0 0 1 8 0m0 2.84L6.655 6.335l-3.506.27 2.7 2.25-.973 3.627L8 10.341l3.124 2.142-.973-3.627 2.7-2.25-3.506-.27z", "M6.655 6.336 8 2.84l1.345 3.497 3.506.27-2.7 2.25.973 3.627L8 10.341l-3.124 2.142.973-3.627-2.7-2.25z"],
  grid: ["M1 3a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2zm2-.5a.5.5 0 0 0-.5.5v4.25h4.75V2.5zm5.75 0v4.75h4.75V3a.5.5 0 0 0-.5-.5zm4.75 6.25H8.75v4.75H13a.5.5 0 0 0 .5-.5zM7.25 13.5V8.75H2.5V13a.5.5 0 0 0 .5.5z"],
};
type Glyph = keyof typeof ATLASKIT;

const SECTIONS: { name: SectionName; title: string; glyph: Glyph }[] = [
  { name: "recent", title: "Recent", glyph: "clock" },
  { name: "starred", title: "Starred", glyph: "star" },
  { name: "spaces", title: "Spaces", glyph: "grid" },
];

// Each kind's glyph and tint: Confluence's own colours for its content types, as its object icons
// draw them (pages blue, live docs magenta), on the tints the other pickers use.
const ICONS: Record<Exclude<Kind, "site" | "space">, { glyph: Glyph; tint: string }> = {
  personalSpace: { glyph: "personAvatar", tint: "neutral" },
  overview: { glyph: "home", tint: "blue" },
  page: { glyph: "page", tint: "blue" },
  liveDoc: { glyph: "liveDoc", tint: "pink" },
  blogpost: { glyph: "blog", tint: "purple" },
  blogs: { glyph: "blog", tint: "purple" },
  folder: { glyph: "folder", tint: "neutral" },
  whiteboard: { glyph: "whiteboard", tint: "teal" },
  database: { glyph: "database", tint: "green" },
  embed: { glyph: "embed", tint: "neutral" },
};
// The tile behind a space with no icon of its own, picked by its key so it never changes.
const AVATAR_TINTS = ["blue", "teal", "green", "purple", "orange", "pink", "amber", "indigo"];

function glyph(name: Glyph, size: number, className?: string) {
  return <svg viewBox="0 0 16 16" width={String(size)} height={String(size)} aria-hidden="true" class={className}>
    {ATLASKIT[name].map(d => <path d={d} fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" />)}
  </svg>;
}

// The Confluence mark, as the Workshop draws the vendor (src/confluence-logo.svg).
function confluenceLogo(size: number) {
  return <svg viewBox="0 0 32 32" width={String(size)} height={String(size)} aria-hidden="true">
    <defs>
      <linearGradient id="cf-logo-a" x1="28.3" y1="24.7" x2="11.9" y2="15.2" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="#0052CC" /><stop offset="0.92" stop-color="#2684FF" />
      </linearGradient>
      <linearGradient id="cf-logo-b" x1="3.7" y1="7.3" x2="20.1" y2="16.8" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="#0052CC" /><stop offset="0.92" stop-color="#2684FF" />
      </linearGradient>
    </defs>
    <path fill="url(#cf-logo-a)" d="M5.7 22.6c-.3.5-.6 1-.9 1.5-.3.5-.1 1.1.4 1.4l5.7 3.5c.5.3 1.2.1 1.5-.4 0 0 .3-.5.6-1 2-3.4 4.1-3 7.8-1.2l5.7 2.7c.5.2 1.2 0 1.4-.6l2.7-6.2c.2-.5 0-1.2-.5-1.4-1.2-.6-3.6-1.7-5.7-2.7-7.7-3.7-14.3-3.5-18.2 2.9z" />
    <path fill="url(#cf-logo-b)" d="M26.3 9.4c.3-.5.6-1 .9-1.5.3-.5.1-1.1-.4-1.4L21.1 3c-.5-.3-1.2-.2-1.5.4 0 0-.3.5-.6 1-2 3.4-4.1 3-7.8 1.2L5.5 2.9c-.5-.2-1.2 0-1.4.6L1.4 9.7c-.2.5 0 1.2.5 1.4 1.2.6 3.6 1.7 5.7 2.7 7.7 3.7 14.3 3.4 18.2-2.9z" />
  </svg>;
}

/** A space's own icon, or a tile of its initials in a colour its key always picks. */
function spaceAvatar(node: Pick<Node, "ref" | "title">) {
  const avatar = avatars.get(node.ref);
  if (avatar) return <span className="browser-icon browser-avatar" aria-hidden="true"><img src={avatar} alt="" /></span>;
  const words = node.title.split(/\s+/).filter(word => /[\p{L}\p{N}]/u.test(word));
  const initials = (words.length > 1 ? [...words[0]!][0]! + [...words[1]!][0]! : [...(words[0] ?? "?")].slice(0, 2).join("")).toUpperCase();
  let hash = 0;
  for (const char of node.ref) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return <span className={`browser-icon browser-initials tint-${AVATAR_TINTS[hash % AVATAR_TINTS.length]}`} aria-hidden="true">{initials}</span>;
}

function icon(node: Pick<Node, "ref" | "kind" | "title">) {
  if (node.kind === "site") return <span className="browser-icon browser-logo" aria-hidden="true">{confluenceLogo(18)}</span>;
  if (node.kind === "space" || (node.kind === "personalSpace" && avatars.get(node.ref))) return spaceAvatar(node);
  const { glyph: name, tint } = ICONS[node.kind] ?? ICONS.page;
  return <span className={`browser-icon tint-${tint}`} aria-hidden="true">{glyph(name, 16)}</span>;
}

/** A title with the words search matched in bold, as Confluence's own search sets them. */
function highlighted(title: string, matches: [number, number][] | undefined) {
  if (!matches?.length) return title;
  const parts: unknown[] = [];
  let at = 0;
  for (const [start, end] of matches.toSorted((a, b) => a[0] - b[0])) {
    if (start < at || end <= start) continue;
    if (start > at) parts.push(title.slice(at, start));
    parts.push(<mark className="browser-mark">{title.slice(start, end)}</mark>);
    at = end;
  }
  parts.push(title.slice(at));
  return parts;
}

function looksLikeLink(query: string): boolean {
  return /^(https?:\/\/|www\.)/i.test(query);
}

function count(n: number, more: boolean, noun: string): string {
  return `${n}${more ? " or more " : " "}${noun}${n === 1 && !more ? "" : "s"}`;
}

// Scrolls only the listing, never the frame or its host page, which scrollIntoView would do.
function scrollIntoList(list: FrameNode, node: FrameNode, center = false): void {
  const listBox = list.getBoundingClientRect();
  const nodeBox = node.getBoundingClientRect();
  if (center) list.scrollTop += nodeBox.top - listBox.top - (listBox.height - nodeBox.height) / 2;
  else if (nodeBox.top < listBox.top + 4) list.scrollTop -= listBox.top + 4 - nodeBox.top;
  else if (nodeBox.bottom > listBox.bottom - 4) list.scrollTop += nodeBox.bottom - (listBox.bottom - 4);
}

function radio(checked: boolean) {
  return <span className={checked ? "browser-radio checked" : "browser-radio"} />;
}

function separator() {
  return <span className="browser-crumb-separator" aria-hidden="true">›</span>;
}

function stateBlock(className: string, title: string, text: string | null, action?: unknown) {
  return <div className={`browser-state ${className}`}>
    <p className="browser-state-title">{title}</p>
    {text ? <p className="browser-state-text">{text}</p> : null}
    {action ?? null}
  </div>;
}

function focusIn(list: FrameNode, node: FrameNode): void {
  node.focus({ preventScroll: true });
  if (list.contains(node)) scrollIntoList(list, node);
}

function skeletonRows() {
  return Array.from({ length: SKELETON_ROWS }, (_, index) => <div className="browser-skeleton" aria-hidden="true">
    <span className="browser-skeleton-radio" />
    <span className="browser-skeleton-icon" />
    <span className="browser-skeleton-text">
      <span className="browser-skeleton-line" style={{ width: `${[58, 44, 66, 38, 52, 47, 61][index]}%` }} />
      <span className="browser-skeleton-line short" style={{ width: `${[32, 24, 36, 21, 28, 25, 30][index]}%` }} />
    </span>
  </div>);
}

// -- the picker ---------------------------------------------------------------------------------

/** The nodes of one render, by `data-cf-focus` id, and the order of its listing's tab stops. */
type Tree = { card: FrameNode; list: FrameNode; nodes: Map<string, FrameNode>; navIds: string[] };

/** A row of the listing: a node, and the start page section it is in, if any. */
type Row = { node: Node; section?: SectionName };

/**
 * Everything the user can choose, drawn as one card in the shape of the other pickers: the whole
 * site above, then a listing that starts where Confluence's sidebar does (recently viewed pages,
 * starred spaces, every space) and opens into a space's home page, blog and page tree. Clicking a
 * row that opens opens it, and its radio chooses it, so choosing a place and browsing into it
 * never conflict.
 */
function browser({ values, setValues, ui, acceptedResourceUrlPatterns: accepted }: Context, sites: Site[]) {
  const active = frameDocument?.activeElement ?? null;
  // What had focus in the picker before this render rebuilt it; null once focus has left it.
  const focusedId = active?.closest(".browser") ? active.getAttribute("data-cf-focus") : null;
  if (focusedId === null) picker.pending = null;
  applyInitialLocation(values, sites);

  // The runtime hands each element's node to its ref on commit, after this render returns.
  const nodes = new Map<string, FrameNode>();
  const tracked = (id: string) => ({ "data-cf-focus": id, ref: (node: FrameNode | null) => { if (node) nodes.set(id, node); } });
  let cardNode: FrameNode | undefined;
  let menuNode: FrameNode | undefined;

  const site = sites.find(candidate => candidate.ref === picker.site) ?? sites[0]!;
  picker.site = site.ref;
  const siteIndex = sites.indexOf(site);
  const path = picker.paths[site.ref] ?? [];
  const place = path.at(-1);
  const placeTitle = place?.title ?? site.name;
  const query = picker.query;
  const searching = query !== "";
  const link = searching && looksLikeLink(query);
  const value = values.ref ?? null;
  const siteNode: Node = { ref: site.ref, kind: "site", title: site.name, expandable: false, selectable: true };
  const siteChosen = value === site.ref;

  // ----- What the listing holds -----

  // A place or a search is one listing; the start page is three shown as one.
  const keys: string[] = [];
  const use = (key: string, request: Request): Entry => {
    keys.push(key);
    let found = picker.entries.get(key);
    if (!found) {
      found = { listing: { state: "loading" } };
      picker.entries.set(key, found);
      fetchPage(ui, found, request);
    }
    return found;
  };
  // The request behind `entry`, which its "Show more" pages through.
  let request: Request;
  let entry: Entry;
  let sections: { name: SectionName; title: string; glyph: Glyph; rows: Row[] }[] = [];
  if (searching) {
    request = { site: site.ref, query };
    entry = use(listingKey(site.ref, null, query), request);
  } else if (place) {
    request = { parent: place.ref };
    entry = use(listingKey(site.ref, place.ref, ""), request);
  } else {
    const loaded = {} as Record<SectionName, Entry>;
    for (const section of SECTIONS) {
      loaded[section.name] = use(listingKey(site.ref, null, "", section.name), { site: site.ref, section: section.name });
    }
    // Every space is the listing that pages, retries and holds the tab stop.
    request = { site: site.ref, section: "spaces" };
    entry = loaded.spaces;
    const ready = (name: SectionName) => {
      const loadedListing = loaded[name].listing;
      return loadedListing.state === "ready" ? loadedListing.page : undefined;
    };
    const spaces = ready("spaces");
    const starred = ready("starred");
    // A new account stars every space, and a Starred section repeating all of them says nothing.
    const starredRepeats = starred && spaces && !starred.nextCursor && !spaces.nextCursor
      && spaces.items.every(space => starred.items.some(candidate => candidate.ref === space.ref));
    const shown: Record<SectionName, Node[] | undefined> = {
      recent: ready("recent")?.items.slice(0, RECENT_ROWS),
      starred: starredRepeats ? undefined : starred?.items,
      spaces: spaces?.items,
    };
    // The start page waits for all three, so sections don't push one another down as they arrive.
    if (SECTIONS.some(section => loaded[section.name].listing.state === "loading")) {
      entry = { listing: { state: "loading" } };
    } else {
      sections = SECTIONS.flatMap(section => shown[section.name]?.length
        ? [{ ...section, rows: shown[section.name]!.map(node => ({ node, section: section.name })) }]
        : []);
    }
  }
  // Only each site's open places, its start page and the listing on show are kept.
  const kept = new Set(keys);
  for (const { ref } of sites) {
    for (const section of SECTIONS) kept.add(listingKey(ref, null, "", section.name));
    for (const opened of picker.paths[ref] ?? []) kept.add(listingKey(ref, opened.ref, ""));
  }
  for (const key of picker.entries.keys()) if (!kept.has(key)) picker.entries.delete(key);

  const listing = entry.listing;
  const loading = listing.state === "loading";
  const page = listing.state === "ready" ? listing.page : undefined;
  const more = listing.state === "ready" ? listing.more : undefined;
  const rows: Row[] = searching || place
    ? (page?.items ?? []).map(node => ({ node }))
    : sections.flatMap(section => section.rows);
  requestAvatars(ui, [...rows.map(row => row.node), ...path]);

  if (picker.announcement && !loading) {
    const announcement = picker.announcement;
    picker.announcement = null;
    if (announcement.kind === "search") {
      announce(listing.state === "failed" ? `Couldn't search. ${listing.message}`
        : rows.length === 0 ? (link ? "Nothing found for this link" : `No results for “${query}”`)
        : count(rows.length, Boolean(page?.nextCursor), "result"));
    } else {
      announce(listing.state === "failed" ? `Couldn't open ${announcement.title}. ${listing.message}`
        : `${place ? `Opened ${announcement.title}` : announcement.title}, `
          + (rows.length === 0 ? "nothing here yet" : count(rows.length, Boolean(page?.nextCursor), "item")));
    }
  }

  function clearSearch() {
    if (picker.debounce !== undefined) clearTimeout(picker.debounce);
    picker.debounce = undefined;
    picker.input = "";
    picker.query = "";
  }

  function commitQuery() {
    if (picker.debounce !== undefined) clearTimeout(picker.debounce);
    picker.debounce = undefined;
    const next = picker.input.trim();
    if (next !== picker.query) {
      picker.query = next;
      // A search is asked afresh each time, since what it finds changes.
      if (next) picker.entries.delete(listingKey(site.ref, null, next));
      picker.announcement = next ? { kind: "search" } : null;
    }
    rerender();
  }

  function navigate(nextPath: Node[], pending: string | null, nextSite = site.ref) {
    picker.crumbMenuOpen = false;
    picker.site = nextSite;
    picker.paths[nextSite] = nextPath;
    picker.pending = pending;
    picker.announcement = { kind: "open", title: nextPath.at(-1)?.title ?? sites.find(candidate => candidate.ref === nextSite)!.name };
    rerender();
  }

  // A search result or a recent page carries where it lives; anything else lives in the open place.
  const pathOf = ({ node, section }: Row) => (searching || section === "recent") && node.path ? placesOf(node.path) : path;

  function open(row: Row) {
    const nextPath = [...pathOf(row), { ...row.node, path: undefined, titleMatches: undefined }];
    clearSearch();
    navigate(nextPath, "first");
  }

  function goUp() {
    if (searching || !place) return;
    navigate(path.slice(0, -1), `place:${place.ref}`);
  }

  /** Keeps `depth` places of the path, landing on the row of the place that was below it. */
  function goToDepth(depth: number) {
    navigate(path.slice(0, depth), `place:${path[depth]!.ref}`);
  }

  function choose(node: Node, choicePath: Node[]) {
    const reason = refusal(accepted, node);
    if (reason) {
      announce(`Can't choose ${node.title}. ${reason}`);
      rerender();
      return;
    }
    missing = null;
    picker.chosenAt = { site: site.ref, path: choicePath };
    announce(`Chose ${node.kind === "site" ? `all of ${node.title}` : node.title}`);
    setValues({ ref: node.ref, title: node.title, kind: node.kind, path: JSON.stringify(crumbsOf(choicePath)) });
  }

  function switchSite(next: string) {
    if (next === site.ref) {
      // The open site's tab takes it back to its start, as a sidebar location does.
      if (path.length > 0 && !searching) navigate([], `tab:${next}`);
      return;
    }
    navigate(picker.paths[next] ?? [], `tab:${next}`, next);
  }

  function showChosen() {
    const chosenAt = picker.chosenAt;
    if (!chosenAt || !value) return;
    clearSearch();
    picker.revealChosen = true;
    navigate(chosenAt.path, "checked", chosenAt.site);
  }

  function retry() {
    for (const key of keys) picker.entries.delete(key);
    picker.pending = "first";
    picker.announcement = searching ? { kind: "search" } : { kind: "open", title: placeTitle };
    rerender();
  }

  function loadMore() {
    if (listing.state !== "ready" || !listing.page.nextCursor || listing.more === "loading") return;
    fetchPage(ui, entry, request);
    const last = rows.at(-1);
    if (last) picker.pending = `after:${rowId(last)}`;
    rerender();
  }

  // ----- The listing's tab stops, known before the rows are drawn -----

  // A space can be both starred and listed, so a row's id names its section too.
  const rowId = ({ node, section }: Row) => `row:${section ?? "in"}:${node.ref}`;
  const placeId = place ? `place:${place.ref}` : undefined;
  const placeRefusal = place ? refusal(accepted, place) : undefined;
  const placeChoosable = place !== undefined && placeRefusal === undefined;
  const navIds: string[] = [
    ...(!searching && placeId && placeChoosable ? [placeId] : []),
    ...(listing.state === "failed" ? ["retry"]
      : rows.length > 0 ? [...rows.map(rowId), ...(page?.nextCursor || more === "failed" ? ["more"] : [])]
      : []),
  ];
  // One tab stop for the listing: the row last focused here, else the chosen row, else the first.
  const checkedRow = value === null ? undefined : rows.find(row => row.node.ref === value);
  const checkedId = !searching && value !== null && place?.ref === value && placeChoosable ? placeId
    : checkedRow ? rowId(checkedRow) : undefined;
  const stopId = [entry.focusId, checkedId, navIds[0]].find(id => id && navIds.includes(id));
  const navNode = (id: string | undefined) => (id === undefined ? undefined : nodes.get(id));
  const tabStop = () => navIds.find(id => nodes.get(id)?.tabIndex === 0);

  // From the controls above the listing, ArrowDown moves to the listing's tab stop.
  const moveToList = (event: FrameEvent) => {
    const stop = navNode(tabStop());
    const list = nodes.get("list");
    if (!stop || !list) return;
    event.preventDefault();
    focusIn(list, stop);
  };

  // ----- The whole site, above everything else, when the Workshop takes it -----

  const allTitle = `All of ${site.name}`;
  const allRow = refusal(accepted, siteNode) ? null : <div
    className={`browser-row browser-all${siteChosen ? " selected" : ""}`}
    role="radio" aria-checked={siteChosen ? "true" : "false"} aria-label={allTitle}
    aria-description="Every space, page and blog post you can open" tabindex="0" {...tracked("all")}
    onClick={(event: FrameEvent) => {
      if (event.detail <= 1) choose(siteNode, []);
    }}
    onKeydown={(event: FrameEvent) => {
      if (event.key === " " || event.key === "Enter") {
        event.preventDefault();
        choose(siteNode, []);
      } else if (event.key === "ArrowDown") {
        moveToList(event);
      }
    }}
  >
    <span className="browser-radio-hit">{radio(siteChosen)}</span>
    {icon(siteNode)}
    <span className="browser-row-text">
      <span className="browser-row-title">{allTitle}</span>
      <span className="browser-row-subtitle">Every space, page and blog post you can open</span>
    </span>
  </div>;

  // ----- Sites and search -----

  const tablist = sites.length > 1
    ? <div className="browser-tabs" role="tablist" aria-label="Sites">
      {sites.map((candidate, index) => {
        const selected = candidate.ref === site.ref;
        return <button
          type="button" role="tab" id={`cf-tab-${index}`} className="browser-tab"
          aria-selected={selected ? "true" : "false"} aria-controls="cf-panel" tabindex={selected ? "0" : "-1"}
          title={candidate.host} {...tracked(`tab:${candidate.ref}`)}
          onClick={() => switchSite(candidate.ref)}
          onKeydown={(event: FrameEvent) => {
            const step = ({ ArrowRight: 1, ArrowLeft: -1 } as Record<string, number>)[event.key];
            const next = step ? sites[(index + step + sites.length) % sites.length]
              : event.key === "Home" ? sites[0] : event.key === "End" ? sites.at(-1) : undefined;
            if (!next) return;
            event.preventDefault();
            switchSite(next.ref);
          }}
        >{candidate.name}</button>;
      })}
    </div>
    : null;

  const searchInput = <input
    className="browser-search-input" type="search" data-configurator-input="cf-search" {...tracked("search")}
    value={picker.input} placeholder="Search Confluence or paste a link" aria-label={`Search ${site.name}, or paste a Confluence link`}
    aria-controls="cf-list" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="search"
    onInput={(event: FrameEvent) => {
      picker.input = event.currentTarget.value;
      if (picker.debounce !== undefined) clearTimeout(picker.debounce);
      picker.debounce = setTimeout(commitQuery, SEARCH_DELAY_MS);
      rerender();
    }}
    onKeydown={(event: FrameEvent) => {
      if (event.isComposing) return;
      if (event.key === "Enter") {
        event.preventDefault();
        commitQuery();
      } else if (event.key === "Escape") {
        // Only an Escape that clears something is consumed; with nothing to clear it is left be.
        if (!picker.input) return;
        event.preventDefault();
        event.stopPropagation();
        clearSearch();
        rerender();
      } else if (event.key === "ArrowDown") {
        moveToList(event);
      }
    }}
  />;
  const searchBusy = picker.debounce !== undefined || (searching && (loading || more === "loading"));
  const search = <div className={`browser-search${searchBusy ? " busy" : ""}`}>
    <span className="browser-search-icon">{glyph("search", 14)}</span>
    <span className="browser-spinner" aria-hidden="true" />
    {searchInput}
    <button type="button" className="browser-search-clear" aria-label="Clear search" title="Clear search" {...tracked("search-clear")}
      onClick={() => {
        clearSearch();
        picker.pending = "search";
        rerender();
      }}>{glyph("cross", 12)}</button>
  </div>;

  // ----- The listing -----

  function handleNavKey(event: FrameEvent, actions: { open?: () => void; choose(): void } | null) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const list = nodes.get("list");
    if (!list) return;
    const index = navIds.indexOf(event.currentTarget.getAttribute("data-cf-focus") ?? "");
    const go = (id: string | undefined) => {
      const target = navNode(id);
      if (!target) return;
      event.preventDefault();
      focusIn(list, target);
    };
    const rowHeight = navNode(navIds[0])?.getBoundingClientRect().height || 44;
    const pageSize = Math.max(1, Math.floor(list.clientHeight / rowHeight) - 1);
    switch (event.key) {
      case "ArrowDown": return go(navIds[index + 1]);
      case "ArrowUp": return go(navIds[index - 1]);
      case "Home": return go(navIds[0]);
      case "End": return go(navIds.at(-1));
      case "PageDown": return go(navIds[Math.min(navIds.length - 1, index + pageSize)]);
      case "PageUp": return go(navIds[Math.max(0, index - pageSize)]);
      case "Enter":
        if (!actions) return;
        event.preventDefault();
        return actions.open ? actions.open() : actions.choose();
      case " ":
        if (!actions) return;
        event.preventDefault();
        return actions.choose();
      case "ArrowRight":
        if (!actions?.open) return;
        event.preventDefault();
        return actions.open();
      case "ArrowLeft":
      case "Backspace":
        if (searching || !place) return;
        event.preventDefault();
        return goUp();
    }
    if (event.key.length !== 1 || event.key === " " || event.key === "/") return;
    const now = Date.now();
    const text = (now - picker.typeahead.at < TYPEAHEAD_MS ? picker.typeahead.text : "") + event.key.toLowerCase();
    picker.typeahead = { text, at: now };
    // Repeating one letter steps through the rows that start with it.
    const repeating = [...text].every(letter => letter === text[0]);
    const needle = repeating ? text[0]! : text;
    const start = repeating ? index + 1 : Math.max(0, index);
    const ordered = [...navIds.slice(start), ...navIds.slice(0, start)];
    go(ordered.find(id => (nodes.get(id)?.getAttribute("data-cf-title") ?? "").toLowerCase().startsWith(needle)));
  }

  // The tab stop follows focus between renders, so Tab returns to where the user was.
  function rememberFocus(node: FrameNode) {
    const id = node.getAttribute("data-cf-focus") ?? undefined;
    entry.focusId = id;
    for (const navId of navIds) {
      const nav = nodes.get(navId);
      if (nav) nav.tabIndex = navId === id ? 0 : -1;
    }
  }

  function navButton(id: string, className: string, onClick: () => void, children: unknown, busy = false) {
    return <button type="button" className={className} aria-disabled={busy ? "true" : undefined}
      tabindex={id === stopId ? "0" : "-1"} {...tracked(id)}
      onFocus={(event: FrameEvent) => rememberFocus(event.currentTarget)}
      onKeydown={(event: FrameEvent) => handleNavKey(event, null)}
      onClick={onClick}>{children}</button>;
  }

  function itemRow(row: Row, asPlace = false) {
    const { node } = row;
    const id = asPlace ? placeId! : rowId(row);
    const checked = value === node.ref;
    const reason = refusal(accepted, node);
    const selectable = reason === undefined;
    const opens = node.expandable && !asPlace;
    const title = asPlace ? `All of ${node.title}` : node.title;
    const choicePath = asPlace ? path.slice(0, -1) : pathOf(row);
    // Search results and recent pages say where they live; a space says its key.
    const location = (searching || row.section === "recent") && node.path
      ? (node.path.length > 0 ? node.path.map(crumb => crumb.title).join(PATH_SEPARATOR) : site.name)
      : undefined;
    const secondary = asPlace ? PLACE_COVERS[node.kind]
      // A row that opens says what it is; why it can't be chosen shows once it is open.
      : location ?? (opens ? node.subtitle : reason ?? node.subtitle);
    const actions = { open: opens ? () => open(row) : undefined, choose: () => choose(node, choicePath) };
    return <div
      className={`browser-row${checked ? " selected" : ""}${selectable ? "" : " unselectable"}${asPlace ? " browser-place" : ""}${opens ? " opens" : ""}`}
      role="radio" aria-checked={checked ? "true" : "false"} aria-disabled={selectable ? undefined : "true"} aria-label={title}
      aria-description={[location ? `In ${location}` : node.subtitle, node.meta, reason,
        opens ? "Has items. Press Right Arrow to open" : undefined].filter(Boolean).join(". ") || undefined}
      title={reason && !opens ? `${title} – ${reason}` : title}
      tabindex={id === stopId ? "0" : "-1"} data-cf-title={title} {...tracked(id)}
      onFocus={(event: FrameEvent) => rememberFocus(event.currentTarget)}
      onKeydown={(event: FrameEvent) => handleNavKey(event, actions)}
      onClick={(event: FrameEvent) => {
        // The second click of a double-click lands on whatever the first one opened.
        if (event.detail > 1) return;
        if (opens && !(selectable && event.target.closest(".browser-radio-hit"))) actions.open!();
        else actions.choose();
      }}
    >
      {/* A row that can't be chosen has no radio, only its room, so icons stay aligned. */}
      <span className="browser-radio-hit">{selectable ? radio(checked) : null}</span>
      {icon(node)}
      <span className="browser-row-text">
        <span className="browser-row-title">{asPlace ? title : highlighted(title, node.titleMatches)}</span>
        {secondary ? <span className={`browser-row-subtitle${secondary === reason ? " reason" : ""}`}>{secondary}</span> : null}
      </span>
      {node.meta && !asPlace ? <span className="browser-row-meta">{node.meta}</span> : null}
      {/* Rows that do not open keep the chevron's room, so every row's meta lines up. */}
      {opens ? glyph("chevronRight", 12, "browser-chevron") : asPlace ? null : <span className="browser-chevron-space" />}
    </div>;
  }

  const drawn: unknown[] = [];
  if (!searching && place) {
    drawn.push(placeChoosable ? itemRow({ node: place }, true) : <div className="browser-place-reason">
      {glyph("information", 14)}
      <span>{place.selectable
        ? placeRefusal
        : place.unselectableReason ?? `You can't choose all of ${place.title}, but you can choose what's inside.`}</span>
    </div>);
  }
  if (page?.notice) {
    drawn.push(<div className="browser-notice">{glyph("information", 14)}<span>{page.notice}</span></div>);
  }
  if (listing.state === "loading") {
    drawn.push(...skeletonRows());
  } else if (listing.state === "failed") {
    drawn.push(stateBlock("failed", searching ? "Couldn't search" : `Couldn't open ${placeTitle}`, listing.message,
      navButton("retry", "browser-button", retry, "Try again")));
  } else if (rows.length === 0) {
    drawn.push(searching
      ? stateBlock("empty", link ? "Nothing this connection can open" : `No results for “${query}”`,
        page?.notice ? null : link ? "Check the link, or search by title." : "Try other words, or browse the spaces instead.")
      : place
        ? stateBlock("empty", place.kind === "blogs" ? "No blog posts yet" : "Nothing here yet",
          placeChoosable ? `You can still choose all of ${place.title}.` : null)
        : stateBlock("empty", "No spaces", "This connection can't open any space on this site."));
  } else if (sections.length > 0) {
    for (const section of sections) {
      drawn.push(<div className="browser-section" role="presentation">{glyph(section.glyph, 14)}<span>{section.title}</span></div>);
      for (const row of section.rows) drawn.push(itemRow(row));
    }
  } else {
    for (const row of rows) drawn.push(itemRow(row));
  }
  if (rows.length > 0 && (page?.nextCursor || more === "failed")) {
    drawn.push(navButton("more", `browser-more${more === "loading" ? " busy" : ""}`, loadMore, more === "loading"
      ? [<span className="browser-spinner" aria-hidden="true" />, "Loading more…"]
      : more === "failed" ? "Couldn't load more. Try again" : "Show more", more === "loading"));
  }

  const list = <div
    className="browser-list" id="cf-list" role="radiogroup" aria-label={searching ? "Search results" : placeTitle}
    aria-busy={loading ? "true" : undefined} tabindex="-1" {...tracked("list")}
    style={picker.minListHeight ? { minHeight: `${picker.minListHeight}px` } : {}}
    onScroll={(event: FrameEvent) => {
      // Scrolling near the end loads the next page; the button stays for keyboards. A listing the
      // user has not scrolled never loads by itself, so a short page cannot chain into many.
      const node = event.currentTarget;
      if (node.scrollTop > 0 && node.scrollTop + node.clientHeight >= node.scrollHeight - 96 && more !== "failed") loadMore();
    }}
  >{drawn}</div>;

  // ----- Where the listing is: breadcrumb, or the search's scope -----

  const offerChosen = value !== null && !siteChosen && picker.chosenAt !== null && Boolean(values.title) && !loading && checkedId === undefined;
  const canGoUp = !searching && path.length > 0;
  const parentTitle = path.length > 1 ? path.at(-2)!.title : site.name;
  const back = canGoUp
    ? <button type="button" className="browser-back" aria-label={`Back to ${parentTitle}`} title={`Back to ${parentTitle}`}
      {...tracked("back")} onClick={goUp}>{glyph("chevronLeft", 12)}</button>
    : null;

  let crumbMenu: unknown = null;
  let where: unknown;
  if (searching) {
    where = <span className="browser-scope">{loading
      ? (link ? "Looking up link…" : `Searching ${site.name}…`)
      : link ? "Result for this link"
      : ["Results in ", <strong>{site.name}</strong>]}</span>;
  } else {
    // The site, then each place. Deep paths fold their middle into a "…" menu, so the breadcrumb
    // stays on one line and the current place keeps its room.
    const trail: { title: string }[] = [{ title: site.name }, ...path];
    const folded = path.length > 3 ? path.slice(0, -2) : [];
    const crumbs: unknown[] = [];
    trail.forEach((crumb, depth) => {
      if (folded.length > 0 && depth >= 1 && depth <= folded.length) {
        if (depth !== 1) return;
        crumbs.push(separator(), <button
          type="button" className="browser-crumb browser-crumb-more" aria-label={`Show ${folded.length} more places`}
          aria-haspopup="menu" aria-expanded={picker.crumbMenuOpen ? "true" : "false"}
          title={folded.map(hidden => hidden.title).join(PATH_SEPARATOR)} {...tracked("crumb-more")}
          onMousedown={(event: FrameEvent) => {
            // Keeps the menu's own focusout from closing it just before this click toggles it.
            if (picker.crumbMenuOpen) event.preventDefault();
          }}
          onClick={() => {
            picker.crumbMenuOpen = !picker.crumbMenuOpen;
            picker.pending = picker.crumbMenuOpen ? "menu:1" : "crumb-more";
            rerender();
          }}
        >…</button>);
        return;
      }
      if (depth > 0) crumbs.push(separator());
      crumbs.push(depth === trail.length - 1
        ? <span className="browser-crumb current" aria-current="location" title={crumb.title}>{crumb.title}</span>
        : <button type="button" className="browser-crumb" title={crumb.title} {...tracked(`crumb:${depth}`)}
          onClick={() => goToDepth(depth)}>{crumb.title}</button>);
    });
    where = <nav className="browser-crumbs" aria-label="Location">{crumbs}</nav>;

    if (picker.crumbMenuOpen && folded.length > 0) {
      const closeMenu = (pending: string | null) => {
        picker.crumbMenuOpen = false;
        picker.pending = pending;
        rerender();
      };
      const menuIds = folded.map((_, index) => `menu:${index + 1}`);
      crumbMenu = <div className="browser-crumb-menu" role="menu" aria-label="More places" data-floating-popup=""
        ref={(node: FrameNode | null) => { if (node) menuNode = node; }}
        onFocusout={(event: FrameEvent) => {
          if (event.relatedTarget && event.currentTarget.contains(event.relatedTarget)) return;
          const menu = event.currentTarget;
          setTimeout(() => {
            if (picker.crumbMenuOpen && !menu.contains(frameDocument?.activeElement ?? null)) closeMenu(null);
          }, 0);
        }}
      >{folded.map((crumb, index) => <button
        type="button" role="menuitem" className="browser-crumb-menu-item" tabindex="-1" {...tracked(menuIds[index]!)}
        onClick={() => goToDepth(index + 1)}
        onKeydown={(event: FrameEvent) => {
          const at = menuIds.indexOf(event.currentTarget.getAttribute("data-cf-focus") ?? "");
          const next = ({
            ArrowDown: menuIds[(at + 1) % menuIds.length], ArrowUp: menuIds[(at - 1 + menuIds.length) % menuIds.length],
            Home: menuIds[0], End: menuIds.at(-1),
          } as Record<string, string | undefined>)[event.key];
          if (next) {
            event.preventDefault();
            nodes.get(next)?.focus({ preventScroll: true });
          } else if (event.key === "Escape" || event.key === "Tab") {
            if (event.key === "Escape") event.preventDefault();
            closeMenu(event.key === "Escape" ? "crumb-more" : null);
          }
        }}
      >{icon(crumb)}<span>{crumb.title}</span></button>)}</div>;
    }
  }

  const tail = offerChosen
    ? <span className="browser-chosen">
      <span className="browser-chosen-label" title={values.title!}>Chosen: <strong>{values.title!}</strong></span>
      <button type="button" className="browser-link" aria-label={`Show ${values.title!}`} {...tracked("show-chosen")} onClick={showChosen}>Show</button>
    </span>
    : (searching || place) && page && rows.length > 0
      ? <span className="browser-count">{count(rows.length, Boolean(page.nextCursor), searching ? "result" : "item")}</span>
      : null;

  const panel = <div className="browser-panel" id="cf-panel" role={tablist ? "tabpanel" : undefined}
    aria-labelledby={tablist ? `cf-tab-${siteIndex}` : undefined}>
    <div className="browser-location">{back}{where}{tail}</div>
    {crumbMenu}
    {list}
  </div>;

  // ----- What the choice grants -----

  const chosenKind = values.kind ?? undefined;
  const chosenRefusal = values.ref && chosenKind ? refusal(accepted, { kind: chosenKind, selectable: PATTERN_OF[chosenKind] !== undefined }) : undefined;
  const summaryNode = values.ref && chosenKind
    ? <div className={`browser-summary${chosenRefusal ? " refused" : ""}`}>
      {glyph(chosenRefusal ? "information" : "shield", 14, "browser-summary-icon")}
      <p className="browser-summary-text">
        <strong>{chosenKind === "site" ? `All of ${values.title ?? site.name}` : values.title ?? "This choice"}</strong>
        {chosenRefusal ? `: ${chosenRefusal}` : `${covers(chosenKind, site.name)} Agents can read it and propose changes, and every change waits for your approval.`}
      </p>
    </div>
    : null;

  const card = <div className={`browser${allRow ? " with-all" : ""}`} role="group" aria-label={FIELD_LABEL}
    ref={(node: FrameNode | null) => { if (node) cardNode = node; }}
    onKeydown={(event: FrameEvent) => {
      // "/" jumps to the search box from anywhere in the picker but the box itself.
      const input = nodes.get("search");
      if (event.key !== "/" || !input || event.target === input) return;
      event.preventDefault();
      input.focus();
      input.select();
    }}
  >{allRow}<div className="browser-toolbar">{tablist}{search}</div>{panel}{summaryNode}</div>;

  // Once the runtime has committed the tree, the refs hold its nodes and focus can be put back.
  const run = ++picker.renders;
  queueMicrotask(() => {
    const listNode = nodes.get("list");
    if (run !== picker.renders || !cardNode?.isConnected || !listNode) return;
    const tree: Tree = { card: cardNode, list: listNode, nodes, navIds };
    if (picker.revealChosen && !loading) {
      picker.revealChosen = false;
      const row = navNode(checkedId);
      if (row) scrollIntoList(listNode, row, true);
    }
    const height = listNode.getBoundingClientRect().height;
    if (height > picker.minListHeight) {
      picker.minListHeight = height;
      listNode.style.minHeight = `${height}px`;
    }
    const opener = nodes.get("crumb-more");
    if (menuNode && opener) menuNode.style.left = `${Math.max(4, opener.offsetLeft - 8)}px`;
    restoreFocus(tree, focusedId, loading || more === "loading", checkedId);
  });

  return card;
}

/**
 * Puts focus back in the rebuilt picker. A pending target (where a navigation wants focus to land)
 * wins once it exists; while the place it is in is still loading, focus waits on the listing.
 */
function restoreFocus({ card, list, nodes, navIds }: Tree, focusedId: string | null, waiting: boolean, checkedId: string | undefined): void {
  if (focusedId === null) return;
  const pending = picker.pending;
  if (pending) {
    let target: FrameNode | undefined;
    if (pending === "first") target = navIds.length > 0 ? nodes.get(navIds[0]!) : undefined;
    else if (pending === "checked") target = checkedId ? nodes.get(checkedId) : undefined;
    else if (pending.startsWith("after:")) {
      const next = navIds[navIds.indexOf(pending.slice(6)) + 1];
      target = next?.startsWith("row:") ? nodes.get(next) : undefined;
    } else if (pending.startsWith("place:")) {
      // The place just left is a row of the place gone back to, in whichever section lists it.
      const ref = pending.slice(6);
      const id = navIds.find(candidate => candidate.startsWith("row:") && candidate.endsWith(`:${ref}`));
      target = id ? nodes.get(id) : undefined;
    } else target = nodes.get(pending);
    if (target) {
      picker.pending = null;
      focusIn(list, target);
      return;
    }
    if (waiting) {
      (nodes.get(focusedId) ?? list).focus({ preventScroll: true });
      return;
    }
    picker.pending = null;
  }
  const active = frameDocument?.activeElement ?? null;
  if (active && card.contains(active) && active.getAttribute("data-cf-focus") === focusedId) return;
  // Focus parked on the listing belongs on its tab stop once there is one.
  const target = (focusedId === "list" ? undefined : nodes.get(focusedId))
    ?? (focusedId.startsWith("tab:") ? nodes.get(`tab:${picker.site}`) : undefined)
    ?? navIds.map(id => nodes.get(id)).find(node => node?.tabIndex === 0)
    ?? list;
  target.focus({ preventScroll: true });
}

// The picker's own styles, on the runtime's tokens, so it follows the host's light and dark
// themes. They are the SharePoint picker's, so the Workshop's pickers look alike.
const STYLE = `
/* A label kept for screen readers, which the runtime's stylesheet doesn't provide. */
.visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }

.browser {
  --browser-row-height: 44px;
  --browser-tint-blue: oklch(54% 0.17 258);
  --browser-tint-green: oklch(53% 0.13 152);
  --browser-tint-orange: oklch(62% 0.17 48);
  --browser-tint-purple: oklch(53% 0.19 300);
  --browser-tint-pink: oklch(56% 0.19 350);
  --browser-tint-amber: oklch(62% 0.13 75);
  --browser-tint-indigo: oklch(52% 0.15 275);
  --browser-tint-teal: oklch(53% 0.09 195);
  position: relative; border: 1px solid var(--color-kumo-line); border-radius: 10px; background: var(--color-kumo-base);
  /* Long titles must ellipsize, not widen the grid track the picker sits in. */
  contain: inline-size;
}
@media (prefers-color-scheme: dark) {
  .browser {
    --browser-tint-blue: oklch(74% 0.13 258);
    --browser-tint-green: oklch(74% 0.13 152);
    --browser-tint-orange: oklch(76% 0.14 55);
    --browser-tint-purple: oklch(74% 0.13 300);
    --browser-tint-pink: oklch(74% 0.14 350);
    --browser-tint-amber: oklch(80% 0.12 80);
    --browser-tint-indigo: oklch(74% 0.11 275);
    --browser-tint-teal: oklch(76% 0.09 195);
  }
}
:where(.browser) button { font: inherit; color: inherit; }
.browser-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 8px 8px 6px; }
.browser.with-all .browser-toolbar { border-top: 1px solid var(--color-kumo-line); }
.browser-tabs { display: flex; gap: 2px; min-width: 0; max-width: 100%; overflow-x: auto; scrollbar-width: none; }
.browser-tabs::-webkit-scrollbar { display: none; }
.browser-tab { flex-shrink: 0; height: 28px; max-width: 180px; overflow: hidden; border: 0; border-radius: 6px; padding: 0 10px; background: transparent; color: var(--text-color-kumo-subtle); font-size: 12.5px; font-weight: 500; letter-spacing: -0.1px; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
.browser-tab:hover { background: var(--color-kumo-elevated); color: var(--text-color-kumo-default); }
.browser-tab[aria-selected="true"] { background: var(--color-kumo-tint); color: var(--text-color-kumo-default); }
.browser-search { position: relative; flex: 1 1 180px; min-width: 160px; margin-left: auto; }
.browser-search-icon { position: absolute; left: 9px; top: 50%; display: flex; transform: translateY(-50%); color: var(--text-color-kumo-inactive); pointer-events: none; }
.browser-search .browser-spinner { position: absolute; left: 10px; top: 50%; margin-top: -6px; display: none; }
.browser-search.busy .browser-search-icon { display: none; }
.browser-search.busy .browser-spinner { display: block; }
.browser-search-input { display: block; width: 100%; height: 30px; border: 1px solid var(--color-kumo-line); border-radius: 8px; padding: 0 28px 0 29px; background: var(--color-kumo-base); color: inherit; outline: none; font: inherit; font-size: 13px; letter-spacing: -0.2px; }
.browser-search-input::placeholder { color: var(--text-color-kumo-inactive); }
.browser-search-input::-webkit-search-cancel-button { -webkit-appearance: none; }
.browser-search-input:focus { border-color: var(--color-kumo-interact); box-shadow: 0 0 0 2px color-mix(in oklab, var(--color-kumo-interact) 35%, transparent); }
.browser-search-clear { position: absolute; right: 5px; top: 50%; display: flex; width: 20px; height: 20px; align-items: center; justify-content: center; transform: translateY(-50%); border: 0; border-radius: 50%; padding: 0; background: transparent; color: var(--text-color-kumo-subtle); cursor: pointer; }
.browser-search-clear:hover { background: var(--color-kumo-tint); color: var(--text-color-kumo-default); }
.browser-search-input:placeholder-shown ~ .browser-search-clear { display: none; }
.browser-spinner { display: inline-block; flex-shrink: 0; width: 12px; height: 12px; border: 1.5px solid var(--color-kumo-line); border-top-color: var(--text-color-kumo-subtle); border-radius: 50%; animation: browser-spin .7s linear infinite; }
.browser-location { display: flex; align-items: center; gap: 2px; height: 32px; padding: 0 8px; border-top: 1px solid var(--color-kumo-line); color: var(--text-color-kumo-subtle); font-size: 12.5px; line-height: 16px; }
.browser-back { display: flex; flex-shrink: 0; width: 24px; height: 24px; margin-left: -4px; align-items: center; justify-content: center; border: 0; border-radius: 6px; padding: 0; background: transparent; color: var(--text-color-kumo-subtle); cursor: pointer; }
.browser-back:hover { background: var(--color-kumo-tint); color: var(--text-color-kumo-default); }
.browser-crumbs { display: flex; flex: 1; align-items: center; gap: 1px; min-width: 0; overflow: hidden; white-space: nowrap; }
.browser-crumb { flex: 0 1 auto; min-width: 2.5em; max-width: 180px; overflow: hidden; border: 0; border-radius: 5px; padding: 2px 5px; background: none; color: var(--text-color-kumo-subtle); text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
button.browser-crumb:hover { background: var(--color-kumo-tint); color: var(--text-color-kumo-default); }
.browser-crumb.current { flex: 0 0 auto; max-width: 62%; color: var(--text-color-kumo-default); font-weight: 500; cursor: default; }
.browser-crumb-more { flex-shrink: 0; min-width: 0; letter-spacing: .05em; }
.browser-crumb-separator { flex-shrink: 0; padding: 0 1px; color: var(--text-color-kumo-inactive); }
.browser-scope { flex: 1; min-width: 0; overflow: hidden; padding: 0 5px; text-overflow: ellipsis; white-space: nowrap; }
.browser-scope strong, .browser-chosen strong { color: var(--text-color-kumo-default); font-weight: 500; }
.browser-count { flex-shrink: 0; padding-left: 8px; color: var(--text-color-kumo-inactive); font-variant-numeric: tabular-nums; }
.browser-chosen { display: flex; flex-shrink: 1; align-items: center; gap: 2px; min-width: 0; max-width: 46%; margin-left: 8px; border-radius: 999px; padding: 0 2px 0 9px; background: var(--color-kumo-tint); height: 22px; font-size: 12px; }
.browser-chosen-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.browser-link { flex-shrink: 0; border: 0; border-radius: 999px; padding: 2px 7px; background: none; color: var(--text-color-kumo-default); font-size: 12px; font-weight: 500; text-decoration: underline; text-decoration-color: var(--color-kumo-interact); text-underline-offset: 2px; cursor: pointer; }
.browser-link:hover { text-decoration-color: currentColor; }
.browser-crumb-menu { position: absolute; top: calc(100% - 2px); z-index: 10; display: grid; min-width: 180px; max-width: 280px; border: 1px solid var(--color-kumo-line); border-radius: 8px; padding: 4px; background: var(--color-kumo-base); box-shadow: 0 4px 16px rgb(0 0 0 / 10%); }
.browser-panel { position: relative; }
.browser-panel > .browser-crumb-menu { top: 30px; }
.browser-crumb-menu-item { display: flex; align-items: center; gap: 8px; min-width: 0; height: 32px; border: 0; border-radius: 6px; padding: 0 8px 0 4px; background: none; text-align: left; cursor: pointer; }
.browser-crumb-menu-item span:last-child { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.browser-crumb-menu-item:hover, .browser-crumb-menu-item:focus { background: var(--color-kumo-tint); outline: none; }
.browser-crumb-menu-item .browser-icon { width: 22px; height: 22px; border-radius: 5px; }
.browser-list { position: relative; display: grid; align-content: start; gap: 1px; max-height: 480px; overflow-y: auto; overscroll-behavior: contain; border-top: 1px solid var(--color-kumo-line); padding: 4px; outline: none; scroll-padding: 4px; }
/* A start page heading, set as Confluence's sidebar sets its own. */
.browser-section { display: flex; align-items: center; gap: 6px; height: 30px; padding: 8px 10px 0; color: var(--text-color-kumo-subtle); font-size: 12px; font-weight: 600; }
.browser-section:first-child { height: 24px; padding-top: 2px; }
.browser-section svg { flex-shrink: 0; }
.browser-row { display: flex; align-items: center; gap: 8px; height: var(--browser-row-height); min-width: 0; border-radius: 7px; padding: 0 8px 0 4px; outline: none; cursor: pointer; user-select: none; -webkit-user-select: none; }
.browser-row:hover { background: var(--color-kumo-elevated); }
.browser-row.selected, .browser-row.selected:hover { background: var(--color-kumo-tint); }
.browser-row:focus-visible { box-shadow: inset 0 0 0 2px var(--color-kumo-interact); }
.browser-row.unselectable:not(.opens) { cursor: default; }
.browser-all { margin: 4px; height: 52px; }
.browser-all .browser-row-title { font-weight: 600; }
.browser-place { position: relative; margin-bottom: 5px; }
.browser-place::after { content: ""; position: absolute; left: 6px; right: 6px; bottom: -3px; border-bottom: 1px solid var(--color-kumo-line); pointer-events: none; }
.browser-radio-hit { display: flex; flex-shrink: 0; width: 28px; height: 28px; align-items: center; justify-content: center; border-radius: 50%; }
.browser-row:not(.unselectable) .browser-radio-hit:hover { background: color-mix(in oklab, var(--color-kumo-interact) 40%, transparent); }
.browser-radio { display: block; width: 16px; height: 16px; border: 1.5px solid var(--color-kumo-interact); border-radius: 50%; background: var(--color-kumo-base); }
.browser-row:hover .browser-radio:not(.checked) { border-color: var(--text-color-kumo-inactive); }
.browser-radio.checked { border-color: var(--text-color-kumo-default); background: var(--text-color-kumo-default); box-shadow: inset 0 0 0 3.5px var(--color-kumo-base); }
.browser-icon { display: flex; flex-shrink: 0; width: 28px; height: 28px; align-items: center; justify-content: center; overflow: hidden; border-radius: 7px; color: var(--browser-tint); background: color-mix(in oklab, var(--browser-tint) 11%, var(--color-kumo-base)); }
.browser-icon.tint-neutral { --browser-tint: var(--text-color-kumo-subtle); background: var(--color-kumo-tint); }
.browser-row.selected .browser-icon.tint-neutral { background: var(--color-kumo-base); }
.browser-icon.tint-blue { --browser-tint: var(--browser-tint-blue); }
.browser-icon.tint-green { --browser-tint: var(--browser-tint-green); }
.browser-icon.tint-orange { --browser-tint: var(--browser-tint-orange); }
.browser-icon.tint-purple { --browser-tint: var(--browser-tint-purple); }
.browser-icon.tint-pink { --browser-tint: var(--browser-tint-pink); }
.browser-icon.tint-amber { --browser-tint: var(--browser-tint-amber); }
.browser-icon.tint-indigo { --browser-tint: var(--browser-tint-indigo); }
.browser-icon.tint-teal { --browser-tint: var(--browser-tint-teal); }
/* A space's icon is a picture, framed like Confluence's rounded space avatars. */
.browser-avatar { background: var(--color-kumo-tint); box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--text-color-kumo-default) 8%, transparent); }
.browser-avatar img { display: block; width: 100%; height: 100%; object-fit: cover; }
.browser-initials { color: #fff; background: var(--browser-tint); font-size: 10.5px; font-weight: 700; letter-spacing: .02em; }
@media (prefers-color-scheme: dark) {
  /* White initials keep the light theme's deeper tints behind them. */
  .browser-initials.tint-blue { --browser-tint: oklch(54% 0.17 258); }
  .browser-initials.tint-green { --browser-tint: oklch(53% 0.13 152); }
  .browser-initials.tint-orange { --browser-tint: oklch(62% 0.17 48); }
  .browser-initials.tint-purple { --browser-tint: oklch(53% 0.19 300); }
  .browser-initials.tint-pink { --browser-tint: oklch(56% 0.19 350); }
  .browser-initials.tint-amber { --browser-tint: oklch(62% 0.13 75); }
  .browser-initials.tint-indigo { --browser-tint: oklch(52% 0.15 275); }
  .browser-initials.tint-teal { --browser-tint: oklch(53% 0.09 195); }
}
.browser-logo { background: var(--color-kumo-tint); }
.browser-row-text { display: grid; flex: 1; gap: 1px; min-width: 0; }
.browser-row-title { min-width: 0; overflow: hidden; color: var(--text-color-kumo-default); font-size: 13px; font-weight: 500; line-height: 18px; letter-spacing: -0.15px; text-overflow: ellipsis; white-space: nowrap; }
.browser-mark { background: none; color: inherit; font-weight: 700; }
.browser-row.unselectable:not(.opens) .browser-row-title { color: var(--text-color-kumo-subtle); }
.browser-row-subtitle { min-width: 0; overflow: hidden; color: var(--text-color-kumo-subtle); font-size: 12px; line-height: 16px; text-overflow: ellipsis; white-space: nowrap; }
.browser-row-subtitle.reason { color: var(--text-color-kumo-inactive); }
.browser-row-meta { flex-shrink: 0; max-width: 34%; overflow: hidden; color: var(--text-color-kumo-subtle); font-size: 12px; font-variant-numeric: tabular-nums; text-align: right; text-overflow: ellipsis; white-space: nowrap; }
.browser-chevron-space { flex-shrink: 0; width: 12px; }
.browser-chevron { flex-shrink: 0; margin-right: -2px; color: var(--text-color-kumo-inactive); transition: transform .12s ease, color .12s ease; }
.browser-row:hover .browser-chevron { color: var(--text-color-kumo-subtle); transform: translateX(2px); }
.browser-place-reason, .browser-notice { display: flex; align-items: flex-start; gap: 7px; margin: 2px 0 4px; border-radius: 7px; padding: 7px 9px; background: var(--color-kumo-elevated); color: var(--text-color-kumo-subtle); font-size: 12px; line-height: 16px; }
.browser-place-reason svg, .browser-notice svg { flex-shrink: 0; margin-top: 1px; }
.browser-more { display: flex; align-items: center; justify-content: center; gap: 8px; height: 36px; margin-top: 2px; border: 0; border-radius: 7px; background: transparent; color: var(--text-color-kumo-subtle); font-size: 12.5px; font-weight: 500; cursor: pointer; outline: none; }
.browser-more:hover:not([aria-disabled="true"]) { background: var(--color-kumo-elevated); color: var(--text-color-kumo-default); }
.browser-more:focus-visible { box-shadow: inset 0 0 0 2px var(--color-kumo-interact); }
.browser-more.busy { cursor: progress; }
.browser-state { display: grid; justify-items: center; align-content: center; gap: 4px; min-height: calc(var(--browser-row-height) * 3); padding: 12px 16px; text-align: center; }
.browser-state p { margin: 0; max-width: 340px; }
.browser-state-title { color: var(--text-color-kumo-default); font-size: 13px; font-weight: 500; line-height: 18px; }
.browser-state-text { color: var(--text-color-kumo-subtle); font-size: 12px; line-height: 16px; overflow-wrap: anywhere; }
.browser-state.failed .browser-state-title { color: var(--color-kumo-danger); }
.browser-state .browser-link, .browser-state .browser-button { margin-top: 6px; }
.browser-button { display: inline-flex; height: 28px; align-items: center; border: 1px solid var(--color-kumo-line); border-radius: 7px; padding: 0 10px; background: var(--color-kumo-base); font-size: 12.5px; font-weight: 500; cursor: pointer; }
.browser-button:hover { background: var(--color-kumo-elevated); }
.browser-skeleton { display: flex; align-items: center; gap: 8px; height: var(--browser-row-height); padding: 0 8px 0 4px; }
.browser-skeleton-radio { flex-shrink: 0; width: 16px; height: 16px; margin: 0 6px; border-radius: 50%; background: var(--color-kumo-tint); }
.browser-skeleton-icon { flex-shrink: 0; width: 28px; height: 28px; border-radius: 7px; background: var(--color-kumo-tint); }
.browser-skeleton-text { display: grid; flex: 1; gap: 7px; }
.browser-skeleton-line { height: 8px; border-radius: 4px; background: linear-gradient(90deg, var(--color-kumo-tint) 0%, var(--color-kumo-elevated) 50%, var(--color-kumo-tint) 100%) 0 0 / 200% 100%; animation: browser-shimmer 1.4s ease-in-out infinite; }
.browser-skeleton-line.short { height: 6px; }
.browser-summary { display: flex; align-items: flex-start; gap: 8px; border-top: 1px solid var(--color-kumo-line); border-radius: 0 0 9px 9px; padding: 9px 12px 10px; background: var(--color-kumo-elevated); color: var(--text-color-kumo-subtle); font-size: 12px; line-height: 17px; }
.browser-summary-icon { flex-shrink: 0; margin-top: 1.5px; color: var(--text-color-kumo-default); }
.browser-summary-text { margin: 0; min-width: 0; }
.browser-summary strong { color: var(--text-color-kumo-default); font-weight: 600; }
.browser-summary.refused, .browser-summary.refused .browser-summary-icon { color: var(--color-kumo-danger); }
.browser-tab:focus-visible, .browser-back:focus-visible, .browser-crumb:focus-visible, .browser-link:focus-visible, .browser-button:focus-visible, .browser-search-clear:focus-visible { outline: 2px solid var(--color-kumo-interact); outline-offset: 1px; }
@keyframes browser-spin { to { transform: rotate(360deg); } }
@keyframes browser-shimmer { from { background-position: 100% 0; } to { background-position: -100% 0; } }
@media (prefers-reduced-motion: reduce) {
  .browser-skeleton-line { animation: none; }
  .browser-spinner { animation-duration: 1.6s; }
  .browser-chevron { transition: none; }
  .browser-row:hover .browser-chevron { transform: none; }
}
`;

const valuesOf = (node: Node): Values => ({ ref: node.ref, title: node.title, kind: node.kind, path: JSON.stringify(node.path ?? []) });

/** What became of a pre-filled resource URL the picker isn't showing as a choice. */
function prefillNotice({ ui, setValues }: Context, { url, failed }: NonNullable<typeof missing>) {
  if (failed === undefined) {
    return <Notice>{`Couldn't find ${url} in a Confluence site this connection can open. Choose what to connect.`}</Notice>;
  }
  return <Fragment>
    <Notice tone="error">{`Couldn't look up ${url}. ${failed}`}</Notice>
    <div>
      <Button variant="secondary" onClick={() => {
        ui.locate(url).then(located => {
          if (located === null) {
            missing = { url };
            rerender();
            return;
          }
          missing = null;
          // The next render opens the picker where it lives, as the first render would have.
          picker.initialApplied = false;
          setValues(valuesOf(located));
        }, error => {
          missing = { url, failed: errorMessage(error, "Couldn't reach Confluence.") };
          rerender();
        });
      }}>Try again</Button>
    </div>
  </Fragment>;
}

function notices(context: Context) {
  if (connection.state !== "failed" && connection.state !== "unavailable") return null;
  return <Fragment>
    <Notice tone="error">{connection.message}</Notice>
    {connection.state === "failed" ? <div>
      <Button variant="secondary" onClick={() => {
        asked = false;
        connection = { state: "loading" };
        loadStatus(context);
        rerender();
      }}>Try again</Button>
    </div> : null}
  </Fragment>;
}

export default {
  initial: {},

  isReady({ values, acceptedResourceUrlPatterns }) {
    return typeof values.ref === "string" && values.kind != null && accepts(acceptedResourceUrlPatterns, values.kind)
      && connection.state === "ready";
  },

  async initialValuesFromResourceUrl({ resourceUrl, ui }) {
    let located: Node | null;
    try {
      located = await ui.locate(resourceUrl);
    } catch (error) {
      missing = { url: resourceUrl, failed: errorMessage(error, "Couldn't reach Confluence.") };
      return {};
    }
    if (located === null) {
      // Never a fallback to the whole site: that would bind everything with one click, in place of what was asked for.
      missing = { url: resourceUrl };
      return {};
    }
    return valuesOf(located);
  },

  resourceUrl({ values, ui }) {
    if (!values.ref) throw new Error("Choose what to connect.");
    return ui.resourceUrlFor(values.ref);
  },

  render(context) {
    rerender = () => context.setValues({});
    loadStatus(context);
    if (connection.state === "unavailable" || connection.state === "failed") return <Section>{notices(context)}</Section>;
    return <Section>
      <style>{STYLE}</style>
      {missing !== null && !context.values.ref ? prefillNotice(context, missing) : null}
      <Field label={FIELD_LABEL}>
        {connection.state === "ready"
          ? browser(context, connection.sites)
          : <div className="browser"><div className="browser-list">{skeletonRows()}</div></div>}
      </Field>
      {/* Outside the picker, and kept across renders: a live region that arrives with its text may not be read out. */}
      <div className="visually-hidden" role="status" aria-live="polite" id="cf-announcer">{announced}</div>
    </Section>;
  },
} satisfies ConfiguratorUISpec<Rpc, Values>;
