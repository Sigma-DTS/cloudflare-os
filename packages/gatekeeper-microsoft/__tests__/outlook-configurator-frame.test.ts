// The Outlook configurator frame in the sandbox runtime, under JSDOM: the journeys a user takes
// through it, with the gatekeeper capability faked so each test decides what it answers and when.
// Needs the generated frame (`build:configurator`, which `test:run` runs first).

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import type { OutlookConfiguratorStatus, OutlookFolderList } from "../src/configurator/outlook-configurator-types";

// JSDOM is the scripts package's, as for the runtime's own browser tests.
const { JSDOM } = createRequire(`${import.meta.dirname}/../../../scripts/package.json`)("jsdom");

type Dom = InstanceType<typeof JSDOM>;
type Call = { method: string; args: unknown[]; answered: boolean; resolve(value: unknown): void; reject(message: string): void };
type Answer = (...args: unknown[]) => unknown;
/** What the tests touch of the frame's elements; the package's types have no DOM. */
type FrameElement = {
  id: string; textContent: string | null; value: string; checked: boolean; scrollTop: number;
  focus(): void; click(): void; getAttribute(name: string): string | null; dispatchEvent(event: unknown): boolean;
};

const READY: OutlookConfiguratorStatus = {
  state: "ready", me: { address: "phillip@contoso.com", name: "Phillip Jones" },
  levels: ["read", "organize", "draft", "send"], sharedLevels: ["read"], limitedByDeployment: false,
};
const FOLDERS: OutlookFolderList = {
  folders: [
    { id: "AAMkInbox", name: "Inbox", path: "Inbox", depth: 0, kind: "inbox", descendants: 1 },
    { id: "AAMkVendors", name: "Vendors", path: "Inbox/Vendors", depth: 1, kind: "folder", descendants: 0 },
    { id: "AAMkSent", name: "Sent Items", path: "Sent Items", depth: 0, kind: "sent", descendants: 0 },
  ],
};
const generated = `${import.meta.dirname}/../src/generated/outlook-configurator-ui.txt`;

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

/** Starts the frame. `answers` answer calls at once; any other call waits for the test to answer it. */
async function start(answers: Record<string, Answer> = {}, initialResource?: string) {
  const dom = new JSDOM('<!DOCTYPE html><div id="root"></div>', { pretendToBeVisual: true, runScripts: "outside-only" });
  doms.push(dom);
  const calls: Call[] = [];
  const state = { ready: undefined as boolean | undefined, ensured: [] as string[][] };
  const window = dom.window;
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
    try {
      resolve(handler(...args));
    } catch (error) {
      reject(new window.Error((error as Error).message));
    }
  });
  window.gatekeeper = new Proxy({}, { get: (_target, method: string) => (...args: unknown[]) => answer(method, args) });
  window.host = {
    getInitialResource: async () => initialResource ? { resourceUrl: initialResource, resourceUrlPattern: "https://outlook.office.com/*" } : null,
    setSelectionReady: (ready: boolean) => { state.ready = ready; },
    resize() {}, forwardScroll() {},
    ensureResources: async (patterns: string[]) => { state.ensured.push(patterns); return true; },
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
  return {
    dom, calls, state, $, all,
    /** The calls of `method` waiting for an answer. */
    waiting: (method: string) => calls.filter(call => call.method === method && !call.answered),
    text: () => document.getElementById("root")!.textContent!.replace(/\s+/g, " "),
    collect: () => (window as unknown as { iframe: { collectResourceUrl(): Promise<string> } }).iframe.collectResourceUrl(),
    async choose(id: string) {
      const input = document.getElementById(id) as FrameElement;
      if (!input) throw new Error(`no ${id}; the frame shows: ${document.getElementById("root")!.textContent}`);
      // A click focuses what it lands on in a browser, but not in JSDOM.
      input.focus();
      input.click();
      await settle();
    },
    async type(selector: string, text: string) {
      const input = $(selector) as FrameElement;
      input.focus();
      input.value = text;
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
      await settle();
    },
    async press(key: string) {
      document.activeElement!.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
      await settle();
    },
    async click(text: string) {
      const button = all("button").find(candidate => candidate.textContent!.trim() === text);
      if (!button) throw new Error(`no button "${text}"`);
      button.click();
      await settle();
    },
  };
}

async function settle(ms = 0): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
  for (let index = 0; index < 5; index++) await new Promise(resolve => setTimeout(resolve, 0));
}

/** What the frame binds: the draft it hands the gatekeeper for the resource URL. */
async function collected(frame: Awaited<ReturnType<typeof start>>): Promise<unknown> {
  void frame.collect();
  await settle();
  return frame.waiting("resourceUrlFor").at(-1)!.args[0];
}

describe("the Outlook configurator frame", () => {
  it("opens on the whole mailbox, read only", async () => {
    const frame = await start({ getStatus: () => READY, listCategories: () => ({ categories: [], listed: true }) });
    expect((frame.$("#ol-mailbox-mine") as FrameElement).checked).toBe(true);
    expect((frame.$("#ol-target-all") as FrameElement).checked).toBe(true);
    expect((frame.$("#ol-access-read") as FrameElement).checked).toBe(true);
    expect(frame.text()).toContain("Mail can be read and searched. Nothing is changed.");
    // Narrowing waits behind "More options", which says what it holds.
    expect(frame.$("#ol-more")!.getAttribute("aria-expanded")).toBe("false");
    expect(frame.$("#ol-more")!.textContent).toContain("any time · any category");
    expect(frame.state.ready).toBe(true);
    expect(await collected(frame)).toEqual({ access: "read" });
    // Nothing is read to show the user beyond what they choose from.
    expect(frame.calls.map(call => call.method)).toEqual(["getStatus", "resourceUrlFor"]);
  });

  it("offers every level the mailbox allows, each saying what it permits", async () => {
    const frame = await start({ getStatus: () => READY });
    expect(frame.all('input[name="ol-access"]').map(node => node.id)).toEqual(["ol-access-read", "ol-access-organize", "ol-access-draft", "ol-access-send"]);
    await frame.choose("ol-access-send");
    expect(frame.text()).toContain("Mail can also be sent. Each message waits for your approval.");
    expect(await collected(frame)).toEqual({ access: "send" });
    // A conversation has nothing to narrow.
    await frame.choose("ol-target-conversation");
    expect(frame.$("#ol-more")).toBeNull();
  });

  it("chooses a folder from a filtered list, with or without its subfolders", async () => {
    const frame = await start({ getStatus: () => READY, listCategories: () => ({ categories: [], listed: true }), listFolders: () => FOLDERS });
    await frame.choose("ol-target-folder");
    expect(frame.state.ready).toBe(false);
    expect(frame.calls.filter(call => call.method === "listFolders").map(call => call.args)).toEqual([[null]]);
    await frame.type('[data-configurator-input="ol-folder-search"]', "vend");
    expect(frame.all("#ol-folders .ol-row-title").map(node => node.textContent)).toEqual(["Vendors"]);
    expect(frame.all("#ol-folders .ol-row-subtitle").map(node => node.textContent)).toEqual(["Inbox/Vendors"]);
    // Focus stays in the search box while the list re-renders under it.
    expect(frame.dom.window.document.activeElement?.getAttribute("data-configurator-input")).toBe("ol-folder-search");
    await frame.type('[data-configurator-input="ol-folder-search"]', "nothing");
    expect(frame.text()).toContain('No folders match "nothing".');
    await frame.press("Escape");
    expect(frame.all("#ol-folders .ol-row")).toHaveLength(3);
    await frame.choose("ol-folder-AAMkInbox");
    expect(frame.state.ready).toBe(true);
    expect(frame.text()).toContain("Include its 1 subfolder");
    await frame.choose("ol-subfolders");
    expect(await collected(frame)).toEqual({ access: "read", folder: { id: "AAMkInbox", subfolders: false } });
  });

  it("keeps the folder list scrolled where it was as choosing a folder re-renders it", async () => {
    const frame = await start({ getStatus: () => READY, listCategories: () => ({ categories: [], listed: true }), listFolders: () => FOLDERS });
    await frame.choose("ol-target-folder");
    const before = frame.$("#ol-folders")!;
    before.scrollTop = 120;
    await frame.choose("ol-folder-AAMkSent");
    expect(frame.$("#ol-folders")).not.toBe(before);
    expect(frame.$("#ol-folders")!.scrollTop).toBe(120);
    // Focus stays on the chosen radio across the rebuild.
    expect(frame.dom.window.document.activeElement?.id).toBe("ol-folder-AAMkSent");
  });

  it("adds people from suggestions, typed addresses, domains and pastes, and refuses what isn't one", async () => {
    const frame = await start({
      getStatus: () => READY, listCategories: () => ({ categories: [], listed: true }),
      searchPeople: () => [{ address: "sarah@contoso.com", name: "Sarah James" }],
    });
    await frame.choose("ol-target-people");
    expect(frame.state.ready).toBe(false);
    await frame.type("#ol-people-input", "sar");
    await settle(300);
    expect(frame.calls.filter(call => call.method === "searchPeople").map(call => call.args)).toEqual([["sar"]]);
    const input = () => frame.$("#ol-people-input")!;
    expect(input().getAttribute("aria-expanded")).toBe("true");
    expect(input().getAttribute("aria-activedescendant")).toBe("ol-person-0");
    await frame.press("Enter");
    expect(frame.all(".ol-chip-label").map(node => node.textContent)).toEqual(["Sarah James"]);
    expect(frame.dom.window.document.activeElement).toBe(input());

    await frame.type("#ol-people-input", "bob@contoso.com, fabrikam.com; ");
    expect(frame.all(".ol-chip-label").map(node => node.textContent)).toEqual(["Sarah James", "bob@contoso.com", "Anyone at fabrikam.com"]);

    await frame.type("#ol-people-input", "bob@");
    await frame.press("Enter");
    expect(frame.$("#ol-people-error")!.textContent).toBe(`"bob@" isn't an email address or a domain like @contoso.com.`);
    expect(input().getAttribute("aria-invalid")).toBe("true");
    await frame.type("#ol-people-input", "");
    await frame.press("Backspace");
    expect(frame.all(".ol-chip-label").map(node => node.textContent)).toEqual(["Sarah James", "bob@contoso.com"]);
    await frame.click("Remove bob@contoso.com");
    expect(await collected(frame)).toEqual({ access: "read", senders: ["sarah@contoso.com"] });
  });

  it("opens a shared mailbox only once the gatekeeper has opened it, and says why it couldn't", async () => {
    const frame = await start({ getStatus: () => READY, listCategories: () => ({ categories: [], listed: false }), listFolders: () => FOLDERS });
    await frame.choose("ol-mailbox-shared");
    expect(frame.state.ready).toBe(false);
    // Nothing of the user's own mailbox shows under a shared one that isn't open yet.
    expect(frame.$("#ol-target-all")).toBeNull();
    await frame.type("#ol-shared-input", "support");
    await frame.click("Open");
    expect(frame.$("#ol-shared-error")!.textContent).toBe(`"support" isn't an email address. Enter one like support@contoso.com.`);
    expect(frame.waiting("openSharedMailbox")).toHaveLength(0);

    await frame.type("#ol-shared-input", "Support@Contoso.com");
    await frame.press("Enter");
    expect(frame.text()).toContain("Opening…");
    frame.waiting("openSharedMailbox")[0]!.reject("You haven't been given access to support@contoso.com.");
    await settle();
    expect(frame.$("#ol-shared-error")!.textContent).toBe("You haven't been given access to support@contoso.com.");

    await frame.click("Open");
    frame.waiting("openSharedMailbox")[0]!.resolve({ address: "support@contoso.com", name: "Contoso Support" });
    await settle();
    expect(frame.text()).toContain("Contoso Supportsupport@contoso.comYou have access");
    await frame.choose("ol-more");
    // The shared mailbox allows only reading, so the higher levels aren't offered.
    expect(frame.all('input[name="ol-access"]').map(node => node.id)).toEqual(["ol-access-read"]);
    expect(frame.text()).toContain('For shared mailboxes, this connection allows up to "Read only".');
    await frame.choose("ol-target-folder");
    expect(frame.calls.filter(call => call.method === "listFolders").map(call => call.args)).toEqual([["support@contoso.com"]]);
    expect(frame.text()).toContain("A shared mailbox's categories can't be listed");
  });

  it("offers no shared mailbox when the grant can't open one, and says what would", async () => {
    const frame = await start({ getStatus: () => ({ ...READY, sharedLevels: [] }), listCategories: () => ({ categories: [], listed: true }) });
    expect(frame.$("#ol-mailbox-mine")).toBeNull();
    expect(frame.$("#ol-mailbox-shared")).toBeNull();
    expect((frame.$("#ol-target-all") as FrameElement).checked).toBe(true);
    expect(frame.state.ready).toBe(true);
    await frame.choose("ol-more");
    expect(frame.text()).toContain("Shared mailboxes open through your own account, once an admin approves more Microsoft 365 permissions and you reconnect.");
  });

  it("asks for Outlook access from the click, then reads the status again", async () => {
    let status: OutlookConfiguratorStatus = { state: "needsAccess" };
    const frame = await start({ getStatus: () => status, listCategories: () => ({ categories: [], listed: true }) });
    expect(frame.text()).toContain("hasn't been allowed to open Outlook yet");
    expect(frame.state.ready).toBe(false);
    status = READY;
    await frame.click("Allow access");
    expect(frame.state.ensured).toEqual([["https://outlook.office.com/*"]]);
    expect(frame.text()).toContain("What to connect");
  });

  it("collects the resource URL the gatekeeper writes", async () => {
    const frame = await start({ getStatus: () => READY });
    await frame.choose("ol-access-draft");
    const url = frame.collect();
    await settle();
    const [resolving] = frame.waiting("resourceUrlFor");
    expect(resolving!.args).toEqual([{ access: "draft" }]);
    resolving!.resolve("https://outlook.office.com/mail/?access=draft");
    await expect(url).resolves.toBe("https://outlook.office.com/mail/?access=draft");
  });

  it("opens a binding being edited where it was, narrowed as it was", async () => {
    const frame = await start({
      getStatus: () => READY, listFolders: () => FOLDERS,
      listCategories: () => ({ categories: [{ name: "Blue category", color: "#0078d4" }], listed: true }),
      locate: () => ({ access: "organize", folder: { id: "AAMkVendors", path: "Inbox/Vendors", subfolders: false }, categories: ["Blue category"], recentDays: 30 }),
    }, "https://outlook.office.com/mail/folder/AAMkVendors/?subfolders=0&categories=Blue+category&recent=30&access=organize");
    // "More options" opens itself to show what the binding changed from the defaults.
    expect(frame.$("#ol-more")!.getAttribute("aria-expanded")).toBe("true");
    for (const id of ["ol-target-folder", "ol-folder-AAMkVendors", "ol-access-organize", "ol-recent-30", "ol-category-Blue category"]) {
      expect((frame.$(`[id="${id}"]`) as FrameElement).checked, id).toBe(true);
    }
    expect((frame.$("#ol-subfolders") as FrameElement).checked).toBe(false);
    expect(await collected(frame)).toEqual({
      access: "organize", folder: { id: "AAMkVendors", subfolders: false }, categories: ["Blue category"], recentDays: 30,
    });
  });

  it("says what failed and retries just that", async () => {
    let fail = true;
    const frame = await start({
      getStatus: () => READY, listCategories: () => ({ categories: [], listed: true }),
      listFolders: () => {
        if (fail) throw new Error("Outlook didn't answer. Try again in a moment.");
        return FOLDERS;
      },
    });
    await frame.choose("ol-target-folder");
    expect(frame.$('[role="alert"]')!.textContent).toBe("Outlook didn't answer. Try again in a moment.");
    fail = false;
    await frame.click("Try again");
    expect(frame.all("#ol-folders .ol-row")).toHaveLength(3);
  });
});
