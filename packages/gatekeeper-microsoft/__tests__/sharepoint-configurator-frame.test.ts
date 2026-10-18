// The SharePoint configurator frame in the sandbox runtime, under JSDOM: the journeys a user takes
// through its picker, with the gatekeeper capability faked so each test decides what each listing
// answers and when. Needs the generated frame (`build:configurator`, which `test:run` runs first).

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import type {
  SharePointBrowserPage, SharePointConfiguratorStatus, SharePointLocated,
} from "../src/configurator/sharepoint-configurator-types";

// JSDOM is the scripts package's, as for the runtime's own browser tests.
const { JSDOM } = createRequire(`${import.meta.dirname}/../../../scripts/package.json`)("jsdom");

type Dom = InstanceType<typeof JSDOM>;
type Call = { method: string; args: unknown[]; answered: boolean; resolve(value: unknown): void; reject(message: string): void };
/** What the tests touch of the frame's elements; the package's types have no DOM. */
type FrameElement = {
  textContent: string | null; value: string; scrollTop: number; tabIndex: number; disabled: boolean;
  focus(): void; click(): void; getAttribute(name: string): string | null; dispatchEvent(event: unknown): boolean;
  querySelector(selector: string): FrameElement | null;
};

const READY: SharePointConfiguratorStatus = { state: "ready", access: "read", tenant: "contoso" };
const SITES: SharePointBrowserPage = {
  items: [
    { value: "site:eng", title: "Engineering", icon: "site", navigable: true, subtitle: "/sites/engineering" },
    { value: "site:legal", title: "Legal", icon: "site", navigable: true },
    { value: "file:d/report", title: "Report.docx", icon: "document", meta: "Oct 3" },
  ],
};
const ENGINEERING: SharePointBrowserPage = {
  items: [
    { value: "drive:docs", title: "Documents", icon: "library", navigable: true },
    { value: "list:eng/issues", title: "Issues", icon: "list" },
  ],
};
const ALL = "All of SharePoint & OneDrive";
const generated = `${import.meta.dirname}/../src/generated/sharepoint-configurator-ui.txt`;

function runtimeSource(): string {
  const html = readFileSync(generated, "utf8");
  const match = /<script type="module" src="data:text\/javascript;charset=utf-8,([^"]+)"/.exec(html);
  if (!match) throw new Error("the generated frame has no runtime module");
  return decodeURIComponent(match[1]!).replace(/^import .*;\n/gm, "");
}

const doms: Dom[] = [];
afterEach(() => {
  for (const dom of doms.splice(0)) dom.window.close();
});

/**
 * Starts the frame. `getStatus` answers ready, and `locate` answers `located`; every `loadItems`
 * waits for the test to answer it with `respond` or `fail`.
 */
async function start({ located, initialResource }: { located?: SharePointLocated; initialResource?: string } = {}) {
  const dom = new JSDOM('<!DOCTYPE html><div id="root"></div>', { pretendToBeVisual: true, runScripts: "outside-only" });
  doms.push(dom);
  const calls: Call[] = [];
  const window = dom.window;
  const answers: Record<string, (...args: unknown[]) => unknown> = {
    getStatus: () => READY,
    locate: () => located ?? null,
  };
  const answer = (method: string, args: unknown[]) => new window.Promise((resolve: (value: unknown) => void, reject: (error: unknown) => void) => {
    const call: Call = {
      method, args, answered: false,
      resolve: value => { call.answered = true; resolve(value); },
      reject: message => { call.answered = true; reject(new window.Error(message)); },
    };
    calls.push(call);
    const handler = answers[method];
    if (handler === undefined) return;
    call.answered = true;
    resolve(handler(...args));
  });
  window.gatekeeper = new Proxy({}, { get: (_target, method: string) => (...args: unknown[]) => answer(method, args) });
  window.host = {
    getInitialResource: async () => initialResource ? { resourceUrl: initialResource, resourceUrlPattern: "https://*.sharepoint.com/*" } : null,
    setSelectionReady() {}, resize() {}, forwardScroll() {},
    ensureResources: async () => true,
  };
  window.eval(`
    class MessageChannel { constructor() { this.port1 = {}; this.port2 = {}; } }
    class ResizeObserver { observe() {} disconnect() {} }
    class RpcTarget {}
    const CSS = { escape: value => String(value) };
    function newMessagePortRpcSession(port, iframe) {
      globalThis.iframe = iframe;
      return { gatekeeper: globalThis.gatekeeper, ...globalThis.host };
    }
    ${runtimeSource()}
  `);
  window.postMessage = () => {};
  // JSDOM doesn't lay out, so its scrollTop is always 0; keep what was set, as a browser would.
  const scrolled = new WeakMap<object, number>();
  Object.defineProperty(window.HTMLElement.prototype, "scrollTop", {
    get() { return scrolled.get(this) ?? 0; },
    set(offset: number) { scrolled.set(this, offset); },
  });
  await settle();
  const document = window.document;
  const $ = (selector: string) => document.querySelector(selector) as FrameElement | null;
  const all = (selector: string) => [...document.querySelectorAll(selector)] as FrameElement[];
  const loads = () => calls.filter(call => call.method === "loadItems");
  const frame = {
    dom, calls, $, all,
    /** What the picker asked `loadItems` for, in order. */
    requests: () => loads().map(call => call.args[0]),
    async respond(page: SharePointBrowserPage, index = loads().length - 1) {
      loads()[index]!.resolve(page);
      await settle();
    },
    async fail(message: string, index = loads().length - 1) {
      loads()[index]!.reject(message);
      await settle();
    },
    /** The listing's rows by accessible name. */
    rows: () => all('.browser-list [role="radio"]').map(node => node.getAttribute("aria-label")),
    row(name: string): FrameElement {
      const found = all('[role="radio"]').find(node => node.getAttribute("aria-label") === name);
      if (!found) throw new Error(`no row named ${name}; rows are ${frame.rows().join(", ")}`);
      return found;
    },
    /** The focused row's name, or the `data-sp-focus` id of anything else focused. */
    focused(): string | null {
      const active = document.activeElement as FrameElement | null;
      return active?.getAttribute(active.getAttribute("role") === "radio" ? "aria-label" : "data-sp-focus") ?? null;
    },
    text: () => document.getElementById("root")!.textContent!.replace(/\s+/g, " "),
    announced: () => $("#sp-announcer")?.textContent?.trim(),
    async click(node: FrameElement | null) {
      if (!node) throw new Error("nothing to click");
      node.click();
      await settle();
    },
    async press(key: string, target = document.activeElement as FrameElement | null) {
      const event = new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      target!.dispatchEvent(event);
      await settle();
      return event as { defaultPrevented: boolean };
    },
    async type(text: string) {
      const input = $(".browser-search-input")!;
      input.focus();
      input.value = text;
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
      await settle();
    },
    /** The ref the frame asks the gatekeeper to bind. */
    async collected(): Promise<unknown> {
      void (window as unknown as { iframe: { collectResourceUrl(): Promise<string> } }).iframe.collectResourceUrl();
      await settle();
      return calls.filter(call => call.method === "resourceUrlFor").at(-1)!.args[0];
    },
  };
  return frame;
}

async function settle(ms = 0): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
  for (let index = 0; index < 5; index++) await new Promise(resolve => setTimeout(resolve, 0));
}

type Frame = Awaited<ReturnType<typeof start>>;

async function openEngineering(frame: Frame) {
  await frame.respond(SITES);
  frame.row("Engineering").focus();
  await frame.click(frame.row("Engineering"));
  await frame.respond(ENGINEERING);
}

describe("the SharePoint configurator frame", () => {
  it("opens on everything, listing the Sites tab's root once, with placeholders until it arrives", async () => {
    const frame = await start();
    expect(frame.requests()).toEqual([{ tab: "sites" }]);
    expect(frame.$(".browser-list")!.getAttribute("aria-busy")).toBe("true");
    expect(frame.all(".browser-skeleton").length).toBeGreaterThan(0);
    expect(frame.row(ALL).getAttribute("aria-checked")).toBe("true");
    expect(frame.$(".browser-summary")!.textContent).toBe(
      "All of SharePoint & OneDrive: every site, library, list and file you can open, including ones you get access to later. Read only.");

    await frame.respond(SITES);
    expect(frame.rows()).toEqual(["Engineering", "Legal", "Report.docx"]);
    expect(frame.all(".browser-skeleton")).toHaveLength(0);
    expect(frame.row("Engineering").getAttribute("aria-description")).toBe("/sites/engineering. Has items. Press Right Arrow to open");
    expect(frame.$(".browser")!.getAttribute("aria-label")).toBe("What to connect");
    expect(frame.requests()).toHaveLength(1);
    expect(await frame.collected()).toBe("all");
  });

  it("opens a place, focuses its first row, and returns focus to it on the way back up", async () => {
    const frame = await start();
    await frame.respond(SITES);
    frame.row("Engineering").focus();
    await frame.click(frame.row("Engineering"));
    expect(frame.requests().at(-1)).toEqual({ tab: "sites", container: "site:eng" });
    // The place's own row is there before its contents, so focus need not wait for them.
    expect(frame.focused()).toBe("All of Engineering");

    await frame.respond(ENGINEERING);
    expect(frame.rows()).toEqual(["All of Engineering", "Documents", "Issues"]);
    expect(frame.focused()).toBe("All of Engineering");
    expect(frame.announced()).toBe("Opened Engineering, 2 items");
    expect(frame.$(".browser-back")!.getAttribute("aria-label")).toBe("Back to Sites");
    expect(frame.$('[aria-current="location"]')!.textContent).toBe("Engineering");

    await frame.press("ArrowLeft");
    expect(frame.requests()).toHaveLength(2);
    expect(frame.rows()).toEqual(["Engineering", "Legal", "Report.docx"]);
    expect(frame.focused()).toBe("Engineering");
  });

  it("goes up with the breadcrumb and the back button", async () => {
    const frame = await start();
    await openEngineering(frame);
    await frame.click(frame.row("Documents"));
    await frame.respond({ items: [{ value: "file:docs/spec", title: "Spec.docx" }] });
    expect(frame.$(".browser-back")!.getAttribute("aria-label")).toBe("Back to Engineering");
    expect(frame.all(".browser-crumb").map(crumb => crumb.textContent)).toEqual(["Sites", "Engineering", "Documents"]);

    frame.$('[data-sp-focus="crumb:0"]')!.focus();
    await frame.click(frame.$('[data-sp-focus="crumb:0"]'));
    expect(frame.focused()).toBe("Engineering");

    await frame.click(frame.row("Engineering"));
    await frame.respond(ENGINEERING);
    await frame.click(frame.$(".browser-back"));
    expect(frame.rows()).toEqual(["Engineering", "Legal", "Report.docx"]);
  });

  it("remembers each tab's place and switches tabs with the arrow keys", async () => {
    const frame = await start();
    await openEngineering(frame);
    const sites = frame.$('[role="tab"][aria-selected="true"]')!;
    expect(sites.textContent).toBe("Sites");
    sites.focus();
    await frame.press("ArrowRight");
    expect(frame.$('[role="tab"][aria-selected="true"]')!.textContent).toBe("OneDrive");
    expect(frame.focused()).toBe("tab:onedrive");
    expect(frame.requests().at(-1)).toEqual({ tab: "onedrive" });
    await frame.respond({ items: [{ value: "drive:me", title: "My files", icon: "onedrive", navigable: true }] });
    expect(frame.rows()).toEqual(["My files"]);

    await frame.press("ArrowLeft");
    expect(frame.requests()).toHaveLength(3);
    expect(frame.$('[aria-current="location"]')!.textContent).toBe("Engineering");
    expect(frame.rows()).toEqual(["All of Engineering", "Documents", "Issues"]);
  });

  it("chooses a row by its radio, the open place by its All of row, and everything by the All row", async () => {
    const frame = await start();
    await frame.respond(SITES);
    await frame.click(frame.row("Engineering").querySelector(".browser-radio-hit"));
    expect(frame.requests()).toHaveLength(1);
    expect(frame.row("Engineering").getAttribute("aria-checked")).toBe("true");
    expect(frame.row(ALL).getAttribute("aria-checked")).toBe("false");
    expect(frame.announced()).toBe("Chose Engineering");
    expect(frame.$(".browser-summary")!.textContent).toBe(
      "Engineering: the site’s libraries, lists and pages, including anything added later. Not its subsites. Read only.");
    expect(await frame.collected()).toBe("site:eng");

    await frame.click(frame.row("Legal"));
    await frame.respond({ items: [] });
    expect(frame.rows()).toEqual(["All of Legal"]);
    expect(frame.text()).toContain("Nothing here yet");
    await frame.press(" ", frame.row("All of Legal"));
    expect(frame.row("All of Legal").getAttribute("aria-checked")).toBe("true");
    expect(await frame.collected()).toBe("site:legal");

    await frame.click(frame.row(ALL));
    expect(frame.row(ALL).getAttribute("aria-checked")).toBe("true");
    expect(frame.row("All of Legal").getAttribute("aria-checked")).toBe("false");
    expect(await frame.collected()).toBe("all");
  });

  it("refuses a row that can't be chosen, with its reason, but still opens it", async () => {
    const frame = await start();
    await frame.respond(SITES);
    await frame.click(frame.row("Engineering"));
    await frame.respond({
      items: [{
        value: "pages:eng", title: "Site Pages", icon: "pages", navigable: true, subtitle: "Open to choose a page",
        selectable: false, unselectableReason: "Choose one page. To include every page, choose the whole site instead.",
      }],
    });
    const pages = frame.row("Site Pages");
    expect(pages.getAttribute("aria-disabled")).toBe("true");
    expect(pages.querySelector(".browser-row-subtitle")!.textContent).toBe("Open to choose a page");
    expect(pages.querySelector(".browser-radio")).toBeNull();
    await frame.press(" ", pages);
    expect(frame.announced()).toBe("Can't choose Site Pages. Choose one page. To include every page, choose the whole site instead.");
    expect(await frame.collected()).toBe("all");

    frame.row("Site Pages").focus();
    await frame.click(frame.row("Site Pages"));
    expect(frame.requests().at(-1)).toEqual({ tab: "sites", container: "pages:eng" });
    // With no row to land on yet, focus waits on the listing.
    expect(frame.focused()).toBe("list");
    await frame.respond({ items: [{ value: "page:eng/home", title: "Home", icon: "page" }] });
    expect(frame.rows()).toEqual(["Home"]);
    expect(frame.focused()).toBe("Home");
    expect(frame.$(".browser-place-reason")!.textContent).toBe("Choose one page. To include every page, choose the whole site instead.");
  });

  it("shows an error in place of the rows and retries just that place", async () => {
    const frame = await start();
    await frame.respond(SITES);
    await frame.click(frame.row("Engineering"));
    await frame.fail("You can't open this site anymore.");
    expect(frame.$(".browser-state")!.textContent).toBe("Couldn't open EngineeringYou can't open this site anymore.Try again");
    expect(frame.announced()).toBe("Couldn't open Engineering. You can't open this site anymore.");

    frame.$('[data-sp-focus="retry"]')!.focus();
    await frame.click(frame.$('[data-sp-focus="retry"]'));
    expect(frame.requests().slice(1)).toEqual([{ tab: "sites", container: "site:eng" }, { tab: "sites", container: "site:eng" }]);
    await frame.respond(ENGINEERING);
    expect(frame.rows()).toEqual(["All of Engineering", "Documents", "Issues"]);
    expect(frame.focused()).toBe("All of Engineering");
  });

  it("loads more on request, appending the page and moving focus to its first row", async () => {
    const frame = await start();
    await frame.respond({ ...SITES, nextPageToken: "from:3", notice: "Some sites are hidden." });
    expect(frame.$(".browser-notice")!.textContent).toBe("Some sites are hidden.");
    expect(frame.$(".browser-count")!.textContent).toBe("3 or more items");
    const more = frame.$('[data-sp-focus="more"]')!;
    expect(more.textContent).toBe("Show more");
    more.focus();
    await frame.click(more);
    expect(frame.requests().at(-1)).toEqual({ tab: "sites", pageToken: "from:3" });
    expect(frame.$('[data-sp-focus="more"]')!.getAttribute("aria-disabled")).toBe("true");
    expect(frame.focused()).toBe("more");

    await frame.respond({ items: [{ value: "site:hr", title: "HR", icon: "site", navigable: true }, SITES.items[0]!] });
    expect(frame.rows()).toEqual(["Engineering", "Legal", "Report.docx", "HR"]);
    expect(frame.$('[data-sp-focus="more"]')).toBeNull();
    expect(frame.focused()).toBe("HR");
    expect(frame.announced()).toBe("Showing 1 more");
  });
});

describe("searching the SharePoint picker", () => {
  it("waits for a pause in typing, searches at once on Enter, and drops a superseded search's late reply", async () => {
    const frame = await start();
    await frame.respond(SITES);
    await frame.type("en");
    expect(frame.requests()).toHaveLength(1);
    expect(frame.$(".browser-search")!.getAttribute("class")).toContain("busy");
    await settle(250);
    expect(frame.requests().at(-1)).toEqual({ tab: "sites", query: "en" });
    expect(frame.$(".browser-scope")!.textContent).toBe("Searching all of Sites…");

    await frame.type(" eng ");
    await frame.press("Enter");
    expect(frame.requests().at(-1)).toEqual({ tab: "sites", query: "eng" });
    expect(frame.focused()).toBe("search");

    await frame.respond({ items: [{ value: "site:eng", title: "Engineering", icon: "site", navigable: true, path: [] }] }, 2);
    await frame.respond({ items: [{ value: "site:late", title: "Late reply" }] }, 1);
    expect(frame.rows()).toEqual(["Engineering"]);
    expect(frame.$(".browser-scope")!.textContent).toBe("Results in all of Sites");
    expect(frame.$(".browser-list .browser-row-subtitle")!.textContent).toBe("Sites");
    expect(frame.announced()).toBe("1 result");
  });

  it("searches the open place and offers to widen a search that found nothing", async () => {
    const frame = await start();
    await openEngineering(frame);
    await frame.type("zzz");
    await frame.press("Enter");
    expect(frame.requests().at(-1)).toEqual({ tab: "sites", container: "site:eng", query: "zzz" });
    await frame.respond({ items: [] });
    expect(frame.$(".browser-state")!.textContent).toBe("No results for “zzz”Only Engineering was searched.Search all of Sites");
    expect(frame.announced()).toBe("No results for “zzz”");

    await frame.click(frame.$('[data-sp-focus="widen"]'));
    expect(frame.requests().at(-1)).toEqual({ tab: "sites", query: "zzz" });
  });

  it("looks up a pasted link, shows where the result lives, and opens it with its breadcrumb", async () => {
    const frame = await start();
    await frame.respond(SITES);
    const link = "https://contoso.sharepoint.com/sites/eng/Shared%20Documents/Specs";
    await frame.type(link);
    await frame.press("Enter");
    expect(frame.requests().at(-1)).toEqual({ tab: "sites", query: link });
    expect(frame.$(".browser-scope")!.textContent).toBe("Looking up link…");
    await frame.respond({
      items: [{
        value: "folder:docs/specs", title: "Specs", icon: "folder", navigable: true,
        path: [{ value: "site:eng", title: "Engineering", icon: "site" }, { value: "drive:docs", title: "Documents", icon: "library" }],
      }],
    });
    expect(frame.$(".browser-list .browser-row-subtitle")!.textContent).toBe("Engineering › Documents");
    await frame.click(frame.row("Specs").querySelector(".browser-radio-hit"));
    expect(await frame.collected()).toBe("folder:docs/specs");

    await frame.click(frame.row("Specs"));
    expect(frame.requests().at(-1)).toEqual({ tab: "sites", container: "folder:docs/specs" });
    expect(frame.$(".browser-search-input")!.value).toBe("");
    expect(frame.all(".browser-crumb").map(crumb => crumb.textContent)).toEqual(["Sites", "Engineering", "Documents", "Specs"]);
  });

  it("clears the search on Escape, and leaves a second Escape to the host", async () => {
    const frame = await start();
    await frame.respond(SITES);
    await frame.type("eng");
    await frame.press("Enter");
    await frame.respond({ items: [] });
    expect((await frame.press("Escape")).defaultPrevented).toBe(true);
    expect(frame.$(".browser-search-input")!.value).toBe("");
    expect(frame.rows()).toEqual(["Engineering", "Legal", "Report.docx"]);
    expect(frame.focused()).toBe("search");
    expect((await frame.press("Escape")).defaultPrevented).toBe(false);
  });

  it("keeps only the listings the open places and the current search need", async () => {
    const frame = await start();
    await openEngineering(frame);
    for (const query of ["a", "b"]) {
      await frame.type(query);
      await frame.press("Enter");
      await frame.respond({ items: [] });
    }
    await frame.press("Escape");
    // Engineering and the root were kept; the searches were not.
    expect(frame.requests()).toHaveLength(4);
    await frame.type("a");
    await frame.press("Enter");
    expect(frame.requests()).toHaveLength(5);
    // Nor was a place the picker has gone back up from.
    await frame.press("Escape");
    await frame.click(frame.$(".browser-back"));
    await frame.click(frame.row("Engineering"));
    expect(frame.requests().at(-1)).toEqual({ tab: "sites", container: "site:eng" });
    expect(frame.requests()).toHaveLength(6);
  });
});

describe("the SharePoint picker's keyboard and focus", () => {
  it("keeps one tab stop and moves with the arrows, Home, End and type-ahead", async () => {
    const frame = await start();
    await frame.respond({ items: [...SITES.items, { value: "site:labs", title: "Labs", icon: "site", navigable: true }] });
    const stops = () => frame.all('.browser-list [tabindex="0"]').map(node => node.getAttribute("aria-label"));
    expect(stops()).toEqual(["Engineering"]);

    frame.row("Engineering").focus();
    await frame.press("ArrowDown");
    expect(frame.focused()).toBe("Legal");
    expect(stops()).toEqual(["Legal"]);
    await frame.press("End");
    expect(frame.focused()).toBe("Labs");
    await frame.press("Home");
    expect(frame.focused()).toBe("Engineering");
    await frame.press("l");
    expect(frame.focused()).toBe("Legal");
    await frame.press("l");
    expect(frame.focused()).toBe("Labs");
    await settle(750);
    await frame.press("r");
    expect(frame.focused()).toBe("Report.docx");
  });

  it("opens with Enter and Right, chooses with Enter on a file and with Space, and keeps focus through the re-render", async () => {
    const frame = await start();
    await frame.respond(SITES);
    frame.row("Engineering").focus();
    await frame.press("Enter");
    await frame.respond(ENGINEERING);
    expect(frame.focused()).toBe("All of Engineering");
    await frame.press("Backspace");
    expect(frame.focused()).toBe("Engineering");

    frame.row("Report.docx").focus();
    await frame.press("Enter");
    expect(await frame.collected()).toBe("file:d/report");
    expect(frame.focused()).toBe("Report.docx");

    frame.row("Legal").focus();
    await frame.press(" ");
    expect(await frame.collected()).toBe("site:legal");
    expect(frame.focused()).toBe("Legal");
    await frame.press("ArrowRight");
    expect(frame.requests().at(-1)).toEqual({ tab: "sites", container: "site:legal" });
  });

  it("jumps to the search box on slash, and back to the rows on ArrowDown", async () => {
    const frame = await start();
    await frame.respond(SITES);
    frame.row("Legal").focus();
    await frame.press("ArrowDown");
    expect((await frame.press("/")).defaultPrevented).toBe(true);
    expect(frame.focused()).toBe("search");
    await frame.press("ArrowDown");
    expect(frame.focused()).toBe("Report.docx");
  });

  it("keeps the listing scrolled where it was as a choice re-renders it", async () => {
    const frame = await start();
    await frame.respond(SITES);
    const before = frame.$(".browser-list")!;
    before.scrollTop = 120;
    await frame.click(frame.row("Report.docx"));
    expect(frame.$(".browser-list")).not.toBe(before);
    expect(frame.$(".browser-list")!.scrollTop).toBe(120);
  });

  it("folds a deep breadcrumb's middle into a menu of the places it hides", async () => {
    const path = ["One", "Two", "Three", "Four"].map(title => ({ value: `folder:d/${title}`, title, icon: "folder" as const }));
    const frame = await start({
      initialResource: "https://contoso.sharepoint.com/x",
      located: { ref: "folder:d/Four", title: "Four", tab: "sites", path: path.slice(0, 3) },
    });
    // Opening on the chosen folder's parent: Three.
    await frame.respond({ items: [{ value: "folder:d/Four", title: "Four", icon: "folder", navigable: true }] });
    expect(frame.$(".browser-crumb-more")).toBeNull();
    await frame.click(frame.row("Four"));
    await frame.respond({ items: [] });
    const more = frame.$(".browser-crumb-more")!;
    expect(more.getAttribute("aria-label")).toBe("Show 2 more places");
    expect(more.getAttribute("title")).toBe("One › Two");
    expect(frame.all(".browser-crumbs > :not(.browser-crumb-separator)").map(crumb => crumb.textContent)).toEqual(["Sites", "…", "Three", "Four"]);

    more.focus();
    await frame.click(more);
    expect(frame.$(".browser-crumb-more")!.getAttribute("aria-expanded")).toBe("true");
    expect(frame.all('[role="menuitem"]').map(item => item.textContent)).toEqual(["One", "Two"]);
    expect(frame.focused()).toBe("menu:1");
    await frame.press("ArrowDown");
    expect(frame.focused()).toBe("menu:2");
    await frame.press("Escape");
    expect(frame.$('[role="menu"]')).toBeNull();
    expect(frame.focused()).toBe("crumb-more");

    await frame.click(frame.$(".browser-crumb-more"));
    await frame.click(frame.$('[role="menuitem"]'));
    expect(frame.requests().at(-1)).toEqual({ tab: "sites", container: "folder:d/One" });
  });
});

describe("editing a SharePoint binding", () => {
  it("opens where the bound item is, makes it the tab stop, and offers to show it once the user has moved", async () => {
    const frame = await start({
      initialResource: "https://contoso-my.sharepoint.com/personal/me/Documents/Projects/Two.docx",
      located: { ref: "file:me/two", title: "Two.docx", tab: "onedrive", path: [{ value: "folder:me/projects", title: "Projects", icon: "folder" }] },
    });
    expect(frame.requests()).toEqual([{ tab: "onedrive", container: "folder:me/projects" }]);
    expect(frame.$('[role="tab"][aria-selected="true"]')!.textContent).toBe("OneDrive");
    expect(frame.$('[aria-current="location"]')!.textContent).toBe("Projects");
    await frame.respond({ items: [{ value: "file:me/one", title: "One.docx" }, { value: "file:me/two", title: "Two.docx" }] });
    expect(frame.row("Two.docx").getAttribute("aria-checked")).toBe("true");
    expect(frame.row("Two.docx").tabIndex).toBe(0);
    expect(frame.$(".browser-summary")!.textContent).toBe("Two.docx: just this file. Read only.");

    await frame.click(frame.$(".browser-back"));
    await frame.respond({ items: [] });
    expect(frame.$(".browser-chosen-label")!.textContent).toBe("Chosen: Two.docx");
    frame.$('[data-sp-focus="show-chosen"]')!.focus();
    await frame.click(frame.$('[data-sp-focus="show-chosen"]'));
    await frame.respond({ items: [{ value: "file:me/one", title: "One.docx" }, { value: "file:me/two", title: "Two.docx" }] });
    expect(frame.$('[aria-current="location"]')!.textContent).toBe("Projects");
    expect(frame.focused()).toBe("Two.docx");
    expect(frame.$(".browser-chosen")).toBeNull();
    expect(await frame.collected()).toBe("file:me/two");
  });
});
