import { RpcStub, RpcTarget } from "capnweb";
import { afterAll, describe, expect, it } from "vitest";
import { closeViewBrowser, RenderedView, type ViewBinder } from "./view-host.js";

class Expenses extends RpcTarget {
  readonly added: unknown[] = [];

  totals() {
    return { food: 420, since: new Date(0) };
  }

  add(entry: unknown) {
    this.added.push(entry);
    return { ok: true };
  }
}

function binder(expenses = new Expenses()): ViewBinder {
  return async name => {
    if (name !== "EXPENSES") throw new Error(`No binding named ${name}`);
    const rpc = new RpcStub(expenses);
    return { type: "gadget", rpc, [Symbol.dispose]: () => rpc[Symbol.dispose]() };
  };
}

afterAll(() => closeViewBrowser());

describe("RenderedView", { timeout: 60_000 }, () => {
  it("runs a view against its bindings and records what it asks to send", async () => {
    await using view = await RenderedView.open(`
      <p id="total">Loading</p>
      <button id="ask">Ask</button>
      <script type="module">
        const { food, since } = await env.EXPENSES.rpc.totals();
        document.getElementById("total").textContent = "Food " + food + " " + (since instanceof Date);
        document.getElementById("ask").onclick = () => agent.send("Show me food");
      </script>`, binder());
    expect(await view.text()).toContain("Food 420 true");
    expect(view.calls).toEqual([{ call: "EXPENSES.rpc.totals", args: "[]" }]);
    await view.click("Ask", []);
    expect(view.messages).toEqual(["Show me food"]);
    expect(view.unsettled).toBeUndefined();
  });

  it("records errors, blocked requests and markup parsed from strings, which throws", async () => {
    await using view = await RenderedView.open(`
      <div id="out"></div>
      <img src="https://example.com/chart.png">
      <script type="module">
        fetch("https://example.com/api").catch(() => {});
        new WebSocket("wss://example.com/socket");
        Promise.reject(new Error("rejected"));
        const out = document.getElementById("out");
        out.innerHTML = "";
        out.innerHTML = "<b>Food</b>";
      </script>`, binder());
    await expect.poll(() => view.requests.toSorted()).toEqual([
      "https://example.com/api", "https://example.com/chart.png", "wss://example.com/socket",
    ]);
    await expect.poll(() => view.errors.toSorted())
        .toEqual([expect.stringMatching(/requires 'TrustedHTML'/), "rejected"]);
    expect(view.markup).toEqual(["innerHTML: <b>Food</b>"]);
  });

  it("clicks a chart bar through its label, once", async () => {
    await using view = await RenderedView.open(`
      <svg width="300" height="140">
        <rect id="food" x="0" y="0" width="100" height="100" />
        <rect id="travel" x="150" y="0" width="100" height="100" />
        <text x="30" y="125">Food</text>
        <text x="180" y="125">Travel</text>
      </svg>
      <script type="module">
        for (const id of ["food", "travel"]) {
          document.getElementById(id).addEventListener("click", () => agent.send("About " + id));
        }
      </script>`, binder());
    await view.click("Travel", ["Food"]);
    expect(view.messages).toEqual(["About travel"]);
  });

  it("ticks the checkbox in an item's row and stops at the first call", async () => {
    const expenses = new Expenses();
    await using view = await RenderedView.open(`
      <ul>
        <li><input type="checkbox" data-title="Dune"> <span>Dune</span></li>
        <li><input type="checkbox" data-title="Piranesi"> <span>Piranesi</span> <button>Remove</button></li>
      </ul>
      <script type="module">
        for (const box of document.querySelectorAll("input")) {
          box.addEventListener("change", () => env.EXPENSES.rpc.add({ title: box.dataset.title }));
        }
        document.querySelector("button").addEventListener("click", () => env.EXPENSES.rpc.add({ removed: true }));
      </script>`, binder(expenses));
    await view.click("Piranesi", ["Dune"]);
    expect(expenses.added).toEqual([{ title: "Piranesi" }]);
  });

  it("changes a value through the control holding it, or its stepper", async () => {
    await using input = await RenderedView.open(`
      <label>People <input id="people" type="number" value="4"></label>
      <p id="each"></p>
      <script type="module">
        const people = document.getElementById("people");
        const show = () => {
          document.getElementById("each").textContent = "Each " + (100 / Number(people.value)).toFixed(2);
        };
        people.addEventListener("change", show);
        show();
      </script>`, binder());
    expect(await input.setValue("4", "5", text => text.includes("Each 20.00")))
      .toMatchObject({ pass: true, how: "changed the control holding 4" });

    await using stepper = await RenderedView.open(`
      <span id="people">4</span> <button aria-label="Add a person">+</button>
      <p id="each"></p>
      <script type="module">
        let people = 4;
        const show = () => {
          document.getElementById("people").textContent = people;
          document.getElementById("each").textContent = "Each " + (100 / people).toFixed(2);
        };
        document.querySelector("button").onclick = () => { people++; show(); };
        show();
      </script>`, binder());
    expect(await stepper.setValue("4", "5", text => text.includes("Each 20.00")))
      .toMatchObject({ pass: true, how: "clicked its stepper 1 times" });
  });

  // The views' timers run on the page's fake clock: callsWhenLeftOpen runs a minute of it at once.
  it("counts calls on a timer as polling, and a timer alone as not", async () => {
    const countdown = `<p id="left"></p>
      <script type="module">
        let left = 30;
        setInterval(() => { document.getElementById("left").textContent = left--; }, 1000);
      </script>`;
    await using quiet = await RenderedView.open(countdown, binder());
    expect(await quiet.callsWhenLeftOpen()).toEqual([]);

    await using polling = await RenderedView.open(`${countdown}
      <script type="module">setInterval(() => env.EXPENSES.rpc.totals(), 10_000);</script>`, binder());
    const calls = await polling.callsWhenLeftOpen();
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every(call => call.call === "EXPENSES.rpc.totals")).toBe(true);
  });

  it("refuses calls a view's frame could not make in the Workshop", async () => {
    const expenses = new Expenses();
    await using view = await RenderedView.open(`
      <script type="module">
        await Promise.allSettled([
          env.EXPENSES.rpc.constructor("return process"),
          env.EXPENSES.rpc.dup(),
          env.EXPENSES.totals(),
          env.MISSING.rpc.totals(),
        ]);
      </script>`, binder(expenses));
    expect(view.calls.map(({ call, error }) => ({ call, error }))).toEqual([
      { call: "EXPENSES.rpc.constructor", error: "constructor is not a method of env.EXPENSES" },
      { call: "EXPENSES.rpc.dup", error: "dup is not a method of env.EXPENSES" },
      { call: "EXPENSES.totals", error: "env.EXPENSES is a Gadget: call env.EXPENSES.rpc.totals()" },
      { call: "MISSING.rpc.totals", error: "No binding named MISSING" },
    ]);
  });

  it("lets a view use a capability a binding returns, awaited or pipelined, until it closes", async () => {
    let disposed = 0;
    class Cursor extends RpcTarget {
      next() { return [{ title: "Fix the chart" }]; }
      [Symbol.dispose]() { disposed++; }
    }
    class Issues extends RpcTarget {
      listIssues() { return new Cursor(); }
    }
    const connection: ViewBinder = async () => {
      const session = new RpcStub(new Issues());
      return { type: "connection", session, [Symbol.dispose]: () => session[Symbol.dispose]() };
    };
    const view = await RenderedView.open(`
      <p id="out"></p>
      <script type="module">
        const cursor = await env.GITHUB.listIssues();
        const [awaited] = await cursor.next();
        const [pipelined] = await env.GITHUB.listIssues().next();
        document.getElementById("out").textContent = awaited.title + " / " + pipelined.title;
      </script>`, connection);
    try {
      expect(await view.text()).toContain("Fix the chart / Fix the chart");
      expect(view.calls.map(({ call }) => call)).toEqual([
        "GITHUB.listIssues", "GITHUB.listIssues().next", "GITHUB.listIssues", "GITHUB.listIssues().next",
      ]);
      expect(disposed).toBe(0);
    } finally {
      await view[Symbol.asyncDispose]();
    }
    await expect.poll(() => disposed).toBe(2);
  });
});
