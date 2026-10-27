import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import type { AiChatMessage } from "@gadgets/workshop-shared/api";
import { defineTaskEval } from "../src/eval.js";
import { asEvidence, defineEvalTask, type EvalTurn } from "../src/task.js";
import type { EvalVerifier } from "../src/verifier.js";
import type { RenderedView } from "../src/view-host.js";
import { Seeded } from "./seeded.js";
import { checkAnswersWithView, checkBuildsGadget, checkMakesNoGadget, checkView, mentions, showsAmount } from "./views.js";

// The view-approach comparison (plans/embed-view.md), as a ladder of in-chat views from simple to
// complex, to find where one approach starts to beat the other. The same tasks run on two
// branches: the inline-view branch, where a view is a <gadget-ui> block, and the embedView branch,
// where code shows it. Rungs L1-L5 grow the view (data in the prompt); rungs D1-D2 grow the data
// (read from a Gadget). BENCH_ARMS picks the arms ("view", "gadget"), BENCH_LABEL names the view
// arm, and BENCH_SHOTS is where each view's screenshot goes, for the visual check.

const ARMS = new Set((process.env.BENCH_ARMS ?? "view").split(","));
const LABEL = process.env.BENCH_LABEL ?? "view";
const SHOTS = process.env.BENCH_SHOTS ?? ".wrangler/evals/shots";
const VIEW_ASK = "\n\nShow it right here in the chat as a live view; don't build a Gadget.";
const GADGET_ASK = "\n\nBuild it as a Gadget.";

/** Whether `text` shows `amount`, exactly or rounded to a whole number. */
const showsAbout = (text: string, amount: number) => showsAmount(text, amount) || showsAmount(text, Math.round(amount));
const money = (amount: number) => amount.toFixed(2);

// L4: a month of card transactions.
const MERCHANTS = {
  Groceries: ["Whole Foods", "Trader Joe's", "Safeway"],
  Dining: ["Blue Bottle", "Chipotle", "Nopa"],
  Travel: ["United Airlines", "Lyft", "Marriott"],
  Shopping: ["REI", "Uniqlo", "Target"],
  Utilities: ["PG&E", "Comcast"],
} as const;
type Category = keyof typeof MERCHANTS;
const CATEGORIES: readonly Category[] = ["Groceries", "Dining", "Travel", "Shopping", "Utilities"];
const statementRandom = new Seeded(41);
const STATEMENT = Array.from({ length: 30 }, (_, index) => {
  const category = CATEGORIES[index % CATEGORIES.length] ?? "Groceries";
  return {
    day: index + 1,
    merchant: statementRandom.pick(MERCHANTS[category]),
    category,
    amount: statementRandom.int(800, 32000) / 100,
  };
});
const categoryTotal = (category: Category) =>
  STATEMENT.filter(row => row.category === category).reduce((sum, row) => sum + row.amount, 0);
const STATEMENT_TOTAL = STATEMENT.reduce((sum, row) => sum + row.amount, 0);
// Merchants in exactly one category, so a filtered table can be checked by who it lists.
const travelOnly = [...new Set(STATEMENT.filter(row => row.category === "Travel").map(row => row.merchant))];
const groceryOnly = [...new Set(STATEMENT.filter(row => row.category === "Groceries").map(row => row.merchant))];

// L5: ten weeks of runs.
const runRandom = new Seeded(7);
const RUNS = Array.from({ length: 40 }, (_, index) => {
  const km = runRandom.int(30, 210) / 10;
  const paceSeconds = runRandom.int(285, 400);
  const seconds = Math.round(km * paceSeconds);
  return { day: index * 2 - (index % 3), km, seconds };
});
const clock = (seconds: number) => {
  const h = Math.floor(seconds / 3600), m = Math.floor(seconds % 3600 / 60), s = seconds % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
};
const runDate = (day: number) => new Date(Date.UTC(2026, 6, 6 + day)).toISOString().slice(0, 10);
const TOTAL_KM = RUNS.reduce((sum, run) => sum + run.km, 0);
const LONGEST_KM = Math.max(...RUNS.map(run => run.km));

type Rung = {
  name: string;
  prompt: string;
  check: (rendered: RenderedView, verifier: EvalVerifier) => Promise<void>;
};

const MONTHS = [
  /\bjan(?:uary)?\b/i, /\bfeb(?:ruary)?\b/i, /\bmar(?:ch)?\b/i, /\bapr(?:il)?\b/i, /\bmay\b/i,
  /\bjune?\b/i, /\bjuly?\b/i, /\baug(?:ust)?\b/i, /\bsep(?:t|tember)?\b/i, /\boct(?:ober)?\b/i,
  /\bnov(?:ember)?\b/i, /\bdec(?:ember)?\b/i,
];
const PRS = [["Ana", 7], ["Ben", 4], ["Chen", 9], ["Dee", 2], ["Eli", 5]] as const;
const LIST = [3, 8, 12, 19, 23, 31, 37, 42, 50, 61];
const PLANS = [["Basic", 25], ["Plus", 40], ["Unlimited", 60]] as const;
// $450,000 with 20% down at 6.5% over 30 years.
const PAYMENT = 2275.44;

const RUNGS: Rung[] = [{
  name: "L1-tiny",
  prompt: `Pull requests merged by my team this week: ${PRS.map(([name, count]) => `${name} ${count}`).join(", ")}. Chart it.`,
  check: async (rendered, verifier) => verifier.check("shows-the-data", async () => {
    const shown = await rendered.waitForText(text => PRS.every(([name, count]) => mentions(text, name) && showsAmount(text, count)));
    return { pass: shown.pass, evidence: asEvidence({ text: shown.text }) };
  }),
}, {
  name: "L2-chart",
  prompt: `Here's my electricity use last year, in kWh: Jan 410, Feb 380, Mar 340, Apr 300, May 290,
Jun 360, Jul 520, Aug 610, Sep 450, Oct 330, Nov 370, Dec 430. Show me how it changed over the year.`,
  check: async (rendered, verifier) => verifier.check("shows-the-data", async () => {
    const shown = await rendered.waitForText(text => MONTHS.every(month => month.test(text)));
    return { pass: shown.pass, evidence: asEvidence({ text: shown.text }) };
  }),
}, {
  name: "L2-plans",
  prompt: `Compare these phone plans for me: Basic $25/mo with 5 GB, Plus $40/mo with 25 GB, and
Unlimited $60/mo. Paying yearly saves 15%. Let me switch between monthly and yearly prices and pick
one.`,
  check: async (rendered, verifier) => {
    await verifier.check("shows-the-data", async () => {
      const shown = await rendered.waitForText(text =>
        PLANS.every(([name, price]) => mentions(text, name) && showsAmount(text, price)));
      return { pass: shown.pass, evidence: asEvidence({ text: shown.text }) };
    });
    await verifier.check("switches-to-yearly", async () => {
      // Basic is $255 a year, or $21.25 a month, when paid yearly.
      const chose = await rendered.choose("Yearly", ["Monthly"], text => showsAbout(text, 255) || showsAmount(text, 21.25));
      return { pass: chose.pass, evidence: asEvidence({ tried: chose.tried, text: chose.text }) };
    });
  },
}, {
  name: "L3-mortgage",
  prompt: `Make me a mortgage calculator: home price $450,000, 20% down, 6.5% rate, 30 years.
Let me drag sliders to try other numbers.`,
  check: async (rendered, verifier) => verifier.check("shows-the-data", async () => {
    const shown = await rendered.waitForText(text => showsAbout(text, PAYMENT));
    return { pass: shown.pass, evidence: asEvidence({ expected: PAYMENT, text: shown.text }) };
  }),
}, {
  name: "L3-stepper",
  prompt: `Walk me through how binary search finds 37 in 3, 8, 12, 19, 23, 31, 37, 42, 50, 61, one
step at a time, with Next and Back buttons.`,
  check: async (rendered, verifier) => verifier.check("shows-the-data", async () => {
    const shown = await rendered.waitForText(text =>
      LIST.every(number => new RegExp(`(?<![\\d.])${number}(?![\\d.])`).test(text)));
    return { pass: shown.pass, evidence: asEvidence({ text: shown.text }) };
  }),
}, {
  name: "L4-statement",
  prompt: `Here's my October card statement:

${STATEMENT.map(row => `Oct ${String(row.day).padStart(2, "0")}, ${row.merchant}, ${row.category}, $${money(row.amount)}`).join("\n")}

Break it down for me: what I spent in total and by category, a chart of spending by day, and a table
of the transactions that I can filter by category.`,
  check: async (rendered, verifier) => {
    await verifier.check("shows-the-data", async () => {
      const shown = await rendered.waitForText(text => showsAbout(text, STATEMENT_TOTAL) &&
        CATEGORIES.every(category => mentions(text, category) && showsAbout(text, categoryTotal(category))));
      return { pass: shown.pass, evidence: asEvidence({ total: STATEMENT_TOTAL, text: shown.text }) };
    });
    await verifier.check("filters-by-category", async () => {
      const chose = await rendered.choose("Travel", CATEGORIES.filter(category => category !== "Travel"), text =>
        travelOnly.every(merchant => mentions(text, merchant)) && !groceryOnly.some(merchant => mentions(text, merchant)));
      return { pass: chose.pass, evidence: asEvidence({ tried: chose.tried, text: chose.text }) };
    });
  },
}, {
  name: "L5-runs",
  prompt: `Here's my running log for the last ten weeks (date, distance, time):

${RUNS.map(run => `${runDate(run.day)}, ${run.km.toFixed(1)} km, ${clock(run.seconds)}`).join("\n")}

Analyze it for me: weekly distance, how my pace changed over time, my total distance and longest
run, and my fastest pace on a run of 10 km or more. Let me switch the chart between distance and
pace.`,
  check: async (rendered, verifier) => {
    await verifier.check("shows-the-data", async () => {
      const shown = await rendered.waitForText(text =>
        (showsAmount(text, Math.round(TOTAL_KM * 10) / 10) || showsAbout(text, TOTAL_KM)) && showsAmount(text, LONGEST_KM));
      return { pass: shown.pass, evidence: asEvidence({ totalKm: TOTAL_KM, longestKm: LONGEST_KM, text: shown.text }) };
    });
    await verifier.check("switches-to-pace", async () => {
      const before = await rendered.text();
      const chose = await rendered.choose("Pace", ["Distance"], text => text !== before);
      return { pass: chose.pass, evidence: asEvidence({ tried: chose.tried }) };
    });
  },
}];

/** What the agent did this turn: its steps, tool calls and errors, what it wrote, usage and first view. */
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
        firstViewMs: verifier.chat.firstViewMs ?? null,
        usage: verifier.chat.usage,
      }),
    };
  });
}

function viewTurn(prompt: string, check: Rung["check"], taskId: string): EvalTurn {
  return {
    prompt: prompt + VIEW_ASK,
    verify: async verifier => {
      await recordOutput(verifier);
      const view = await checkAnswersWithView(verifier);
      await checkMakesNoGadget(verifier, "makes-no-new-gadget");
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

// D1-D2: sales a Gadget keeps, which only code can read. Turn 1 builds it and the verifier adds
// the sales; its metrics are not the view's.
const REGIONS = ["North", "South", "East", "West"] as const;
const CUSTOMERS = ["Acme", "Globex", "Initech", "Umbrella", "Hooli", "Stark", "Wayne", "Wonka", "Tyrell", "Cyberdyne"];
const PRODUCTS = ["Widget", "Gizmo", "Sprocket", "Doohickey"];
const salesRandom = new Seeded(23);
const SALES = Array.from({ length: 300 }, (_, index) => ({
  date: new Date(Date.UTC(2026, 8, 1 + Math.floor(index / 10))).toISOString().slice(0, 10),
  region: salesRandom.pick(REGIONS),
  product: salesRandom.pick(PRODUCTS),
  customer: salesRandom.pick(CUSTOMERS),
  amount: salesRandom.int(40, 2400),
}));

const SaleSchema = z.object({ region: z.string(), customer: z.string(), amount: z.number() });
const ListSchema = z.object({ sales: z.array(SaleSchema) });
interface SalesApi {
  addMany(input: { sales: typeof SALES }): Promise<unknown>;
  list(): Promise<z.infer<typeof ListSchema>>;
}

async function sales(verifier: EvalVerifier) {
  using api = await verifier.connect<SalesApi>("Sales Log");
  return ListSchema.parse(await api.list()).sales;
}

if (ARMS.has("view")) {
  for (const rung of RUNGS) {
    const id = `bench-${LABEL}-${rung.name.toLowerCase()}`;
    defineTaskEval(defineEvalTask({ id, turns: [viewTurn(rung.prompt, rung.check, id)] }));
  }

  const id = `bench-${LABEL}-d-sales`;
  defineTaskEval(defineEvalTask({
    id,
    turns: [{
      prompt: `I want a log of our sales. Name it exactly "Sales Log" and keep the sales in its own storage,
with this server RPC taking and returning plain data:

- addMany({ sales: [{ date: string, region: string, product: string, customer: string, amount: number }] }) -> { ok: true, count: number }
- list() -> { sales: [{ date, region, product, customer, amount }] }, every sale, oldest first`,
      verify: async verifier => {
        await recordOutput(verifier);
        await checkBuildsGadget(verifier);
        await verifier.check("records-sales", async () => {
          using api = await verifier.connect<SalesApi>("Sales Log");
          const before = ListSchema.parse(await api.list()).sales.length;
          await api.addMany({ sales: SALES });
          const after = ListSchema.parse(await api.list()).sales.length;
          return { pass: after - before === SALES.length, evidence: asEvidence({ before, after }) };
        });
      },
    }, viewTurn("Show me total sales by region.", async (rendered, verifier) =>
      verifier.check("shows-the-data", async () => {
        const all = await sales(verifier);
        const totals = REGIONS.map(region => [region, all.filter(sale => sale.region === region)
          .reduce((sum, sale) => sum + sale.amount, 0)] as const);
        const shown = await rendered.waitForText(text => totals.every(([region, total]) => mentions(text, region) && showsAbout(text, total)));
        return { pass: shown.pass, evidence: asEvidence({ totals, text: shown.text }) };
      }), `${id}-1`),
    viewTurn("Now show me every sale in a table I can search by customer, newest first, with a chart of daily sales.",
      async (rendered, verifier) => {
        const all = await sales(verifier);
        const largest = all.reduce((best, sale) => sale.amount > best.amount ? sale : best);
        await verifier.check("shows-the-data", async () => {
          const shown = await rendered.waitForText(text => mentions(text, largest.customer) && showsAbout(text, largest.amount));
          return { pass: shown.pass, evidence: asEvidence({ largest, rows: all.length, text: shown.text.slice(0, 2000) }) };
        });
        await verifier.check("searches-by-customer", async () => {
          const changed = await rendered.setValue("", "Hooli", text => mentions(text, "Hooli") && !mentions(text, "Globex"));
          return { pass: changed.pass, evidence: asEvidence({ how: changed.how, text: changed.text.slice(0, 2000) }) };
        });
      }, `${id}-2`)],
  }));
}

if (ARMS.has("gadget")) {
  for (const rung of RUNGS) {
    defineTaskEval(defineEvalTask({
      id: `bench-gadget-${rung.name.toLowerCase()}`,
      turns: [{
        prompt: rung.prompt + GADGET_ASK,
        verify: async verifier => {
          await recordOutput(verifier);
          await checkBuildsGadget(verifier);
        },
      }],
    }));
  }
}
