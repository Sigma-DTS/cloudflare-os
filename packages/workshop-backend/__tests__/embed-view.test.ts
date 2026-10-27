import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { AiChatAuthorInfo } from "@gadgets/workshop-shared/api";
import { embeddedViewHtml } from "@gadgets/workshop-shared/embedded-views";
import type { AgentHooks } from "../src/agent.js";
import type { OverseerDurableObject } from "../src/overseer.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

// embedView in executeCode (see plans/embed-view.md): what a run hands back, what it refuses, and
// the HTML a view's frame runs.

const ALICE: AiChatAuthorInfo = { type: "user", id: "alice@example.com", name: "Alice" };
type Runner = Pick<AgentHooks, "executeCodeMode">;

let doCounter = 0;
async function withImpl(fn: (impl: Runner) => Promise<void>): Promise<void> {
  let stub = env.TEST_OVERSEER.getByName(`embed-view-${++doCounter}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    // The object keeps its OverseerImpl, which implements AgentHooks, in a field it does not type.
    const internals = instance as unknown as { impl: Runner };
    await fn(internals.impl);
  });
}

const run = (impl: Runner, body: string) =>
  impl.executeCodeMode(1, `export default async function() {\n${body}\n}`, ALICE, "some-model", {});

describe("embedView", () => {
  it("hands back each view the code showed, with its data as JSON", () => withImpl(async impl => {
    let { log, views } = await run(impl, `
      embedView({ title: "Totals", html: "<p id=t></p>", js: "t.textContent = data.food",
                  data: { food: 420, at: new Date(0) } });
      embedView({ title: "Plain", html: "<p>hi</p>" });
      console.log("done");`);
    expect(log).toBe("done");
    expect(views).toEqual([
      { title: "Totals", html: "<p id=t></p>", js: "t.textContent = data.food",
        data: '{"food":420,"at":"1970-01-01T00:00:00.000Z"}' },
      { title: "Plain", html: "<p>hi</p>" },
    ]);
  }));

  it("throws in the agent's code for a view it refuses, so the model reads why", () => withImpl(async impl => {
    let untitled = await run(impl, `embedView({ html: "<p>hi</p>" });`);
    expect(untitled.log).toContain("TypeError: embedView needs a title");
    expect(untitled.views).toEqual([]);

    let fifth = await run(impl, `for (let i = 0; i < 5; i++) embedView({ title: "View " + i, html: "" });`);
    expect(fifth.log).toContain("RangeError: embedView: a run shows at most 4 views");

    let large = await run(impl, `embedView({ title: "Big", html: "x".repeat(300 * 1024) });`);
    expect(large.log).toContain("RangeError: embedView: a view is at most 256 KiB");
  }));
});

describe("embeddedViewHtml", () => {
  it("writes the data into the view's script so text in it cannot end the script", () => {
    const note = "</script><img src=x onerror=alert(1)><!--";
    const html = embeddedViewHtml({ title: "T", html: "<p></p>", data: JSON.stringify({ note }) });
    const script = html.slice(html.indexOf('<script type="module">'));
    expect(script.indexOf("</script>")).toBe(script.length - "</script>".length);
    expect(html).not.toContain("<img");
    const literal = /JSON\.parse\((".*")\);/.exec(html)?.[1];
    expect(JSON.parse(JSON.parse(literal ?? '""'))).toEqual({ note });
  });
});
