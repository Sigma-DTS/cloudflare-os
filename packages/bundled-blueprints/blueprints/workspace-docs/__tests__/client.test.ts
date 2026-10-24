// The editor's handling of HTML it did not write: blocks from the server (a collaborator's or an
// agent's) reach the DOM only through the editor's scrubbing. client.ts is a gadget entry with
// top-level effects, so it is loaded once against a fake `gadget` stub and driven through it.
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { DocumentEvent, GadgetStub, SubscribeSnapshot, SubscriberCallbacks } from "../files/lib/protocol.ts";

const HOSTILE = '<p id="addEventListener" name="createElement">Hi<img name="getElementById" src="data:image/png;base64,AA" data-reencode="" onerror="alert(1)"><noscript>&lt;img src=x onerror=alert(1)&gt;</noscript><template><b>t</b></template></p>';

let subscriber: SubscriberCallbacks;
const editor = () => document.querySelector<HTMLElement>(".editor")!;

beforeAll(async () => {
  Object.assign(globalThis, {
    matchMedia: (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }),
    RpcTarget: class {},
  });
  const snapshot: SubscribeSnapshot = {
    revision: 1, title: "Doc", lastModified: 0, settings: { font: "sans", wide: false },
    blocks: [{ id: "b1", html: HOSTILE, version: 1 }],
  };
  const gadget: Partial<GadgetStub> = {
    subscribe: vi.fn(async (callbacks: SubscriberCallbacks) => { subscriber = callbacks; return snapshot; }),
    getSettings: vi.fn(async () => snapshot.settings),
    applyOperation: vi.fn(async () => ({ status: "applied" as const, revision: 2, conflicts: [] })),
  };
  Object.assign(globalThis, { gadget });
  // Not a literal specifier, so this Node-typed program does not type-check the entry under Node's
  // timer types; tsconfig.client.json checks it under the DOM's.
  const entry = "../files/client.ts";
  await import(/* @vite-ignore */ entry);
});

function expectScrubbed(block: Element | null) {
  expect(block).not.toBeNull();
  for (const node of [block!, ...block!.querySelectorAll("*")]) {
    expect(node.hasAttribute("id")).toBe(false);
    expect(node.hasAttribute("name")).toBe(false);
    expect(node.hasAttribute("onerror")).toBe(false);
    expect(node.hasAttribute("data-reencode")).toBe(false);
  }
  expect(block!.querySelector("noscript, template")).toBeNull();
}

describe("blocks from the server", () => {
  it("strip naming attributes, handlers, the re-encode mark, <noscript> and <template> from a loaded block", () => {
    const block = editor().querySelector('[data-block-id="b1"]');
    expectScrubbed(block);
    expect(block!.textContent).toBe("Hi");
    expect(block!.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,AA");
  });

  it("strip the same from a block a live operation brings in", () => {
    const event: DocumentEvent = {
      type: "operation", senderId: "someone", revision: 2, title: "Doc", lastModified: 0,
      upserts: [{ id: "b2", html: HOSTILE.replace("Hi", "Live"), version: 1 }], deletedIds: [], order: ["b1", "b2"],
    };
    subscriber.operation(event);
    const block = editor().querySelector('[data-block-id="b2"]');
    expectScrubbed(block);
    expect(block!.textContent).toBe("Live");
  });
});

describe("saving", () => {
  // A block deleted here while its save was in flight, and changed by someone else meanwhile,
  // comes back from the conflict where the server has it, not at the end of the document.
  it("puts a block a stale conflict brings back in its place", async () => {
    subscriber.operation({
      type: "operation", senderId: "someone", revision: 3, title: "Doc", lastModified: 0,
      upserts: [{ id: "b3", html: "<p>three</p>", version: 1 }], deletedIds: [], order: ["b1", "b2", "b3"],
    });
    const applyOperation = vi.mocked((globalThis as unknown as { gadget: GadgetStub }).gadget.applyOperation);
    applyOperation.mockImplementationOnce(async () => {
      editor().querySelector('[data-block-id="b2"]')!.remove();
      return { status: "conflict", revision: 4, conflicts: [{ id: "b2", html: "<p>theirs</p>", version: 2 }] };
    });
    editor().querySelector('[data-block-id="b2"]')!.textContent = "mine";
    window.dispatchEvent(new Event("pagehide"));
    await vi.waitFor(() => expect(applyOperation).toHaveBeenCalled());
    await vi.waitFor(() => expect(editor().querySelector('[data-block-id="b2"]')?.textContent).toBe("theirs"));
    expect(Array.from(editor().children, (n) => n.getAttribute("data-block-id"))).toEqual(["b1", "b2", "b3"]);
  });
});

describe("editing", () => {
  let revision = 10;
  const show = (id: string, html: string) => {
    const order = [...Array.from(editor().children, (n) => n.getAttribute("data-block-id")!), id];
    subscriber.operation({ type: "operation", senderId: "someone", revision: ++revision, title: "Doc", lastModified: 0, upserts: [{ id, html, version: 1 }], deletedIds: [], order });
    return editor().querySelector<HTMLElement>(`[data-block-id="${id}"]`)!;
  };
  // The editor acts on the selection only while it has focus.
  const select = (node: Node, start: number, end = start) => {
    if (editor().tabIndex < 0) editor().tabIndex = 0;
    editor().focus();
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, end);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
  };
  const press = (init: KeyboardEventInit) => editor().dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, metaKey: true, ctrlKey: true, ...init }));

  it("clears formatting from the selected words only", () => {
    const block = show("f1", '<p><span class="tc-red">one two three</span></p>');
    select(block.querySelector("span")!.firstChild!, 4, 7);
    press({ key: "\\", code: "Backslash" });
    expect(block.innerHTML).toBe('<span class="tc-red">one </span>two<span class="tc-red"> three</span>');
    expect(getSelection()!.toString()).toBe("two");
  });

  it("undoes ticking a to-do item", () => {
    const block = show("t1", '<ul class="checklist"><li>Task</li></ul>');
    const li = block.querySelector("li")!;
    select(li.firstChild!, 2);
    press({ key: "Enter" });
    expect(li.getAttribute("data-checked")).toBe("true");
    press({ key: "z" });
    expect(li.hasAttribute("data-checked")).toBe(false);
    press({ key: "z", shiftKey: true });
    expect(li.getAttribute("data-checked")).toBe("true");
  });
});

describe("a save in flight", () => {
  // The agent's version can already include this page's save while the reply is still on its
  // way: it must not be merged against the version before the save, or the saved words repeat.
  it("applies a newer remote version against the save it includes", async () => {
    subscriber.operation({ type: "operation", senderId: "someone", revision: 20, title: "Doc", lastModified: 0, upserts: [{ id: "r1", html: "<p>foo</p>", version: 1 }], deletedIds: [], order: [...Array.from(editor().children, (n) => n.getAttribute("data-block-id")!), "r1"] });
    const block = editor().querySelector('[data-block-id="r1"]')!;
    const applyOperation = vi.mocked((globalThis as unknown as { gadget: GadgetStub }).gadget.applyOperation);
    let reply!: () => void;
    applyOperation.mockImplementationOnce(() => new Promise((resolve) => {
      reply = () => resolve({ status: "applied", revision: 21, conflicts: [], upserts: [{ id: "r1", html: "<p>foo A</p>", version: 2 }] });
    }));
    block.textContent = "foo A";
    window.dispatchEvent(new Event("pagehide"));
    await vi.waitFor(() => expect(reply).toBeDefined());
    subscriber.operation({ type: "operation", senderId: "agent", revision: 22, title: "Doc", lastModified: 0, upserts: [{ id: "r1", html: "<p>bar A</p>", version: 3 }], deletedIds: [], order: Array.from(editor().children, (n) => n.getAttribute("data-block-id")!) });
    reply();
    await vi.waitFor(() => expect(editor().querySelector('[data-block-id="r1"]')?.textContent).toBe("bar A"));
  });
});

describe("menus", () => {
  it("are driven from the keyboard", () => {
    const align = document.querySelector<HTMLButtonElement>(".tb.align")!;
    align.focus();
    align.click();
    const rows = () => Array.from(document.querySelectorAll<HTMLElement>('.pop [role="menuitemradio"]'));
    expect(rows()).toHaveLength(4);
    const key = (key: string) => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    key("ArrowDown");
    expect(document.activeElement).toBe(rows()[0]);
    key("ArrowUp");
    expect(document.activeElement).toBe(rows()[3]);
    const picked = vi.fn();
    rows()[3].addEventListener("click", picked);
    key("Enter");
    expect(picked).toHaveBeenCalled();
  });
});

describe("block order", () => {
  // A save's reply confirms the order as of its revision; a live event from a later revision that
  // arrived first must keep its order, or a later move of the new block is never saved.
  it("keeps a newer event's order over an older save reply", async () => {
    const ids = () => Array.from(editor().children, (n) => n.getAttribute("data-block-id")!);
    const applyOperation = vi.mocked((globalThis as unknown as { gadget: GadgetStub }).gadget.applyOperation);
    let reply!: () => void;
    applyOperation.mockImplementationOnce((op) => new Promise((resolve) => {
      const upserts = (op.upserts ?? []).map((b) => ({ id: b.id, html: b.html, version: b.baseVersion + 1 }));
      reply = () => resolve({ status: "applied", revision: 30, conflicts: [], upserts, order: op.order });
    }));
    editor().firstElementChild!.append(" edited");
    window.dispatchEvent(new Event("pagehide"));
    await vi.waitFor(() => expect(reply).toBeDefined());
    subscriber.operation({ type: "operation", senderId: "someone", revision: 31, title: "Doc", lastModified: 0, upserts: [{ id: "o1", html: "<p>new</p>", version: 1 }], deletedIds: [], order: [...ids(), "o1"] });
    reply();
    await vi.waitFor(() => expect(applyOperation.mock.results.at(-1)?.type).toBe("return"));
    await Promise.resolve();
    const moved = editor().querySelector('[data-block-id="o1"]')!;
    editor().prepend(moved);
    applyOperation.mockClear();
    window.dispatchEvent(new Event("pagehide"));
    await vi.waitFor(() => expect(applyOperation).toHaveBeenCalled());
    expect(applyOperation.mock.calls[0]![0].order?.[0]).toBe("o1");
  });
});
