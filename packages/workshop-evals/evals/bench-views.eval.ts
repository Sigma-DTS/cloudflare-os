import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import type { AiChatMessage } from "@gadgets/workshop-shared/api";
import { defineTaskEval } from "../src/eval.js";
import { asEvidence, defineEvalTask, type EvalTurn } from "../src/task.js";
import type { EvalVerifier } from "../src/verifier.js";
import type { RenderedView } from "../src/view-host.js";
import {
  checkAnswersWithView, checkBuildsGadget, checkLastView, checkMakesNoGadget, checkView, mentions,
  showsAmount,
} from "./views.js";

// The view-approach comparison (plans/embed-view.md). The same tasks run on two branches: the
// inline-view branch, where a view is a <gadget-ui> block, and the embedView branch, where code
// shows it. BENCH_ARMS picks the arms ("view", "gadget"), BENCH_LABEL names the view arm, and
// BENCH_SHOTS is where each rendered view's screenshot goes, for the visual check.

const ARMS = new Set((process.env.BENCH_ARMS ?? "view").split(","));
const LABEL = process.env.BENCH_LABEL ?? "view";
const SHOTS = process.env.BENCH_SHOTS ?? ".wrangler/evals/shots";
const VIEW_ASK = "\n\nShow it right here in the chat as a live view; don't build a Gadget.";
const GADGET_ASK = "\n\nBuild it as a Gadget.";

const MONTHS = [
  /\bjan(?:uary)?\b/i, /\bfeb(?:ruary)?\b/i, /\bmar(?:ch)?\b/i, /\bapr(?:il)?\b/i, /\bmay\b/i,
  /\bjune?\b/i, /\bjuly?\b/i, /\baug(?:ust)?\b/i, /\bsep(?:t|tember)?\b/i, /\boct(?:ober)?\b/i,
  /\bnov(?:ember)?\b/i, /\bdec(?:ember)?\b/i,
];
const LIST = [3, 8, 12, 19, 23, 31, 37, 42, 50, 61];
const PLANS = [["Basic", 25], ["Plus", 40], ["Unlimited", 60]] as const;
// $450,000 with 20% down at 6.5% over 30 years.
const PAYMENT = 2275.44;
const TOTALS = { Food: 420, Travel: 185, Books: 96 } as const;

type Visual = { name: string; prompt: string; check: (rendered: RenderedView, verifier: EvalVerifier) => Promise<void> };

const VISUALS: Visual[] = [{
  name: "chart",
  prompt: `Here's my electricity use last year, in kWh: Jan 410, Feb 380, Mar 340, Apr 300, May 290,
Jun 360, Jul 520, Aug 610, Sep 450, Oct 330, Nov 370, Dec 430. Show me how it changed over the year.`,
  check: async (rendered, verifier) => verifier.check("shows-the-data", async () => {
    const shown = await rendered.waitForText(text => MONTHS.every(month => month.test(text)));
    return { pass: shown.pass, evidence: asEvidence({ text: shown.text }) };
  }),
}, {
  name: "mortgage",
  prompt: `Make me a mortgage calculator: home price $450,000, 20% down, 6.5% rate, 30 years.
Let me drag sliders to try other numbers.`,
  check: async (rendered, verifier) => verifier.check("shows-the-data", async () => {
    const shown = await rendered.waitForText(text =>
      showsAmount(text, PAYMENT) || showsAmount(text, 2275) || showsAmount(text, 2276));
    return { pass: shown.pass, evidence: asEvidence({ expected: PAYMENT, text: shown.text }) };
  }),
}, {
  name: "plans",
  prompt: `Compare these phone plans for me: Basic $25/mo with 5 GB, Plus $40/mo with 25 GB, and
Unlimited $60/mo. Paying yearly saves 15%. Let me switch between monthly and yearly prices and pick
one.`,
  check: async (rendered, verifier) => verifier.check("shows-the-data", async () => {
    const shown = await rendered.waitForText(text =>
      PLANS.every(([name, price]) => mentions(text, name) && showsAmount(text, price)));
    return { pass: shown.pass, evidence: asEvidence({ text: shown.text }) };
  }),
}, {
  name: "stepper",
  prompt: `Walk me through how binary search finds 37 in 3, 8, 12, 19, 23, 31, 37, 42, 50, 61, one
step at a time, with Next and Back buttons.`,
  check: async (rendered, verifier) => verifier.check("shows-the-data", async () => {
    const shown = await rendered.waitForText(text =>
      LIST.every(number => new RegExp(`(?<![\\d.])${number}(?![\\d.])`).test(text)));
    return { pass: shown.pass, evidence: asEvidence({ text: shown.text }) };
  }),
}];

/** What the agent did this turn: its steps, tool calls and their errors, what it wrote, and usage. */
async function recordOutput(verifier: EvalVerifier): Promise<void> {
  await verifier.check("output", async () => {
    const agent = verifier.messages.filter((message): message is AiChatMessage & { type: "message" } =>
      message.type === "message" && message.author.type === "agent");
    const calls = agent.flatMap(message => message.toolCalls ?? []);
    return {
      pass: true,
      evidence: asEvidence({
        steps: agent.length,
        tools: calls.map(call => call.toolName),
        toolErrors: calls.flatMap(call => call.error === undefined ? [] : [`${call.toolName}: ${call.error.slice(0, 200)}`]),
        textChars: agent.reduce((sum, message) => sum + message.message.length, 0),
        toolInputChars: calls.reduce((sum, call) => sum + JSON.stringify(call.input).length, 0),
        usage: verifier.chat.usage,
      }),
    };
  });
}

function viewTurn(prompt: string, check: Visual["check"], taskId: string): EvalTurn {
  return {
    prompt: prompt + VIEW_ASK,
    verify: async verifier => {
      await recordOutput(verifier);
      const view = await checkAnswersWithView(verifier);
      await checkMakesNoGadget(verifier);
      if (view === undefined) return;
      await checkView(verifier, view, async rendered => {
        await verifier.check("screenshot", async () => {
          const dir = join(SHOTS, taskId);
          mkdirSync(dir, { recursive: true });
          const path = join(dir, `${randomUUID()}.png`);
          await rendered.screenshot(path);
          return { pass: true, evidence: path };
        });
        await check(rendered, verifier);
      });
    },
  };
}

const OkSchema = z.object({ ok: z.literal(true) });
interface ExpenseApi {
  add(entry: { category: string; amount: number; note: string }): Promise<z.infer<typeof OkSchema>>;
}

if (ARMS.has("view")) {
  for (const visual of VISUALS) {
    const id = `bench-${LABEL}-${visual.name}`;
    defineTaskEval(defineEvalTask({ id, turns: [viewTurn(visual.prompt, visual.check, id)] }));
  }

  // Data from a Gadget, which only code can read: the view's numbers come from the Gadget, not the
  // prompt. Turn 1's metrics are not the view's; the comparison reads turn 2's.
  const id = `bench-${LABEL}-spending`;
  defineTaskEval(defineEvalTask({
    id,
    turns: [{
      prompt: `I want to log what I spend this month and keep adding to it. Name it exactly "Expense
Log" and keep the entries in its own storage, with this server RPC taking and returning plain data:

- add({ category: string, amount: number, note: string }) -> { ok: true }
- totals() -> { byCategory: { [category: string]: number } }, the sum of the amounts in each category`,
      verify: async verifier => {
        await recordOutput(verifier);
        await checkBuildsGadget(verifier);
        await verifier.check("records-expenses", async () => {
          using api = await verifier.connect<ExpenseApi>("Expense Log");
          const added = [];
          for (const [category, amount] of [["Food", 120], ["Travel", 185], ["Food", 300], ["Books", 96]] as const) {
            added.push(OkSchema.safeParse(await api.add({ category, amount, note: "" })).success);
          }
          return { pass: added.every(Boolean), evidence: asEvidence(added) };
        });
      },
    }, viewTurn("Now show me each category's total.", async (rendered, verifier) =>
      verifier.check("shows-the-data", async () => {
        const shown = await rendered.waitForText(text => Object.entries(TOTALS).every(([category, total]) =>
          mentions(text, category) && showsAmount(text, total)));
        return { pass: shown.pass, evidence: asEvidence({ expected: TOTALS, text: shown.text }) };
      }), id)],
  }));
}

if (ARMS.has("gadget")) {
  for (const visual of VISUALS) {
    defineTaskEval(defineEvalTask({
      id: `bench-gadget-${visual.name}`,
      turns: [{
        prompt: visual.prompt + GADGET_ASK,
        verify: async verifier => {
          await recordOutput(verifier);
          await checkBuildsGadget(verifier);
          await checkLastView(verifier, view => checkView(verifier, view));
        },
      }],
    }));
  }
}
