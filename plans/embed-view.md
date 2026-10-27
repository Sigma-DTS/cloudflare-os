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

## Not in this exploration

Bindings in views (deferred in #874), live data, and a migration between the two approaches. If
`embedView` wins, its design gets its own reviewed plan.
