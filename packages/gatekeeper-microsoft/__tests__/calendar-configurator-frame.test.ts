// The Calendar configurator frame in the sandbox runtime, under JSDOM: the journeys a user takes
// through it, with the gatekeeper capability faked so each test decides what it answers and when.
// Needs the generated frame (`build:configurator`, which `test:run` runs first).

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import type { CalendarConfiguratorStatus, CalendarRow } from "../src/configurator/calendar-configurator-types";

// JSDOM is the scripts package's, as for the runtime's own browser tests.
const { JSDOM } = createRequire(`${import.meta.dirname}/../../../scripts/package.json`)("jsdom");

type Dom = InstanceType<typeof JSDOM>;
type Call = { method: string; args: unknown[]; answered: boolean; resolve(value: unknown): void; reject(message: string): void };
type Answer = (...args: unknown[]) => unknown;
/** What the tests touch of the frame's elements; the package's types have no DOM. */
type FrameElement = {
  id: string; textContent: string | null; value: string; checked: boolean; disabled: boolean;
  focus(): void; click(): void; getAttribute(name: string): string | null; dispatchEvent(event: unknown): boolean;
};

const PATTERN = "https://outlook.office.com/calendar/*";
const READY: CalendarConfiguratorStatus = {
  state: "ready", me: { address: "phillip@contoso.com", name: "Phillip Jones" },
  levels: ["read", "edit", "schedule"], sharedLevels: ["read"], limitedByDeployment: false,
};
const CALENDARS: CalendarRow[] = [
  { id: "AAMkCalendarMain0001", name: "Calendar", isDefault: true, canEdit: true },
  { id: "AAMkCalendarTeam0002", name: "Gadgets Spike Team", isDefault: false, canEdit: true, color: "#0078d4" },
  { id: "AAMkCalendarHoliday3", name: "United States holidays", isDefault: false, canEdit: false },
];
const generated = `${import.meta.dirname}/../src/generated/calendar-configurator-ui.txt`;

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
    getInitialResource: async () => initialResource ? { resourceUrl: initialResource, resourceUrlPattern: PATTERN } : null,
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
  await settle();
  const document = window.document;
  const $ = (selector: string) => document.querySelector(selector) as FrameElement | null;
  const all = (selector: string) => [...document.querySelectorAll(selector)] as FrameElement[];
  const byId = (id: string) => document.getElementById(id) as FrameElement | null;
  return {
    dom, calls, state, $, all, byId,
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

const checked = (frame: Awaited<ReturnType<typeof start>>, id: string) => frame.byId(id)?.checked;
/** Opens "More options", where a calendar's event details live. */
const more = (frame: Awaited<ReturnType<typeof start>>) => frame.choose("cal-more");
/** What the frame binds: the draft it hands the gatekeeper for the resource URL. */
async function collected(frame: Awaited<ReturnType<typeof start>>): Promise<unknown> {
  void frame.collect();
  await settle();
  return frame.waiting("resourceUrlFor").at(-1)!.args[0];
}

describe("the Calendar configurator frame", () => {
  it("opens on every calendar, read only, with nothing more to choose", async () => {
    const frame = await start({ getStatus: () => READY });
    expect(checked(frame, "cal-target-all")).toBe(true);
    expect(checked(frame, "cal-access-read")).toBe(true);
    expect(frame.text()).toContain("Nothing can be changed.");
    expect(frame.byId("cal-more")).toBeNull();
    expect(frame.state.ready).toBe(true);
    expect(await collected(frame)).toEqual({ kind: "all", access: "read" });
    // Nothing is read to show the user beyond what they choose from.
    expect(frame.calls.map(call => call.method)).toEqual(["getStatus", "resourceUrlFor"]);
  });

  it("chooses one calendar, and offers its permission and details once it's chosen", async () => {
    const frame = await start({ getStatus: () => READY, listCalendars: () => CALENDARS });
    await frame.choose("cal-target-calendar");
    expect(frame.state.ready).toBe(false);
    expect(frame.byId("cal-access-read")).toBeNull();
    expect(frame.byId("cal-more")).toBeNull();
    expect(frame.all("#cal-calendars .cal-row-title").map(node => node.textContent)).toEqual(["Calendar", "Gadgets Spike Team", "United States holidays"]);
    expect(frame.byId("cal-calendar-AAMkCalendarHoliday3")!.getAttribute("aria-label")).toBe("United States holidays, Read only");
    await frame.choose("cal-calendar-AAMkCalendarTeam0002");
    expect(frame.state.ready).toBe(true);
    // Focus stays on the chosen radio across the rebuild.
    expect(frame.dom.window.document.activeElement?.id).toBe("cal-calendar-AAMkCalendarTeam0002");
    expect(checked(frame, "cal-access-read")).toBe(true);
    expect(frame.byId("cal-more")!.getAttribute("aria-expanded")).toBe("false");
    expect(frame.byId("cal-more")!.textContent).toContain("All details");
    expect(await collected(frame)).toEqual({ kind: "calendar", calendarId: "AAMkCalendarTeam0002", details: "full", privateEvents: "busy", access: "read" });
  });

  it("allows changes only with all details, and keeps the permission chosen for when they're back", async () => {
    const frame = await start({ getStatus: () => READY, listCalendars: () => CALENDARS });
    await frame.choose("cal-target-calendar");
    await frame.choose("cal-calendar-AAMkCalendarTeam0002");
    await frame.choose("cal-access-schedule");
    expect(frame.text()).toContain("Invitations can also be sent and answered. Each one waits for your approval.");
    await more(frame);
    await frame.choose("cal-details-limited");
    expect(frame.byId("cal-access-edit")!.disabled).toBe(true);
    expect(frame.byId("cal-access-schedule")!.disabled).toBe(true);
    expect(checked(frame, "cal-access-read")).toBe(true);
    expect(frame.text()).toContain("Changes need all details, under More options.");
    // Private events can only be shown in full.
    expect(frame.byId("cal-private")).toBeNull();
    await frame.choose("cal-details-full");
    expect(checked(frame, "cal-access-schedule")).toBe(true);
  });

  it("shows private events only when asked, and drops them with full details", async () => {
    const frame = await start({ getStatus: () => READY, listCalendars: () => CALENDARS });
    await frame.choose("cal-target-calendar");
    await frame.choose("cal-calendar-AAMkCalendarTeam0002");
    await more(frame);
    await frame.choose("cal-private");
    expect(checked(frame, "cal-private")).toBe(true);
    expect(frame.byId("cal-more")!.textContent).toContain("All details · private events shown");
    expect(await collected(frame)).toMatchObject({ details: "full", privateEvents: "show" });
    await frame.choose("cal-details-freeBusy");
    expect(await collected(frame)).toMatchObject({ details: "freeBusy", privateEvents: "busy" });
  });

  it("keeps a read-only calendar read only, and says why", async () => {
    const frame = await start({ getStatus: () => READY, listCalendars: () => CALENDARS });
    await frame.choose("cal-target-calendar");
    await frame.choose("cal-calendar-AAMkCalendarHoliday3");
    expect(frame.byId("cal-access-edit")!.disabled).toBe(true);
    expect(frame.text()).toContain(`You can't change events in "United States holidays" yourself.`);
  });

  it("offers the user's free time as free/busy of their main calendar, with nothing more to choose", async () => {
    const frame = await start({ getStatus: () => READY });
    await frame.choose("cal-target-freeTime");
    expect(frame.byId("cal-access-read")).toBeNull();
    expect(frame.byId("cal-more")).toBeNull();
    expect(await collected(frame)).toEqual({ kind: "calendar", calendarId: "default", details: "freeBusy", privateEvents: "busy", access: "read" });
  });

  it("offers colleagues' availability with nothing more to choose", async () => {
    const frame = await start({ getStatus: () => READY });
    await frame.choose("cal-target-availability");
    expect(frame.byId("cal-access-read")).toBeNull();
    expect(await collected(frame)).toEqual({ kind: "availability" });
  });

  it("opens a colleague's calendars only once the gatekeeper has, and limits their permission to what the grant allows", async () => {
    const frame = await start({ getStatus: () => READY, listCalendars: () => CALENDARS });
    await frame.choose("cal-target-calendar");
    await frame.choose("cal-owner-colleague");
    expect(frame.byId("cal-calendars")).toBeNull();
    await frame.type("#cal-colleague-input", "sarah");
    await frame.click("Open");
    expect(frame.byId("cal-colleague-error")!.textContent).toBe(`"sarah" isn't an email address. Enter one like sarah@contoso.com.`);
    expect(frame.waiting("openColleague")).toHaveLength(0);
    await frame.type("#cal-colleague-input", "phillip@contoso.com");
    await frame.press("Enter");
    expect(frame.byId("cal-colleague-error")!.textContent).toBe("That's you. Choose Yours above instead.");

    await frame.type("#cal-colleague-input", "Sarah@Contoso.com");
    await frame.press("Enter");
    expect(frame.text()).toContain("Opening…");
    frame.waiting("openColleague")[0]!.reject("Sarah James hasn't shared a calendar with you.");
    await settle();
    expect(frame.byId("cal-colleague-error")!.textContent).toBe("Sarah James hasn't shared a calendar with you.");

    await frame.click("Open");
    expect(frame.waiting("openColleague")[0]!.args).toEqual(["sarah@contoso.com"]);
    frame.waiting("openColleague")[0]!.resolve({
      address: "sarah@contoso.com", name: "Sarah James",
      calendars: [{ id: "AAMkCalendarSarah002", name: "Projects", isDefault: false, canEdit: true }],
    });
    await settle();
    expect(frame.text()).toContain("Sarah Jamessarah@contoso.com");
    // Her only calendar is chosen for the user.
    expect(checked(frame, "cal-calendar-AAMkCalendarSarah002")).toBe(true);
    expect(frame.byId("cal-access-edit")!.disabled).toBe(true);
    expect(frame.text()).toContain(`For colleagues' calendars, this connection allows up to "Read only".`);
    expect(await collected(frame)).toEqual({ kind: "calendar", owner: "sarah@contoso.com", calendarId: "AAMkCalendarSarah002", details: "full", privateEvents: "busy", access: "read" });

    await frame.click("Change");
    expect((frame.byId("cal-colleague-input") as FrameElement).value).toBe("sarah@contoso.com");
    expect(frame.state.ready).toBe(false);
  });

  it("offers no colleague's calendar when the grant can't open one, and says what would", async () => {
    const frame = await start({ getStatus: () => ({ ...READY, sharedLevels: [] }), listCalendars: () => CALENDARS });
    await frame.choose("cal-target-calendar");
    expect(frame.byId("cal-owner-mine")).toBeNull();
    expect(frame.byId("cal-owner-colleague")).toBeNull();
    expect(frame.all("#cal-calendars .cal-row")).toHaveLength(3);
    expect(frame.text()).toContain("Calendars others share with you open through your own account, once an admin approves more Microsoft 365 permissions and you reconnect.");
  });

  it("names the deployment when it, not the grant, caps the permission", async () => {
    const frame = await start({ getStatus: () => ({ ...READY, levels: ["read", "edit"], sharedLevels: [], limitedByDeployment: true }) });
    expect(frame.byId("cal-access-schedule")!.disabled).toBe(true);
    expect(frame.text()).toContain(`Your organization allows up to "Add and change".`);
    const grant = await start({ getStatus: () => ({ ...READY, levels: ["read"], sharedLevels: [] }) });
    expect(grant.text()).toContain(`This connection allows up to "Read only". Reconnect Microsoft 365 to allow more.`);
  });

  it("asks for calendar access from the click, then reads the status again", async () => {
    let status: CalendarConfiguratorStatus = { state: "needsAccess" };
    const frame = await start({ getStatus: () => status });
    expect(frame.text()).toContain("hasn't been allowed to open calendars yet");
    expect(frame.state.ready).toBe(false);
    status = READY;
    await frame.click("Allow access");
    expect(frame.state.ensured).toEqual([[PATTERN]]);
    expect(frame.text()).toContain("What to connect");
  });

  it("says when there's no calendar at all", async () => {
    const frame = await start({ getStatus: () => ({ state: "unavailable", message: "This Microsoft 365 account has no Outlook calendar." }) });
    expect(frame.$('[role="alert"]')?.textContent ?? frame.text()).toContain("no Outlook calendar");
    expect(frame.byId("cal-target-all")).toBeNull();
  });

  it("collects the resource URL the gatekeeper writes", async () => {
    const frame = await start({ getStatus: () => READY });
    await frame.choose("cal-access-edit");
    const url = frame.collect();
    await settle();
    const [resolving] = frame.waiting("resourceUrlFor");
    expect(resolving!.args).toEqual([{ kind: "all", access: "edit" }]);
    resolving!.resolve("https://outlook.office.com/calendar/?access=edit");
    await expect(url).resolves.toBe("https://outlook.office.com/calendar/?access=edit");
  });

  it("opens a binding being edited as it was: a calendar at its permission", async () => {
    const url = "https://outlook.office.com/calendar/id/AAMkCalendarTeam0002?details=full&private=show&access=edit";
    const frame = await start({
      getStatus: () => READY, listCalendars: () => CALENDARS,
      locate: () => ({ kind: "calendar", calendar: CALENDARS[1], details: "full", privateEvents: "show", access: "edit" }),
    }, url);
    // "More options" opens itself to show what the binding changed from the defaults.
    expect(frame.byId("cal-more")!.getAttribute("aria-expanded")).toBe("true");
    for (const id of ["cal-target-calendar", "cal-owner-mine", "cal-calendar-AAMkCalendarTeam0002", "cal-details-full", "cal-private", "cal-access-edit"]) {
      expect(checked(frame, id), id).toBe(true);
    }
  });

  it("opens free/busy of the main calendar as the user's free time, and a colleague's calendar under them", async () => {
    const freeTime = await start({
      getStatus: () => READY,
      locate: () => ({ kind: "calendar", calendar: CALENDARS[0], details: "freeBusy", privateEvents: "busy", access: "read" }),
    }, "https://outlook.office.com/calendar/id/AAMkCalendarMain0001?details=freeBusy&access=read");
    expect(checked(freeTime, "cal-target-freeTime")).toBe(true);

    const theirs = await start({
      getStatus: () => READY,
      openColleague: () => ({ address: "sarah@contoso.com", name: "Sarah James", calendars: [{ id: "AAMkCalendarSarah002", name: "Projects", isDefault: false, canEdit: true }] }),
      locate: () => ({
        kind: "calendar", owner: { address: "sarah@contoso.com", name: "Sarah James" },
        calendar: { id: "AAMkCalendarSarah002", name: "Projects", isDefault: false, canEdit: true }, details: "limited", privateEvents: "busy", access: "read",
      }),
    }, "https://outlook.office.com/calendar/sarah%40contoso.com/id/AAMkCalendarSarah002?details=limited&access=read");
    for (const id of ["cal-target-calendar", "cal-owner-colleague", "cal-calendar-AAMkCalendarSarah002", "cal-details-limited"]) {
      expect(checked(theirs, id), id).toBe(true);
    }
    expect(theirs.text()).toContain("Sarah Jamessarah@contoso.com");
    expect(theirs.calls.filter(call => call.method === "openColleague").map(call => call.args)).toEqual([["sarah@contoso.com"]]);
  });

  it("says what failed and retries just that", async () => {
    let fail = true;
    const frame = await start({
      getStatus: () => READY,
      listCalendars: () => {
        if (fail) throw new Error("Outlook didn't answer. Try again in a moment.");
        return CALENDARS;
      },
    });
    await frame.choose("cal-target-calendar");
    expect(frame.$('[role="alert"]')!.textContent).toBe("Outlook didn't answer. Try again in a moment.");
    fail = false;
    await frame.click("Try again");
    expect(frame.all("#cal-calendars .cal-row")).toHaveLength(3);
  });
});
