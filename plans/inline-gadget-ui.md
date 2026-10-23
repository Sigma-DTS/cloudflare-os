# Plan: Inline gadget UIs in chat

## Goal

The agent can draw a live view inside its answer. It writes HTML, CSS and JS between
`<gadget-ui>` tags in the answer text, with no tool call. The Workshop runs each block in a
sandboxed frame built the same way as a gadget's UI frame. A block can name one of the chat's
gadgets and call that gadget's server over Cap'n Web. A block can also ask to send a call to the
agent. The call goes out only when the viewer clicks Send, and it then wakes the agent as a call
on `self` does.

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
    bar.onclick = () => agent.call("drillDown", { week: w.week });
  }
</script>
</gadget-ui>
```

Today an agent that wants to show something interactive must create a gadget, write its files
with tool calls, and send the user to the side pane. That is slow for a one-off chart or a
choice between three options, and each result adds a gadget to the workspace list.

[Kinu](https://github.com/AshishKumar4/kinu)'s `<slate-ui>` blocks are the model for this
feature: they draw agent-written HTML in place in the answer. This plan keeps that speed but
builds blocks from gadget parts: the same sandbox, the same Cap'n Web bridge and the same gadget
servers.

Acceptance criteria:

- A stored agent answer that contains a `<gadget-ui>` block shows the block as a live,
  interactive frame in the chat, in the Workshop's light or dark theme.
- While the answer streams, the chat shows a placeholder card. The frame starts only after the
  message is stored.
- A block with `gadget="NAME"` gets a `gadget` stub to the server that `env.NAME.rpc` reaches in
  the agent's `executeCode`. That is the chat's draft when the chat proposes changes to the
  gadget, and mainline otherwise.
- `agent.call(name, ...args)` in a block shows a Send chip under the block. Nothing reaches the
  kernel until the viewer clicks Send. The click records an `agentCallback` named `name` on the
  viewer's account and selected model, and the agent reads the arguments as `name_ARGS`.
- The `gadget` stub reaches only the facet that the agent's own binding reaches. The Send click
  carries the same authority as a message the viewer sends.
- Only the workspace owner and build collaborators can open a block. Use-role collaborators
  cannot see chats, and the new RPC denies them.

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
  `getGadgetFacet(id, chatId, joinedAs)`. That is the facet that `startGatekeeperSession` opens for
  the agent's binding (`overseer.ts:5174`), with `#resolveGadgetChatId` applied (`overseer.ts:4615`).
  The gadget's own calls to gatekeepers keep the gadget's caller, as they do when the agent calls
  it, and approval does not depend on the caller (`autoApprovalRule`, `auto-approval.ts:28`). A
  block gets the gadget's `rpc`, not its `exports`.
- **A call to the agent needs a trusted click.** `agent.call` in the frame only asks the host to
  show a Send chip. The Workshop draws the chip in its own DOM, so block code cannot click it.
  Only the viewer's click on Send calls the kernel. A block that calls `agent.call` on load or in
  a loop replaces its own pending chip and spends nothing.
- **A sent call is the viewer's prompt.** `callAgent` passes the viewer's user id and the model
  selected in the composer at click time to the existing `deliverAgentCallback`
  (`overseer.ts:7472`). That is the model `sendChatMessage` would use. `null` records the call
  without starting the agent, as for any callback without a model.
- **Callbacks get two kernel fixes first.** Each turn's batch must belong to one person, and a
  collaborator's callback turn must be authorized like a collaborator's message. See "Callback
  prerequisites". Views ship first and do not wait on these fixes.
- **A bound block's sent call records `useGadget`.** The arguments can carry data that the block
  read from its gadget. The drain writes a `useGadget` message before the `agentCallback`, which is
  the record the API keeps for this flow (`api.ts`, `useGadget`). One optional boolean on the
  pending call record carries this. The restricted-data latch does not change: gatekeeper
  observations set it, whoever the caller is.
- **Every block capability joins the viewer's session.** `UiBlockSession` joins the collaborator
  session when it is minted and leaves when it is disposed, as `GadgetClientImpl` does
  (`overseer.ts:12917`). The facet stub it returns joins through `getGadgetFacet`'s `joinAs`. A
  scope change can then sever both.

## Current-state anchors

Line numbers are for `origin/main` at `ec22b0026`.

Backend (`packages/workshop-backend/src`):

- `getEnvForAgent` (`overseer.ts:2629`) gives each chat gadget binding
  `rpc: makeBindingLoopback({type: "gadget", id}, {from: "agent", chatId})`.
  `startGatekeeperSession` (`overseer.ts:5174`) opens it with `getGadgetFacet(id, chatId)` and
  marks the step `accessedGadget`. The step barrier turns that mark into a `useGadget` message
  (`agent.ts:4158`). Replay skips `useGadget` (`agent.ts:2852`).
- `getGadgetFacet(gadgetId, chatId?, joinAs?)` (`overseer.ts:4679`) returns the facet stub.
  `joinAs` ties its lifetime to a collaborator session. `docs/observers.md` lists every
  capability that counts toward a session.
- `#resolveGadgetChatId` (`overseer.ts:4615`) keeps `chatId` only if that chat proposes changes to
  the gadget. Otherwise the facet runs mainline.
- `AgentSelfLoopback` (`overseer.ts:10940`) sends any method call on `self` to
  `deliverAgentCallback` (`overseer.ts:7472`), which stores the call with `initiatorUserId` and
  `initiatorModelId`. `#drainPendingAgentCalls` (`overseer.ts:7559`) resolves the user and model
  from the first pending call only, writes every row under `gadgetAuthorFor` (`overseer.ts:5249`)
  and starts one turn for the whole batch.
- `#resumeAgent` re-authorizes a non-owner and holds a build lease only when
  `record.initiator.type === "user"` (`overseer.ts:1137-1143`). Callback turns have an author of
  type `gadget`, so a resumed callback turn skips that check. `overseer.ts:10572-10577` records
  a related known gap: give a fire-and-forget turn's first run its own build lease "before wiring
  this endpoint to real callers".
- `buildCompactionState` (`agent-compaction.ts:325`) folds the seed bindings, the previous
  checkpoint and the log into `chatBindings` without side effects. The agent's history replay
  builds the same map (`agent.ts:1738-1747`).
- In a spawned agent's chat, replay presents every `agentCallback` as a call from the spawning
  gadget (`agent.ts:2775-2777`).
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
  outside a code fence. Attributes take either quote style. A tag inside a fence, or in the
  middle of a line, is prose. A fence opens on a line that starts with three or more backticks or
  tildes, and closes on a line with at most three spaces of indent and the same marker, at least
  as long. Kinu's parser (`packages/core/src/slates/ui-blocks.ts`) uses these rules.
- A block ends at the next `</gadget-ui>`. A block with no end is still streaming, or the agent
  did not close it. Once its message is stored, the chat shows an unclosed block as code and does
  not run it.
- `index` counts every closed block in the message, whether or not its attributes are valid.
- The body is HTML. Its `<title>`, if present, gives the card title.
- `gadget=` must pass `validateBindingName`. A block with a bad value shows an error and runs
  nothing.
- Only stored messages of type `message` with an author of type `agent` can hold blocks. The
  parser runs on nothing else.

### Opening a block (kernel)

Two new members of the shared API, next to `getChatMessage` on `Overseer`:

```ts
/**
 * Opens block `index` (see `parseGadgetUiBlocks`) of the agent message `sequence` in chat
 * `chatId`. Throws when that message is not a stored agent answer or has no block at `index`.
 */
openUiBlock(chatId: number, sequence: number, index: number): Promise<UiBlockSession>;

/** The capabilities of one drawn block. Dispose it when the block's frame unmounts. */
interface UiBlockSession extends RpcTarget {
  /**
   * The server of the gadget the block names: the facet the chat's agent reaches through that
   * binding, at the chat's version. Throws when the block names no gadget, or when the name
   * resolves to no gadget or to a deleted one.
   */
  connectToGadget(): Promise<RpcStub<any>>;

  /**
   * Records a call to the chat's agent, as `self[methodName](...args)` does in `executeCode`.
   * The call runs on `modelId` in the caller's account, as a message sent with
   * `sendChatMessage` would; null records it without starting the agent. Throws in a spawned
   * agent's chat.
   */
  callAgent(methodName: string, args: unknown[], modelId: string | null): Promise<void>;
}
```

`connectToGadget` returns the same stub type as `GadgetClient.connectToGadget`. `callAgent` lands
with the callback work, after views.

The kernel steps:

1. Read the stored message at `sequence`, check that it is an agent `message`, parse it, and take
   block `index`.
2. If the block names a gadget, resolve the name. Extract the bindings part of
   `buildCompactionState` as `foldChatBindings(messages, initial)`, and call it with the chat's
   seed bindings, the active compaction checkpoint's `chatBindings`, and the log after that
   checkpoint. `openUiBlock` never calls `prepareChatBindings`, which writes chat context. It
   accepts the entry only if `storage.gadgets.get(id)?.type === "gadget"`, as `getEnvForAgent`
   does. Worktrees, gatekeepers and `_ARGS` value entries do not resolve.
3. Mint a `UiBlockSession` that holds `(chatId, gadgetId?, viewer)`. The browser cannot change
   these values. The session joins the viewer's collaborator session, and `docs/observers.md`
   lists it.
4. `connectToGadget` returns `getGadgetFacet(gadgetId, chatId, joinedAs)`. It does not set
   `accessedGadget`: the block shows gadget data to the viewer, not to the agent.
5. `callAgent` calls `deliverAgentCallback(chatId, methodName, args, viewerUserId, modelId)` and
   sets the record's `useGadget` boolean for a bound block. The existing storable check rejects
   arguments that cannot be stored, including stubs that are not persistent.

`UseOverseerInterface.openUiBlock` denies, and `DENIED_OVERSEER` gets the new entry. The
`UiBlockSession` implementation uses `@validateRpc()`.

### Callback prerequisites (kernel)

These change how existing callbacks behave. They land in the callback PR, before `callAgent`.

- **One person per turn.** `#drainPendingAgentCalls` takes only the leading run of pending calls
  that share `(initiatorUserId, initiatorModelId)`. The rest drain when that turn ends, as other
  pending work does through `#finishAgentTurn`. Today a batch runs on the first caller's account,
  and a first call with a `null` model leaves every other call in the batch without a turn.
- **Authorize a collaborator's callback turn.** Before `startAgent`, the drain re-runs
  `authorizeCollaborator` for a non-owner initiator and holds a build lease for the turn.
  `#resumeAgent` keys its check on `initiatorUserId !== ownerId` instead of the author type.
- **No block calls in spawned chats.** `callAgent` throws when the chat has a spawner config, since
  replay there presents every callback as a call from the spawning gadget.

### What a block can reach

| In the frame | Reaches | Rule |
|---|---|---|
| `gadget` | The named gadget's `rpc`, at the chat's version | Present only with `gadget=`. The kernel resolves the name in the chat's scope. |
| `agent.call` | A Send chip in the Workshop | Only the viewer's click on Send calls the kernel. The call runs on the viewer's account and selected model. |
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
- **Frame interfaces.** The host exports `UiBlockHost` to the frame. It has `gadget` (for a bound
  block), `requestAgentCall(methodName, args)` and `resize(height)`. The frame exports
  `UiBlockFrame`, with `setTheme(theme)`. Both interfaces are typed and documented beside the
  bootstrap, as the configurator's are (`gatekeeper.ts:470-520`). The host implementation uses
  `@validateRpc()` and is wrapped in `createRateLimitedCapability`. The gadget hangs off
  `host.gadget`, so gadget method names cannot collide with host methods.
- **One connection hook.** The handshake check, stub forwarding and reconnect move out of
  `GadgetUISession` into one hook that `GadgetUI` and block cards share. For a block, a broken
  gadget stub makes the hook call `session.connectToGadget()` again and swap the new stub in. After
  a bounded number of failures, the card shows an error with a Reload button.
- **Document.** Two small builders, one for gadget UIs and one for blocks, share one head constant
  with the CSP. The block document starts with a bootstrap module. It sets up the Cap'n Web
  session, then defines `globalThis.gadget` (bound blocks only) and `globalThis.agent`, which has
  one method, `call(methodName, ...args)`. Module scripts run in document order, so a block's
  `<script type="module">` sees both globals. The agent's instructions say to use module scripts.
- **One load per session.** The host accepts one handshake per frame load. A second `load` event
  on the frame disposes the session.
- **Send chip.** `requestAgentCall` only stores the block's latest request. The card shows it under
  the frame as a Kumo chip: the method name, a short summary of the arguments, and Send and
  Dismiss buttons. Send calls `session.callAgent` with the composer's current model. A newer
  request from the same block replaces the chip.
- **Height.** The block document sets `html, body { margin: 0; height: auto }`. The bootstrap
  reports `document.body.scrollHeight` through a `ResizeObserver`. The host clamps it as the
  configurator host does. Taller content scrolls inside the frame. The instructions forbid `vh`
  units and percentage heights on the root.
- **Theme.** The block document's root sets `color-scheme`, `background: transparent` and
  `color: var(--text-color-kumo-default)`, and the host sets `colorScheme` on the frame element.
  The host passes the computed values of a fixed list of Kumo tokens, under their Kumo names:
  `--color-kumo-base`, `--color-kumo-elevated`, `--color-kumo-line`, `--text-color-kumo-default`,
  `--text-color-kumo-subtle`, `--color-kumo-brand`, `--color-kumo-success`,
  `--color-kumo-warning` and `--color-kumo-danger`. Some values contain `light-dark()`, which the
  frame resolves through its own `color-scheme`. The host calls `setTheme` again when the theme
  changes. Blocks use system fonts, since the CSP has no `font-src`.
- **Mounting.** A frame mounts when its card first comes near the viewport, through an
  `IntersectionObserver`. It stays mounted until the user collapses the card or leaves the chat.
  A named constant caps the live frames per chat (8 to start), and the least recently shown frame
  unmounts first. A card without a frame keeps its last height, so the transcript does not jump.
  The collapse control has an accessible name, and the frame's `title` is the block title.
- **Errors.** Block console output goes nowhere. It must not reach the pane's buffer, which the
  composer offers to the agent. An uncaught error or a failed connect shows an error state on the
  card. Blocks do not forward Escape. No automatic error reporting captures block errors, since
  blocks are agent-written code (see the frontend error reporting rules in `AGENTS.md`).

### Agent instructions

One new section in the agent's instructions in `agent.ts`:

- When to draw a block: comparisons, choices, numbers over time, and live views of a gadget's
  data. A quick answer stays a sentence, and an explanation stays prose.
- The syntax, module scripts, `gadget`, and `agent.call`. A sent call arrives as a callback named
  after its first argument.
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
- **Sending `agent` calls straight to the kernel.** Block code could then start turns on load, on
  every remount and for every viewer, on that viewer's account, and a block could start a loop of
  turns. A check in the parent would depend on user activation passing from a cross-origin child
  frame to its parent, and Chromium tracks that behaviour as a security bug
  (<https://issues.chromium.org/issues/500508224>). A check inside the frame runs in the same realm
  as the block's code. The host's chip needs neither.
- **A proxy `agent`, where any method name is a call.** `JSON.stringify(agent)` in the console
  forwarder (`GadgetUI.tsx:43`) would call `toJSON`, and `await agent` would call `then`.
- **Storing the resolved gadget id on the message.** Names are never rebound, so resolving at open
  time gives the same answer.
- **Serving blocks from a separate origin by URL, as Kinu does.** Gadget UIs already get isolation
  from opaque-origin srcDoc frames.

## Commit sequence

Kernel and UI go in separate PRs, so that reviewers can read the kernel lines apart from the UI.
Views ship before callbacks.

1. **Kernel, views.** `parseGadgetUiBlocks`, `foldChatBindings`, `Overseer.openUiBlock`,
   `UiBlockSession.connectToGadget`, session counting, the `docs/observers.md` entry, and the
   use-role denial.
2. **Frontend, views.** The message split, block cards, the shared connection hook, the block
   document and bootstrap, height, theme, mounting and errors.
3. **Kernel, callbacks.** The callback prerequisites, `UiBlockSession.callAgent`, and the
   `useGadget` record.
4. **Frontend, callbacks.** `agent.call` and the Send chip.
5. **Agent instructions and an eval.** The view part can land after PR 2, and the `agent.call` part
   after PR 4. The eval checks blocks for readability in light and dark themes and at phone width
   (see `plans/evals-and-e2e-tests.md`).

## Verification

- Parser unit tests: fences, tags in the middle of a line (including a block that lands mid-line
  after another text block in the same step), unclosed blocks, several blocks in one message, bad
  `gadget=` values still counting toward `index`, and the same result for streamed and stored
  text.
- `foldChatBindings` returns the same map that `buildCompactionState` builds today.
- Backend tests for `openUiBlock`:
  - It resolves a seed binding, and a gadget created earlier in the same turn.
  - It fails for a deleted gadget, an unknown name, a worktree or gatekeeper binding, a message
    that is not an agent answer, and an index out of range.
  - The facet follows the chat's draft only while the chat proposes changes to the gadget.
  - The session and its facet stub count toward the collaborator session until they are disposed.
- Backend tests for callbacks:
  - `callAgent` records an `agentCallback` with the viewer as initiator and the given model, and a
    bound block also writes `useGadget`. `null` records the call without starting a turn.
  - Calls from two people drain as two turns, each on its own account.
  - A collaborator who lost build access gets no turn, on drain or on resume.
  - `callAgent` throws in a spawned agent's chat.
- The use-role integration table covers `openUiBlock`.
- Frontend tests on the `GadgetUI.integration.test.tsx` frame harness: a block module sees its
  globals; `agent.call` on load or in a loop never calls the kernel; Send passes the composer's
  current model; the session is disposed on unmount; a second frame load tears the session down; a
  facet restart reconnects; the height clamp holds; console output does not reach the pane buffer.
- An integration test with the mock model: the model answers with a bound block, and the test
  opens the block and calls the gadget. With callbacks, the test then sends a call and sees the next
  turn start.
- A browser check on the dev server: a block draws and resizes, follows a theme change, survives a
  reload, and wakes the agent after Send.

## Known edge cases

- **Old messages.** A block's code stays fixed in its message, but its data is live. If the
  gadget's methods change, an old block can fail. The card shows the error, and the agent can draw
  a new block.
- **Deleted gadget.** The binding stops working, and the card shows the error from
  `connectToGadget`.
- **A name bound after the block.** A block that names a binding before the chat has it starts to
  work once the chat binds that name. A denied connection request releases its name, which the
  same rule covers.
- **Versions.** A block and the pane in the same chat use the same version of a gadget. Two viewers
  on different versions restart the facet, as two panes do today, and the block reconnects.
- **Revoked access.** A call already sent before a collaborator loses build access does not start
  a turn, because the drain authorizes the initiator first.
- **Context cost.** The block's HTML stays in the agent's message, so the model reads it again on
  each later turn until compaction summarizes that part of the chat.

## Open questions

- Should a block's `agentCallback` row name the viewer? `gadgetAuthorFor` shows the workspace
  title, which hides who clicked Send in a shared chat.
- Should replay give the model a short stand-in for old block HTML? Any change must handle saved
  model snapshots and compaction, and must keep the stored answer unchanged.

## Future work

- Save a block as a gadget: the block's HTML becomes a new gadget's UI.
- A bound block with an empty body shows the gadget's own UI in the chat. Gadget UIs are made to
  fill the pane, so this needs a fixed height.
- A small library set for charts, packaged into the frame, since the CSP blocks CDNs.
- Drop popups from gadget UI frames too, or at least once the workspace has read restricted data.
