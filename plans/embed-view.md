# Plan: Views from `executeCode` with `embedView` (exploration)

## Goal

A throwaway variant of `plans/inline-gadget-ui.md`, built to compare two ways an agent can show a
live view in the chat:

- **Inline views** (#874): the agent writes HTML between `<gadget-ui>` tags in its answer. The
  view draws as the answer streams, in one model step, but holds only what the agent writes into
  it, so data from a Gadget, a connection or a computation passes through the model as text.
- **`embedView`** (this plan): the agent's `executeCode` composes data from its bindings and
  computations, then calls `embedView({ title, html, css, js, data })`. The Workshop shows the view
  in the chat when the step ends. The data goes from code to the view without the model reading or
  retyping it.

The comparison measures, per approach and model: view reliability (each view rendered and judged
from a screenshot), render and tool-call failure rates, model steps, tool calls, prompt tokens,
cost, characters written and wall time. A Gadget built for the same request is the third arm.

## API

In `executeCode`, a global function:

```js
export default async function (self, env) {
  const { byCategory } = await env.EXPENSE_LOG.rpc.totals();
  embedView({
    title: "Spending by category",
    html: `<h3>Spending by category</h3><div id="bars"></div>`,
    css: `#bars button { display: block; margin: 4px 0; }`,
    js: `
      const bars = document.getElementById("bars");
      for (const [category, total] of Object.entries(data)) {
        const bar = bars.appendChild(document.createElement("button"));
        bar.textContent = category + ": $" + total;
        bar.onclick = () => agent.send("Tell me about my " + category + " spending.");
      }`,
    data: byCategory,
  });
}
```

- `title` (required) names the view; it is the frame's accessible name and the line the tool
  result gives the model.
- `html` is the view's body. `css` becomes a `<style>` before it. `js` runs as a module script
  after the markup, with the globals `data` and `agent`.
- `data` is any JSON value. The view's code reads it as `data`.
- `embedView` returns nothing. A run may show up to 4 views, in call order.

## How it runs

- **Harness.** `CODE_MODE_HARNESS` defines `globalThis.embedView` before it calls the agent's
  function. Each call checks the spec (a non-empty `title`, string `html`, `css` and `js`, JSON
  `data`) and its size, and keeps a copy. `run()` returns the views. A spec that fails a check
  throws in the agent's code, so the model sees the error in the tool result and can retry.
- **Size.** A view's spec, as JSON, is at most 256 KiB. The views are stored in the step's message
  record, and a Durable Object storage value holds at most 2 MiB, shared with the rest of the step.
- **Record.** `executeCodeMode` returns the log and the views. The `executeCode` tool call stores
  them as `views` beside `output`. The tool result the model reads is the log, then one line per
  view: `Showed the user a view: <title>.`
- **Rendering.** The chat draws each view of a step's `executeCode` calls under that step's tool
  calls, in the inline view's card and frame (`GadgetUiBlockCard`): the same sandbox, Trusted
  Types CSP, theme, height, Stop, errors and Send chip. `embeddedViewHtml` in `workshop-shared`
  builds the block from the spec, and the evals use it too, so both run the same document.
- **Data cannot become markup.** `embeddedViewHtml` writes `data` into the module script as a
  JSON string with every `<` escaped, so text from a binding cannot close the script or add
  elements. The view's own code still shows it, and the Trusted Types CSP stops it from showing
  it as HTML.

## Agent instructions

The "Live views in your answers" section is replaced by one on `embedView`: when to show a view,
the spec, that `data` carries the values so the code never retypes them, that the view shows when
the step ends so the answer should not repeat it, and the same view rules as inline views:
`textContent` for data, no network, the Kumo colour tokens, the height rules, `agent.send` in the
user's words, and no state.

## Tradeoffs to measure

- **Steps.** An inline view can be one model step. `embedView` needs at least two: the step that
  calls `executeCode`, and the step after its result. When the data comes from a binding, an inline
  view needs `executeCode` first anyway, so both need two steps.
- **Streaming.** An inline view draws while the answer streams. An `embedView` view shows only
  when its `executeCode` call finishes.
- **Data.** Inline views carry data the model retypes; `embedView` passes it from code. Retyping
  costs output tokens and can change a number.
- **Context.** Both keep the view's code in the chat history: in the answer text, or in the
  `executeCode` input.

## Review of v1 (2026-10-28)

v1 lost to inline views in the first comparison (42/45 vs 45/45 trials, 1.7× the prompt tokens,
20–50% more cost, visual scores level). Three of its losses come from v1's design, not from the
idea:

- **The view's code is a string inside code.** `js` is a template literal inside the
  `executeCode` module, which is itself a JSON string in the tool call. View code that uses a
  template literal must escape it, and `${...}` in it is evaluated in `executeCode`, not in the
  view. The one script error was this: gpt-6-luna escaped a nested backtick and wrote NUL bytes
  in its place.
- **Every view costs a second model step.** The turn goes on after `executeCode` returns, so the
  model reads the whole context again to write a line under the view. That step was the 1.7×:
  v2, which drops it, matched inline's prompt tokens up to L3 (10.9K against 10.8K).
- **The instructions never say not to paste the code.** They name `executeCode`, but Kimi K3
  pasted the code into its answer once.

Two losses come from the idea and no design removes them: the view exists only once its code has
run, so it cannot draw while the model writes it, and each view needs a well-formed tool call.

## v2

- **`script` is a function**, `data => { ... }`, written in the `executeCode` source, so the tool
  call parses it with the rest of the code and nothing is escaped. The harness sends its source to
  the view, which calls it with `data`. Only an arrow, a function or a method with a plain name is
  taken; anything else is refused with an error the model can act on. It runs in the view, so it
  sees only `data` and the view's globals, not the variables around it.
- **The view's module goes in as a `data:` URL**, so nothing in its script or data can end the
  script element. v1 spliced its script in raw, so `"</script>"` in a string would have broken it.
- **A step that shows a view ends the turn.** The view is the answer: the model writes any words
  before the call, in the same step. A step in which any `executeCode` call failed goes on, so the
  model can fix it.
- **The instructions say to call the tool**, never to paste its code.

v2 also gets the task v1 was built for: a view of more data than a model can retype cheaply,
read from a Gadget, and a ladder of in-chat views from simple to complex. The harness times each
turn's first view content: when an inline block first has visible markup in the stream, and when
the step with an `embedView` call is stored. That is when the Workshop can draw it, not when the
browser paints it.

A review of v2 found two gaps a production version must close, which no benchmark task reaches:
the end of a turn after a view is decided in memory only, so a Durable Object reset after the step
is stored would resume the turn; and a turn answered by a view alone gives a text-only chat gateway
no response.

## Results of v2 (2026-10-28)

`evals/bench-views.eval.ts`, inline views (#874) against `embedView` v2, 3 trials each on
gpt-6-luna, claude-haiku-5-5 and Kimi K3. Rungs L1–L5 are views of data in the prompt, from five
numbers to a ten-week running log; D1–D2 read a Gadget of 300 sales (region totals, then every
sale). Medians for time, means for the rest; 354 trials, $20.46. Rate-limited trials (10) and
failed Gadget builds in the setup turn (4) are left out. Haiku was rerun after its output limit
was found at pi's 4096 default.

| Rung | Passed (inline / embed) | First view s | Done s | Model steps | Prompt tokens |
|---|---|---|---|---|---|
| L1 five numbers | 9/9 · 9/9 | 4.8 · 8.7 | 8 · 11 | 1.1 · 1.0 | 12.4K · 10.9K |
| L2 chart | 9/9 · 9/9 | 7.7 · 17.3 | 14 · 18 | 1.0 · 1.0 | 10.8K · 10.9K |
| L2 plans + toggle | 9/9 · 9/9 | 5.6 · 19.5 | 13 · 20 | 1.0 · 1.0 | 10.8K · 10.9K |
| L3 mortgage | 9/9 · 9/9 | 6.7 · 17.0 | 14 · 18 | 1.0 · 1.0 | 10.8K · 10.9K |
| L3 stepper | 9/9 · 9/9 | 14.1 · 18.6 | 18 · 19 | 1.0 · 1.0 | 10.8K · 10.9K |
| L4 statement, 30 rows + filter | 9/9 · 9/9 | 18.2 · 26.3 | 28 · 27 | 1.6 · 1.1 | 17.7K · 13.2K |
| L5 running log, 40 rows + toggle | 4/9 · 7/9 | 35.1 · 38.9 | 46 · 40 | 2.4 · 1.6 | 33.5K · 23.4K |
| D1 region totals | 11/12 · 15/15 | 10.3 · 12.7 | 14 · 14 | 2.4 · 1.1 | 42.9K · 16.6K |
| D2 300 rows + search | 11/11 · 12/15 | 24.2 · 29.0 | 54 · 30 | 2.9 · 1.1 | 76.4K · 18.6K |

- **Inline draws first at every rung.** It is 1.3–3.5× sooner up to L3; the gap closes to 1.1×
  by L5.
- **Up to L3 the two are level** on passing, a screenshot judge's scores (4.3–4.9 of 5 both
  ways), prompt tokens and cost.
- **From L4, inline agents run code first.** They compute the totals with `executeCode`, then
  write the view, which costs an extra step. At L5 they left out stats the user asked for (total
  distance, longest run) in 3 of 9 trials, against 1 of 9 for `embedView`, which stays at about
  one step.
- **On Gadget data, `embedView` wins from the first rung.** It takes one step instead of 2.4–2.9,
  and 2.6× (D1) to 4.1× (D2) fewer prompt tokens. At D2 it costs 3.6–4.3× less on every model.
  When the view showed a grand total, inline was wrong 2 times in 10 (Luna retyped region totals
  and summed them off by 1,000 and 10,000); `embedView` was right 10 times in 10.
- **Cost on data in the prompt depends on the model.** Luna is cheaper with `embedView` from L4
  (0.14¢ against 0.20¢, then 0.21¢ against 0.40¢). Haiku costs about the same either way. Kimi K3
  is cheaper inline: it writes an `executeCode` call far more slowly than an answer of the same
  size (L5 first view 340 s against 143 s).
- **`embedView` failures:** views too wide for a phone (3 at D2), two views showing "NaN:NaN",
  and, once in all v2 runs, Kimi K3 pasting the code into its answer instead of calling the tool.
- **A Gadget built the same views in 4–6 steps** with 4.3–7.0 tool calls, 1.8–3× the time and
  1.4–6× the cost of either view.

**Verdict.** Neither design wins outright. Inline's advantage is real and comes from the design:
it draws while the model writes, with no tool call. `embedView`'s advantage is just as real: data
goes from code to the view without the model reading, retyping or adding it up. The crossing point
depends on where the data comes from. For data the user pasted, it is around L4, the first view
that needs computed totals over a few dozen rows. For data read from a Gadget or another tool, it
is at the first rung.

## Inline views with bindings (2026-10-28)

The Gadget-data rungs again, on #874 before bindings were deferred (commit `7cff53a9e`), where a
view reads the chat's Gadgets through `env`. 18 trials; 13 reached each view turn (5 rate-limited
or failed Gadget setups left out).

| All 300 sales | Inline | Inline + bindings | `embedView` |
|---|---|---|---|
| First draw s (median) | 24.2 | 9.5 | 29.0 |
| Done s (median) | 54 | 19 | 30 |
| Model steps | 2.9 | 1.1 | 1.1 |
| Prompt tokens | 76.4K | 19.3K | 18.6K |
| Context added (median) | 19.5K | 2.7K | 2.7K |
| Passed | 11/11 | 11/13 | 12/15 |

- With bindings the view reads the Gadget itself: about one step, no tool call, and `embedView`'s
  tokens and context. It draws 2–3× sooner, since it streams.
- Cost per answer is about the same as `embedView` (Luna 0.17¢ both; Haiku 0.38¢ against 0.34¢;
  Kimi K3 7.8¢ against 6.8¢). Its grand totals were right 10 times in 10.

**Context usage**, the chat's prompt before an answer against the last step's prompt plus its
reply: with data in the prompt, inline and `embedView` add about the same (1–11K, growing with the
view); a Gadget adds 1.3–3.2× more. For the 300-sale view, inline without bindings adds 19.5K,
because the rows pass through the chat; bindings and `embedView` add 2.7K.

**Verdict, with bindings.** Inline views with bindings take away `embedView`'s lead on Gadget data
and keep inline's lead on everything else. [INFERENCE, untested] `embedView` would still win on a
view of data no binding reaches, such as values computed or fetched in code (web search, a
connection), which an inline view would have to retype.

## By difficulty level (2026-10-28)

All nine tasks, grouped into five levels, with all four approaches at every level. Inline +
bindings also ran the prompt-data tasks, and a Gadget also built the stored-data views. 471
trials, $26.49. Each level is the mean over its tasks of each task's median (times, context) or
mean (the rest); cost is relative to the inline view, as a geometric mean over the three models.

| Level | Tasks | First result s (inline · +bindings · embed · Gadget) | Prompt tokens | Cost vs inline (+bindings · embed · Gadget) |
|---|---|---|---|---|
| 1 | 5-number chart | 4.8 · 6.1 · 8.7 · 24.0 | 12.4K · 11.0K · 10.9K · 50.3K | 1.38 · 0.95 · 3.33 |
| 2 | 12-month chart, plan picker | 6.6 · 7.8 · 18.4 · 34.0 | 10.8K · 11.0K · 10.9K · 57.6K | 1.00 · 1.10 · 3.27 |
| 3 | mortgage, stepper, region totals (stored) | 10.4 · 7.7 · 16.1 · 52.2 | 21.5K · 14.7K · 12.8K · 119.8K | 0.87 · 0.83 · 3.67 |
| 4 | 30-row statement, 40-row log | 26.6 · 27.8 · 32.6 · 67.7 | 25.6K · 24.0K · 18.3K · 93.8K | 1.04 · 0.97 · 2.03 |
| 5 | 300 stored rows | 24.2 · 9.5 · 29.0 · 56.3 | 76.4K · 19.3K · 18.6K · 145.6K | 0.28 · 0.25 · 0.79 |

On data in the prompt, bindings change nothing: inline + bindings tracks the inline view at
levels 1–4, because there is nothing to bind. Checks passed at level 4: inline 72%, + bindings
78%, `embedView` 89%. The report with charts is `views-by-difficulty.pdf` (linked from #914).

## Not in this exploration

Live data, and a migration between the two approaches.
