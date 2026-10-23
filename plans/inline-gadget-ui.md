# Plan: Inline gadget UIs in chat

## Goal

The agent can draw a live view inside its answer. It writes HTML, CSS and JS between
`<gadget-ui>` tags in the answer text, with no tool call. The Workshop runs each block in a
sandboxed frame built the same way as a gadget's UI frame. A block can name one of the chat's
gadgets and call that gadget's server over Cap'n Web. A block can also suggest a message for the
viewer to send. The message goes out only when the viewer clicks Send, as the viewer's own chat
message.

```html
Food spending is up 18% on September, mostly eating out.

<gadget-ui gadget="EXPENSES">
<title>Food spending, October</title>
<div id="chart"></div>
<script type="module">
  const weeks = await gadget.totalsByWeek({ month: "2026-10", category: "food" });
  for (const w of weeks) {
    const bar = document.getElementById("chart").appendChild(document.createElement("button"));
    bar.style.height = `${w.total / 4}px`;
    bar.onclick = () => agent.send(`Show me week ${w.week} in detail.`);
  }
</script>
</gadget-ui>
```

Today an agent that wants to show something interactive must create a gadget, write its files
with tool calls, and send the user to the side pane. That is slow for a one-off chart or a
choice between three options, and each result adds a gadget to the workspace list.

[Kinu](https://github.com/AshishKumar4/kinu)'s `<slate-ui>` blocks are the model for this
feature: they draw agent-written HTML in place in the answer. This plan keeps that speed but
builds blocks from parts the Workshop already has: the gadget sandbox, the Cap'n Web bridge, the
gadget servers, and the composer's send path.

Acceptance criteria:

- A stored agent answer that contains a `<gadget-ui>` block shows the block as a live,
  interactive frame in the chat, in the Workshop's light or dark theme.
- While the answer streams, the chat shows a placeholder card. The frame starts only after the
  message is stored.
- A block with `gadget="NAME"` gets a `gadget` stub to the server that `env.NAME.rpc` reaches in
  the agent's `executeCode`. That is the chat's draft when the chat proposes changes to the
  gadget, and mainline otherwise.
- `agent.send(message)` in a block shows the message under the block, with Send and Dismiss.
  Nothing reaches the kernel until the viewer clicks Send. Send uses the composer's send path,
  exactly as if the viewer had typed the message, and waits whenever the composer waits.
- The `gadget` stub reaches only the facet that the agent's own binding reaches. A sent message
  carries the viewer's authority, because it is the viewer's message.
- Only the workspace owner and build collaborators can connect a block to its gadget. Use-role
  collaborators cannot see chats, and the new RPC denies them.

## Locked decisions

- **A block runs in a gadget-style frame.** The frame is an opaque-origin srcDoc document with
  the gadget UI CSP. A block's HTML never goes into the Workshop document, and `MarkdownMessage`
  keeps `skipHtml`. The block frame is stricter than a gadget frame in one way: its sandbox is
  `allow-scripts` only, with no popups (see "What a block can reach").
- **The stored message is the source.** The frontend draws a block from its copy of the message
  text. The kernel decides what the block can reach from its own stored copy, through the same
  shared parser. The browser never sends a gadget id or a block's attributes.
- **A block is addressed by position.** The key is `(chatId, sequence, index)`, where `index`
  counts the closed blocks in that message. Blocks have no names, so the parser needs no rules for
  duplicate names.
- **`gadget=` is a chat binding name.** The kernel resolves it in the chat's binding scope, the
  scope that names the agent's `env`. Names are only added to that scope and never rebound
  (`agent.ts:1743`), so no resolved id is stored on the message. Build collaborators can already
  connect to any gadget through `GadgetClient.connectToGadget`, so this resolution keeps the block
  on the gadget the agent meant. It is not the security boundary.
- **The block's gadget stub is the agent's view of the gadget.** The kernel opens it with
  `getGadgetFacet(id, chatId, joinAs)`. That is the facet that `startGatekeeperSession` opens for
  the agent's binding (`overseer.ts:5174`), with `#resolveGadgetChatId` applied (`overseer.ts:4615`).
  The gadget's own calls to gatekeepers keep the gadget's caller, as they do when the agent calls
  it, and approval does not depend on the caller (`autoApprovalRule`, `auto-approval.ts:28`). A
  block gets the gadget's `rpc`, not its `exports`.
- **The stub counts toward the viewer's session.** `joinAs` is the caller's minted-capability
  kind, as for the stub `GadgetClient.connectToGadget` returns (`overseer.ts:12953`). A scope
  change can then sever it.
- **A message to the agent needs a trusted click.** `agent.send` in the frame only asks the host
  to show the message. The Workshop draws it in its own DOM, so block code cannot click Send. Only
  the viewer's click calls the kernel. A block that calls `agent.send` on load or in a loop
  replaces its own pending message and spends nothing.
- **A sent message is the viewer's message.** Send calls the composer's own send handler, which
  calls the existing `Overseer.sendChatMessage(chatId, message, modelId)` with the model selected
  in the composer (`ChatInterface.tsx:4062`). That path already runs the turn on the viewer's
  account, checks a collaborator's access, and steers the turn when the agent is running
  (`overseer.ts:12187`). The chip shows the whole message, so gadget data that a bound block puts
  in the message reaches the agent only as text the viewer chose to send, like text they paste.
  It needs no `useGadget` record. A view can change its message up to the click, so Send has no
  delay to stop that: the message goes to the agent that wrote the view, and the transcript shows
  exactly what was sent.

## Current-state anchors

Line numbers are for `origin/main` at `ec22b0026`.

Backend (`packages/workshop-backend/src`):

- `getEnvForAgent` (`overseer.ts:2629`) gives each chat gadget binding
  `rpc: makeBindingLoopback({type: "gadget", id}, {from: "agent", chatId})`.
  `startGatekeeperSession` (`overseer.ts:5174`) opens it with `getGadgetFacet(id, chatId)` and
  marks the step `accessedGadget`. The step barrier turns that mark into a `useGadget` message
  (`agent.ts:4158`).
- `getGadgetFacet(gadgetId, chatId?, joinAs?)` (`overseer.ts:4679`) returns the facet stub.
  `joinAs` ties its lifetime to a collaborator session. `docs/observers.md` lists every
  capability that counts toward a session.
- `#resolveGadgetChatId` (`overseer.ts:4615`) keeps `chatId` only if that chat proposes changes to
  the gadget. Otherwise the facet runs mainline.
- The gadget worker loads only materialized chat changes. `getUiBundle` (`overseer.ts:12949`)
  calls `checkChatExistsAndMaterializeChanges` (`overseer.ts:4806`) before a gadget pane loads, so
  the pane sees edits made in the code editor.
- `OverseerClientInterface.sendChatMessage` (`overseer.ts:12187`) steers a running turn through
  `steerRunningTurn` (`overseer.ts:6706`). Otherwise it reads the sender's chat context for the
  chosen model and calls `OverseerImpl.sendChatMessage` (`overseer.ts:6727`). A string message is
  plain text: only a `SlashCommandRequest` object runs a slash command.
- `buildCompactionState` (`agent-compaction.ts:325`) folds the seed bindings, the previous
  checkpoint and the log into `chatBindings` without side effects. The agent's history replay
  builds the same map (`agent.ts:1738-1747`).
- The agent's text for a step is joined with `""` and stored as one `message` at the step barrier
  (`agent.ts:4094-4099`). A failed or aborted request stores no answer. Streamed text reaches
  clients as `textDelta` (`agent.ts:4015`).
- `UseOverseerInterface` (`overseer.ts:12631`) denies every `Overseer` method that a use-role
  collaborator may not call. `DENIED_OVERSEER` in
  `packages/integration-tests/__tests__/workshop-use-role.test.ts:84` lists them all.

Frontend (`packages/workshop-frontend/src`):

- `createSandboxedHtml` (`GadgetUI.tsx:105`) wraps a gadget's `client.js` in a srcDoc page with
  the CSP `default-src 'none'; ... connect-src 'none'` (`GadgetUI.tsx:110`). The frame runs in
  `sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"` (`GadgetUI.tsx:517`). The
  parent accepts the handshake only from that frame's window with origin `"null"`, then exports a
  proxy that forwards every name to the gadget stub (`GadgetUI.tsx:340-384`). The Workshop
  document sets `frame-src srcdoc:` (`index.html:8`).
- On a broken gadget stub, `GadgetUI` only suspends calls (`GadgetUI.tsx:198-202`). It fetches a
  new stub when its `gadget` or `chatId` props change.
- The gadget pane buffers frame console output, and the composer offers that buffer to the agent
  with the user's next message (`GadgetEditor.tsx:959-966`).
- `MarkdownMessage` (`ChatInterface.tsx:1233`) renders message text with `skipHtml={true}`.
- The resource configurator's frame reports its height with a `ResizeObserver`
  (`packages/configurator-ui/src/runtime/frame.ts:42-66`). The host clamps it between 80 px and
  `min(720, innerHeight - 120)` (`SandboxedResourceConfigurator.tsx:11-12, 251`) and sets the
  frame's `colorScheme` (`SandboxedResourceConfigurator.tsx:444`). The host and frame interfaces
  are typed in `workshop-shared/src/gatekeeper.ts:470-520`, and the host wraps its capability in
  `createRateLimitedCapability` (`rateLimitedCapability.ts:27`).

## Design

### Block syntax

`parseGadgetUiBlocks(text)` in `workshop-shared` returns a message as an ordered list of prose and
blocks. The frontend uses it to lay out a message. The kernel uses it to decide what a block can
reach. Both run the same function on the same text, so the indexes agree. The stored text is the
streamed text joined with `""`, so provisional and stored text parse alike.

- A block opens with `<gadget-ui ...>` at the start of a line, after optional spaces or tabs,
  outside a code fence. A tag inside a fence, or in the middle of a line, is prose. A fence opens
  on a line that starts with three or more backticks or tildes. It closes on a line with the same
  marker, at least as long, indented at most three spaces more than the line that opened it, so a
  fence in a list item closes at the item's indent. Kinu's parser
  (`packages/core/src/slates/ui-blocks.ts`) uses the same rules, except that it closes a fence
  only at three spaces of indent or less.
- The `gadget` attribute takes a quoted or unquoted value, as HTML does. Only the attribute
  itself counts, so `data-gadget` does not bind a block.
- A block ends at the next `</gadget-ui>`. A block with no end is still streaming, or the agent
  did not close it. Once its message is stored, the chat shows an unclosed block as code and does
  not run it.
- `index` counts every closed block in the message, whether or not its attributes are valid.
- The body is HTML. Its `<title>`, if present, gives the card title, with each run of whitespace
  read as one space, as HTML reads it.
- `gadget=` must pass `validateBindingName`. A block with a bad value shows an error and runs
  nothing.
- Only stored messages of type `message` with an author of type `agent` can hold blocks. The
  parser runs on nothing else.
- A chat gateway shows only text, so the answer it gets has a note, such as
  `[View in the chat: Spending]`, in place of each closed block (`gadgetUiAnswerAsText`). An
  unclosed block stays as written, as the chat shows it.

### Connecting a block to its gadget (kernel)

One new member of the shared API, next to `getChatMessage` on `Overseer`:

```ts
/**
 * Opens the server of the gadget that a `<gadget-ui>` block names with its `gadget` attribute,
 * for block `index` (see `GadgetUiBlock.index`) of the agent answer at `sequence`. Throws unless
 * that block exists, is valid, and names a gadget the chat binds.
 */
connectToUiBlockGadget(chatId: number, sequence: number, index: number): Promise<RpcStub<any>>;
```

It returns the same stub type as `GadgetClient.connectToGadget`. An unbound block makes no kernel
call at all. The kernel steps:

1. Read the stored message at `sequence`, check that it is an agent `message`, parse it, and take
   block `index`. Refuse a block with a parse error or no `gadget=`.
2. Resolve the name. Extract the bindings part of `buildCompactionState` as
   `foldChatBindings(messages, initial)`, and call it with the chat's seed bindings, the active
   compaction checkpoint's `chatBindings`, and the log after that checkpoint. The lookup never
   calls `prepareChatBindings`, which writes chat context. It accepts the entry only if
   `storage.gadgets.get(id)?.type === "gadget"`, as `getEnvForAgent` does. Worktrees, gatekeepers
   and `_ARGS` value entries do not resolve. The kernel resolves on each call, so a block drawn
   before its chat binds the name works once the chat does.
3. Call `checkChatExistsAndMaterializeChanges(chatId)`, as `getUiBundle` does for a gadget pane.
4. Return `getGadgetFacet(gadgetId, chatId, joinAs)`. It does not set `accessedGadget`: the block
   shows gadget data to the viewer, not to the agent.

`OverseerClientInterface` already has `@validateRpc()`, so the arguments need no hand-written
checks. `UseOverseerInterface.connectToUiBlockGadget` denies, and `DENIED_OVERSEER` gets the new
entry.

### What a block can reach

| In the frame | Reaches | Rule |
|---|---|---|
| `gadget` | The named gadget's `rpc`, at the chat's version | Present only with `gadget=`. The kernel resolves the name in the chat's scope. |
| `agent.send` | A message shown under the block | Only the viewer's click on Send calls the kernel, through `sendChatMessage`, as the viewer's own message. |
| Popups, other frames, the network | Nothing | `sandbox="allow-scripts"`, CSP `connect-src 'none'`, and the Workshop's `frame-src srcdoc:`. |

Gadget UI frames keep `allow-popups` and `allow-popups-to-escape-sandbox`. So agent-written
`client.js` can still open a link that carries data out, even after the workspace has read
restricted data. This plan does not change gadget frames.

### Rendering (frontend)

- `ChatInterface` splits each agent message with `parseGadgetUiBlocks`. Prose still goes through
  `MarkdownMessage`. Each block becomes a card: a header with the title and, for a bound block,
  the binding name, then the frame. Copy still copies the raw message.
- Provisional text goes through the same parser. An open block shows a placeholder card with its
  title and no frame. The frame mounts when the stored message arrives.
- **Frame interfaces.** The host exports `UiBlockHost` to the frame. It has a `gadget` getter (for
  a bound block), `requestMessage(message)`, `resize(height)` and `reportError(message)`. The frame
  exports `UiBlockFrame`, with `setTheme(theme)`. Both interfaces are typed and documented in
  `features/chat/uiBlockFrame.ts`, beside the bootstrap, as the configurator's are
  (`gatekeeper.ts:470-520`). The frontend has no capnweb-validate transform, so the host checks its
  own arguments. Its gadget stub is wrapped in `createRateLimitedCapability`. The gadget hangs off
  `host.gadget`, so gadget method names cannot collide with host methods.
- **Connection.** The card checks the handshake as `GadgetUI` does: the message must come from the
  card's own frame window, with origin `"null"`. A bound card then connects to its gadget in one
  call. A broken gadget stub reloads the frame, which reconnects, because the gadget's server
  restarts on each code change and an agent can change code every few seconds. The first break
  reloads at once. Each next break within 10 seconds of connecting waits twice as long as the
  last, from 1 second up to 30, so a server that fails as it starts cannot reload the view in a
  loop. A `connectToUiBlockGadget` failure stops the view with an error and a Reload button. A new
  Overseer stub (the Workshop reconnected) reloads a bound frame too, and clears a failure from the
  old connection, because a frame hands over its port once per load. `GadgetUI` keeps its own
  session logic, since it forwards calls through a proxy to keep one frame across reconnects,
  which a block does not need.
- **Document.** `sandboxDocument.ts` holds the Cap'n Web module URL and the head with the CSP, and
  both `GadgetUI` and blocks build their documents from it. The block document starts with a
  bootstrap module, whose URL is built once per page for bound blocks and once for unbound ones,
  since each embeds all of Cap'n Web. It sets up the Cap'n Web session, then defines
  `globalThis.gadget` (bound blocks only) and `globalThis.agent`, which has one method,
  `send(message)`. Module scripts run in document order, so a block's `<script type="module">`
  sees both globals. The agent's instructions say to use module scripts.
- **One load per session.** The host accepts one handshake per frame load. A second handshake
  means the document navigated by itself, so the card disposes the session and stops the view.
- **Send chip.** `requestMessage` only stores the block's latest message, and refuses anything
  but a non-empty string, which the bootstrap passes on unconverted. The card shows the whole
  message under the frame, in a focusable region that scrolls past a few lines, with Send and
  Dismiss. Send calls the composer's send handler, so it trims the message, runs on the
  composer's model, and reports a failure as the composer does; the chip then stays for another
  try. While a connection request or an awaited action holds the composer, the chip shows the
  composer's reason and Send is off. A newer message from the same block replaces the chip, and a
  message goes away with the frame that asked. A Send that finishes after a newer message arrived
  leaves the newer one in place. The chip sits in a polite live region, so a screen reader
  announces it.
- **Height.** The block document sets `html, body { margin: 0; height: auto }`, and gives the body
  12 px of padding, so a view's borders and focus rings stay off the card's edge and a child's
  margin cannot collapse out of the measured height. The bootstrap reports the body's height
  through a `ResizeObserver`. The host clamps it between 40 px and
  `min(720, innerHeight - 120)`. Taller content scrolls inside the frame. A card tells the chat
  when its height changes, so a list at the bottom stays there as a view grows or its chip comes
  and goes; rows the viewer opens still do not move the list. The instructions forbid `vh` units
  and percentage heights on the page.
- **Theme.** The block document's root sets `color-scheme` and the token values, its background is
  transparent, and its text uses `var(--text-color-kumo-default)`. The host reads the mode from the
  `data-mode` attribute that `applyThemeMode` sets on `<html>`, and the computed values of a fixed
  list of Kumo tokens, under their Kumo names: `--color-kumo-base`, `--color-kumo-elevated`,
  `--color-kumo-line`, `--text-color-kumo-default`, `--text-color-kumo-subtle`,
  `--color-kumo-brand`, `--color-kumo-success`, `--color-kumo-warning` and
  `--color-kumo-danger`. Some values contain `light-dark()`, which the frame resolves through its
  own `color-scheme`. The host calls `setTheme` again when the theme changes. Blocks use system
  fonts, since the CSP has no `font-src`.
- **Mounting.** A frame is live only while its card is within one height of the chat's message
  list from that list's visible area, through an `IntersectionObserver` rooted at the list, and
  while the card is expanded. The root matters: a scrolling ancestor clips the card before a
  window-rooted margin applies. Scrolling far away unmounts the frame and disposes its gadget
  stub, so the number of live frames is bounded by what is near the screen. A card keeps its last
  height while its frame is gone, so the transcript does not jump. The collapse control has an
  accessible name, and the frame's `title` is the block title.
- **Errors.** Block console output goes nowhere. It must not reach the pane's buffer, which the
  composer offers to the agent. An uncaught error in block code shows under the view, which keeps
  running. A failed connect replaces the view with an error and a Reload button. Blocks do not
  forward Escape. No automatic error reporting captures block errors, since blocks are
  agent-written code (see the frontend error reporting rules in `AGENTS.md`).

### Agent instructions

One new section in the agent's instructions in `agent.ts`:

- When to draw a block: comparisons, choices, numbers over time, and live views of a gadget's
  data. A quick answer stays a sentence, and an explanation stays prose.
- The syntax, module scripts, `gadget`, and `agent.send`. The message should be in the user's
  words, since it is sent as theirs.
- Code that runs on load must only read. It runs again on each remount and for each viewer.
- The Kumo token names for colours. The block must read well in light and dark themes and at phone
  width, and must not use `vh` units or percentage heights on the root.
- No network, popups, or remote scripts, styles, fonts or images: the sandbox and the CSP block
  them. Data comes from the answer itself or from the gadget.
- A view that must remember state between visits belongs in a gadget, which the block then names.

## Rejected alternatives

- **Raw HTML in Markdown.** It would run agent-written code in the Workshop document, with the
  Workshop's authority.
- **A tool call that shows HTML.** Each view would cost a model round trip, and the view could not
  stream with the prose.
- **A gadget for each block.** Each one would add a gadget to the workspace list and a git
  history, and would need tool calls.
- **Giving a block the chat's whole `env`.** That would hand the agent's caller identity, approval
  waits and step accounting to code that runs in a browser outside any turn.
- **Sending a block's requests straight to the kernel.** Block code could then start turns on load,
  on every remount and for every viewer, on that viewer's account, and a block could start a loop
  of turns. A check in the parent would depend on user activation passing from a cross-origin child
  frame to its parent, and Chromium tracks that behaviour as a security bug
  (<https://issues.chromium.org/issues/500508224>). A check inside the frame runs in the same realm
  as the block's code. The host's chip needs neither.
- **Structured calls through the agent callback queue.** `agent.call(name, ...args)` could reach
  the agent as a call on `self` does, with the arguments in `env.name_ARGS`. But that queue serves
  the agent's own calls. It runs a batch of pending calls as one turn on the first caller's
  account, and it does not check a collaborator's access before a callback turn. Making it safe
  for calls from people took about 120 kernel lines and a new RPC method, while `sendChatMessage`
  already does both. The cost is that the agent gets text, not structured values. A view that must
  hand over a lot of data can write it to its gadget, which the agent then reads.
- **A proxy `agent`, where any method name is a call.** `JSON.stringify(agent)` in the console
  forwarder (`GadgetUI.tsx:43`) would call `toJSON`, and `await agent` would call `then`.
- **Gating or logging a block's gadget calls.** A block is agent-written client code, like a
  gadget's `client.js`. It reaches the same facet, and an agent-written draft `client.js` also runs
  on its own once the pane shows it. Calls from a gadget UI leave no chat record either
  (`GadgetClientImpl.connectToGadget` records only analytics), and gadget methods declare no
  read-only flag to limit a stub to. A click before the first call would break live views of
  gadget data, which are the main use. So a block's code may change its gadget's state, as a
  gadget's own UI may, and the agent instructions tell it to only read on load.
- **Storing the resolved gadget id on the message.** Names are never rebound, so resolving at
  connect time gives the same answer.
- **Serving blocks from a separate origin by URL, as Kinu does.** Gadget UIs already get isolation
  from opaque-origin srcDoc frames.

## Commits

One PR, with kernel and UI in separate commits so reviewers can read the kernel lines apart from
the UI:

1. **This plan.**
2. **Kernel.** `parseGadgetUiBlocks`, `foldChatBindings`, `Overseer.connectToUiBlockGadget`, the
   `docs/observers.md` entry, the use-role denial, and the agent instructions.
3. **Frontend.** The message split, block cards, the shared sandbox document, the bootstrap, the
   Send chip, height, theme, mounting and errors.
4. **The plan, updated to match the code.**

## Verification

- Parser unit tests (`workshop-backend/__tests__/gadget-ui-blocks.test.ts`): prose offsets, fences
  and their closing rules, including a fence in a list item, tags in the middle of a line,
  unclosed blocks, several blocks in one message, bad `gadget=` values still counting toward
  `index`, quoted and unquoted `gadget` values, `data-gadget`, the same blocks at every cut of a
  streamed answer once they close, and the text form a chat gateway gets.
- `foldChatBindings` is the loop `buildCompactionState` ran before, so the compaction suite covers
  it unchanged.
- Backend tests for `connectToUiBlockGadget` (`ui-blocks.test.ts`):
  - It refuses a message that is not an agent answer, an index out of range, a block with a bad
    `gadget=` value, and an unbound block.
  - It opens the facet at the chat's version for the owner and for a collaborator, counted toward
    the collaborator's session.
  - It folds in a live code-editor edit before it connects.
  - A name the chat binds after the block resolves once it is bound. A name bound to a worktree
    does not resolve.
  - After a compaction, a name resolves from the checkpoint's bindings and the messages after it.
- The use-role integration table covers `connectToUiBlockGadget`.
- Frontend tests (`GadgetUiBlockCard.test.tsx`, on the frame handshake harness of
  `GadgetUI.integration.test.tsx`): a message from the frame never calls the kernel until Send,
  which sends the latest one; an unbound view never connects to a gadget; Dismiss drops a
  message; Send is off while the composer is held; a failed Send keeps the message; a Send that
  finishes keeps a newer message; a bound view reaches the gadget its block names; a bound view
  reloads after each of five quick server restarts; a second handshake stops the view; a new
  Overseer connection reloads a bound view; unmounting disposes the gadget stub; a block that must
  not run shows its error, no frame and no Reload.
- A browser run on the dev server with a real model: the agent draws a bound and an unbound view,
  the views follow a theme change, a click shows the message, and Send posts it as the viewer's
  message and wakes the agent.

## Known edge cases

- **Old messages.** A block's code stays fixed in its message, but its data is live. If the
  gadget's methods change, an old block can fail. The card shows the error, and the agent can draw
  a new block.
- **Deleted gadget.** The binding stops working, and the card shows the error from
  `connectToUiBlockGadget`.
- **A name bound after the block.** A block that names a binding before the chat has it starts to
  work once the chat binds that name and the view reloads. A denied connection request releases
  its name, which the same rule covers.
- **Versions.** A block and the pane in the same chat use the same version of a gadget. Two viewers
  on different versions restart the facet, as two panes do today, and the block reconnects.
- **A running agent.** Send while the agent runs steers that turn, as a typed message does.
- **Context cost.** The block's HTML stays in the agent's message, so the model reads it again on
  each later turn until compaction summarizes that part of the chat.

## Open questions

- Should replay give the model a short stand-in for old block HTML? Any change must handle saved
  model snapshots and compaction, and must keep the stored answer unchanged.

## Future work

- Save a block as a gadget: the block's HTML becomes a new gadget's UI.
- A bound block with an empty body shows the gadget's own UI in the chat. Gadget UIs are made to
  fill the pane, so this needs a fixed height.
- A small library set for charts, packaged into the frame, since the CSP blocks CDNs.
- Drop popups from gadget UI frames too, or at least once the workspace has read restricted data.
- An eval that checks the agent's views for readability in light and dark themes and at phone
  width (see `plans/evals-and-e2e-tests.md`).
