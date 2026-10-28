// The Confluence configurator frame as the Workshop hosts it, in Chromium: the journeys a user takes
// through its picker, with the gatekeeper capability faked from ./fixtures. Needs the generated
// frame (`build:configurator`, which `test:run` runs first).

import { describe, expect, it, vi } from "vitest";
import type { ConfluenceBrowseRequest, ConfluenceNode } from "../src/configurator/confluence-configurator-types";
import { browse, ENGINEERING, MFS, READY, SITE_REF, SPACES, spaceAvatars, STARRED } from "./fixtures";
import { PATTERNS, startFrame, useFrameHost, type Answer } from "./frame-host";

useFrameHost();

/** 25 spaces from `from` on: one page of a long list. */
const many = (from: number): ConfluenceNode[] => Array.from({ length: 25 }, (_, index) => ({
  ref: `space:5c121664-a643-497d-99b3-25e02a81f02f/S${from + index}`, kind: "space", title: `Space ${from + index}`,
  expandable: true, selectable: true,
}));

/** The frame re-renders a moment after each reply or key, so every reading of it is polled. */
const poll = <T>(read: () => Promise<T>, timeout = 5_000) => expect.poll(read, { timeout });

async function start(options: { answers?: Record<string, Answer>; initialResource?: string; patterns?: string[] } = {}) {
  const hosted = await startFrame({
    ...options,
    answers: { getStatus: () => READY, loadItems: browse, locate: () => null, spaceAvatars, ...options.answers },
  });
  const frame = hosted.frame;
  const radio = (name: string) => frame().getByRole("radio", { name, exact: true });
  const picker = {
    ...hosted,
    radio,
    /** The listing's rows by name, in order. */
    rows: () => frame().locator("#cf-list [role=radio]").evaluateAll(nodes => nodes.map(node => node.getAttribute("aria-label"))),
    /** The breadcrumb, or the search's scope, as shown. */
    location: async () => (await frame().locator(".browser-location").innerText()).replace(/\s+/g, " ").trim(),
    summary: async () => (await frame().locator(".browser-summary").innerText()).replace(/\s+/g, " ").trim(),
    focused: () => frame().evaluate(() => document.activeElement?.getAttribute("data-cf-focus") ?? document.activeElement?.tagName),
    requests: () => hosted.callsOf("loadItems").map(call => call.args[0] as ConfluenceBrowseRequest),
  };
  return picker;
}

describe("the start page", () => {
  it("shows recent pages and every space, leaving out a Starred section that repeats them", async () => {
    const picker = await start({ answers: { loadItems: (request: ConfluenceBrowseRequest) => request.section === "starred" ? SPACES : browse(request) } });
    await poll(picker.rows).toEqual([
      "Architecture", "Q4 planning", "Shipping the new editor",
      "My first space", "Team Handbook", "Phillip Jones",
    ]);
    expect(await picker.frame().locator(".browser-section").allInnerTexts()).toEqual(["Recent", "Spaces"]);
    // Space icons are asked for once the rows show, and drawn when they arrive; a space without one keeps its glyph.
    await poll(() => picker.radio("My first space").locator(".browser-avatar img").count()).toBe(1);
    expect(await picker.radio("Phillip Jones").locator(".browser-avatar").count()).toBe(0);
    expect(picker.callsOf("spaceAvatars").map(call => call.args[0])).toEqual([[MFS.ref, "space:5c121664-a643-497d-99b3-25e02a81f02f/TH", "space:5c121664-a643-497d-99b3-25e02a81f02f/~7120206f"]]);
    // Recent pages say where they live.
    await expect.poll(() => picker.radio("Architecture").getAttribute("aria-description")).toContain("In My first space › Engineering");
  });

  it("shows starred spaces when they are a few of many", async () => {
    const picker = await start();
    await poll(() => picker.frame().locator(".browser-section").allInnerTexts()).toEqual(["Recent", "Starred", "Spaces"]);
    expect(STARRED.items).toHaveLength(1);
  });

  it("chooses a recent page that has no child pages, and opens one that has, where it lives", async () => {
    const picker = await start();
    await picker.radio("Q4 planning").click();
    await poll(picker.summary).toContain("Q4 planning: this page and the pages under it");
    expect(await picker.radio("Q4 planning").locator(".browser-chevron").count()).toBe(0);
    expect(await picker.location()).toBe("Slew");

    await picker.radio("Architecture").click();
    // What was chosen elsewhere is offered in place of the count.
    await poll(picker.location).toBe("Slew › My first space › Engineering › Architecture Chosen: Q4 planning Show");
    expect(await picker.rows()).toEqual(["All of Architecture", "Storage architecture", "Networking"]);
  });

  it("binds the whole site from the row above everything", async () => {
    const picker = await start();
    await picker.radio("All of Slew").click();
    await poll(picker.summary).toContain("All of Slew: every space, page and blog post you can open on Slew");
    await poll(async () => (await picker.state()).ready).toBe(true);
    expect(await picker.collected()).toBe(SITE_REF);
  });

  it("offers to try again when the spaces can't be listed", async () => {
    let failing = true;
    const picker = await start({
      answers: {
        loadItems: (request: ConfluenceBrowseRequest) => {
          if (request.section === "spaces" && failing) throw new Error("Confluence is down.");
          return browse(request);
        },
      },
    });
    await poll(picker.text).toContain("Confluence is down.");
    failing = false;
    await picker.frame().getByRole("button", { name: "Try again" }).click();
    await poll(picker.rows).toContain("Team Handbook");
  });
});

describe("browsing", () => {
  it("opens a space at its home page, blog and pages, and chooses it or a page in it", async () => {
    const picker = await start();
    await picker.radio("My first space").last().click();
    await poll(picker.location).toBe("Slew › My first space 8 items");
    expect(await picker.rows()).toEqual([
      "All of My first space", "My first space", "Blog", "Engineering", "Onboarding", "Q4 planning",
      "Retro board", "Launch tracker", "Archive",
    ]);

    await picker.radio("All of My first space").click();
    await poll(picker.summary).toContain("My first space: its pages and blog posts, including new ones.");
    expect(await picker.collected()).toBe(MFS.ref);

    // A row that opens is chosen by its radio, without opening it.
    await picker.radio("Engineering").locator(".browser-radio-hit").click();
    await poll(picker.summary).toContain("Engineering: this page and the pages under it");
    expect(await picker.location()).toBe("Slew › My first space 8 items");
    expect(await picker.collected()).toBe("page:5c121664-a643-497d-99b3-25e02a81f02f/458753");
  });

  it("never chooses what can't be connected, and says why", async () => {
    const picker = await start();
    await picker.radio("My first space").last().click();
    await picker.radio("Retro board").click({ force: true });
    await poll(() => picker.frame().locator("#cf-announcer").innerText()).toContain("Can't choose Retro board. Can't be connected yet.");
    expect((await picker.state()).ready).not.toBe(true);

    await picker.radio("Blog").click({ force: true });
    await poll(picker.rows).toEqual(["Shipping the new editor", "Welcome to the team blog"]);
    expect(await picker.text()).toContain("Choose one post, or the whole space.");
  });

  it("goes back by breadcrumb, landing on the place it left", async () => {
    const picker = await start();
    await picker.radio("My first space").last().click();
    await picker.radio("Engineering").click();
    await poll(picker.location).toBe("Slew › My first space › Engineering 3 items");
    await picker.radio("On-call runbook").focus();
    await picker.page.keyboard.press("ArrowLeft");
    await poll(picker.location).toBe("Slew › My first space 8 items");
    await poll(picker.focused).toBe("row:in:page:5c121664-a643-497d-99b3-25e02a81f02f/458753");
    await picker.frame().getByRole("button", { name: "Slew", exact: true }).click();
    await poll(picker.rows).toContain("Team Handbook");
  });

  it("moves through rows with the keyboard, opening with Right Arrow", async () => {
    const picker = await start();
    await poll(picker.rows).toContain("Team Handbook");
    await picker.frame().locator(".browser-search-input").focus();
    await picker.page.keyboard.press("ArrowDown");
    await poll(picker.focused).toBe("row:recent:page:5c121664-a643-497d-99b3-25e02a81f02f/491521");
    // Typing a title's start jumps to it.
    await picker.page.keyboard.type("team");
    await poll(picker.focused).toBe("row:spaces:space:5c121664-a643-497d-99b3-25e02a81f02f/TH");
    await picker.page.keyboard.press("ArrowUp");
    await picker.page.keyboard.press("ArrowRight");
    await poll(picker.location).toBe("Slew › My first space 8 items");
    await poll(picker.focused).toBe("place:space:5c121664-a643-497d-99b3-25e02a81f02f/MFS");
    await picker.page.keyboard.press(" ");
    await poll(picker.summary).toContain("My first space:");
  });

  it("pages through a long list of spaces", async () => {
    const picker = await start({
      answers: {
        loadItems: (request: ConfluenceBrowseRequest) => request.section === "spaces"
          ? request.cursor ? { items: many(25) } : { items: many(0), nextCursor: "next" }
          : { items: [] },
      },
    });
    await poll(async () => (await picker.rows()).length).toBe(25);
    // Scrolling to the end loads the next page, as the "Show more" button there does.
    await picker.frame().locator("#cf-list").evaluate(list => { list.scrollTop = list.scrollHeight; });
    await poll(async () => (await picker.rows()).length).toBe(50);
    expect(await picker.frame().getByRole("button", { name: "Show more" }).count()).toBe(0);
    expect(picker.requests().filter(request => request.section === "spaces").at(-1)).toMatchObject({ cursor: "next" });
  });
});

describe("search", () => {
  it("finds pages across the site, and shows a chosen result where it lives", async () => {
    const picker = await start();
    await picker.frame().locator(".browser-search-input").fill("arch");
    await poll(picker.rows).toEqual(["Architecture", "Storage architecture"]);
    expect(await picker.location()).toBe("Results in Slew 2 results");
    expect(await picker.radio("Storage architecture").locator("mark").innerText()).toBe("arch");

    await picker.radio("Storage architecture").click();
    await poll(picker.summary).toContain("Storage architecture: this page and the pages under it");
    await picker.frame().locator(".browser-search-clear").click();
    await poll(picker.text).toContain("Chosen: Storage architecture");
    await picker.frame().getByRole("button", { name: "Show Storage architecture" }).click();
    await poll(picker.location).toBe("Slew › My first space › Engineering › Architecture 2 items");
    expect(await picker.radio("Storage architecture").getAttribute("aria-checked")).toBe("true");
    expect(picker.requests().at(-1)).toEqual({ parent: "page:5c121664-a643-497d-99b3-25e02a81f02f/491521" });
  });

  it("says when nothing matched", async () => {
    const picker = await start({ answers: { loadItems: (request: ConfluenceBrowseRequest) => request.query ? { items: [] } : browse(request) } });
    await picker.frame().locator(".browser-search-input").fill("zebra");
    await poll(picker.text).toContain("No results for “zebra”");
  });
});

describe("a resource URL that came with the frame", () => {
  it("opens where the bound page lives, with it chosen", async () => {
    const located: ConfluenceNode = {
      ...ENGINEERING.items[1]!, path: [{ ref: MFS.ref, title: MFS.title, kind: "space" }, { ref: "page:5c121664-a643-497d-99b3-25e02a81f02f/458753", title: "Engineering", kind: "page" }],
    };
    const picker = await start({
      initialResource: "https://slew.atlassian.net/wiki/spaces/MFS/pages/327884",
      answers: { locate: () => located },
    });
    await poll(picker.location).toBe("Slew › My first space › Engineering 3 items");
    await poll(() => picker.radio("On-call runbook").getAttribute("aria-checked")).toBe("true");
    await poll(async () => (await picker.state()).ready).toBe(true);
  });

  it("chooses nothing when the connection can't open it, rather than the whole site", async () => {
    const picker = await start({ initialResource: "https://slew.atlassian.net/wiki/spaces/GONE" });
    await poll(picker.text).toContain("Couldn't find https://slew.atlassian.net/wiki/spaces/GONE");
    expect(await picker.radio("All of Slew").getAttribute("aria-checked")).toBe("false");
    expect((await picker.state()).ready).not.toBe(true);
  });

  it("tells a failed lookup from a missing page, and tries again on request", async () => {
    const located: ConfluenceNode = { ...ENGINEERING.items[1]!, path: [{ ref: MFS.ref, title: MFS.title, kind: "space" }, { ref: "page:5c121664-a643-497d-99b3-25e02a81f02f/458753", title: "Engineering", kind: "page" }] };
    let failing = true;
    const picker = await start({
      initialResource: "https://slew.atlassian.net/wiki/spaces/MFS/pages/327884",
      answers: { locate: () => { if (failing) throw new Error("Confluence is down."); return located; } },
    });
    await poll(picker.text).toContain("Couldn't look up https://slew.atlassian.net/wiki/spaces/MFS/pages/327884. Confluence is down.");
    expect((await picker.state()).ready).not.toBe(true);
    failing = false;
    await picker.frame().getByRole("button", { name: "Try again" }).click();
    await poll(picker.location).toBe("Slew › My first space › Engineering 3 items");
    await poll(() => picker.radio("On-call runbook").getAttribute("aria-checked")).toBe("true");
    await poll(async () => (await picker.state()).ready).toBe(true);
  });
});

describe("a binding that takes only pages", () => {
  it("hides the whole site and lets spaces be opened but not chosen", async () => {
    const picker = await start({ patterns: [PATTERNS.page] });
    await poll(picker.rows).toContain("Team Handbook");
    expect(await picker.frame().getByRole("radio", { name: "All of Slew" }).count()).toBe(0);
    expect(await picker.radio("Team Handbook").getAttribute("aria-disabled")).toBe("true");
    await picker.radio("My first space").last().click({ force: true });
    await poll(picker.text).toContain("This connection needs a page or blog post.");
    await picker.radio("Engineering").locator(".browser-radio-hit").click();
    await poll(async () => (await picker.state()).ready).toBe(true);
  });
});

describe("the frame", () => {
  it("logs nothing to the console on a whole journey", async () => {
    const picker = await start();
    await picker.radio("My first space").last().click();
    await picker.radio("Engineering").click();
    await picker.frame().locator(".browser-search-input").fill("arch");
    await poll(picker.rows).toContain("Storage architecture");
    await vi.waitFor(() => expect(picker.consoleErrors).toEqual([]));
  });
});
