// The frame of a `<gadget-ui>` block in an agent answer (see plans/inline-gadget-ui.md): the
// document it runs, and the Cap'n Web interfaces between it and the Workshop. The block's HTML is
// agent-written and nobody reviews it, so the frame gets the gadget UI sandbox and only what
// UiBlockHost offers.

import { RpcTarget } from 'capnweb'
import type { Overseer } from '@gadgets/workshop-shared/api'
import { CAPNWEB_MODULE_URL, SANDBOX_HEAD } from '../../sandboxDocument'
import { createRateLimitedCapability } from '../../rateLimitedCapability'

/** The gadget server stub a bound block gets. */
type GadgetStub = Awaited<ReturnType<Overseer['connectToUiBlockGadget']>>

/** The Workshop's theme, as a block's frame applies it. */
export type UiBlockTheme = {
  scheme: 'light' | 'dark'
  /** Kumo token values by token name, e.g. `--color-kumo-base`. */
  tokens: Record<string, string>
}

/** What a block's frame may call on the Workshop, through the session its handshake opens. */
export interface UiBlockHost {
  /** The server of the gadget the block names. Undefined when the block names none. */
  readonly gadget: GadgetStub | undefined

  /**
   * Asks the viewer to send `message` to the chat as their own message. The Workshop shows it
   * under the block, and sends it only when the viewer clicks Send. A newer request from the same
   * block replaces it.
   */
  requestMessage(message: string): void

  /** Reports the height of the block's content, in CSS pixels. */
  resize(height: number): void

  /** Reports an uncaught error in the block's code. */
  reportError(message: string): void
}

/** What the Workshop may call on a block's frame. */
export interface UiBlockFrame {
  /** Applies a new theme, e.g. after the viewer switches between light and dark. */
  setTheme(theme: UiBlockTheme): void
}

// The Kumo tokens a block can use. Blocks get these names only; the agent's instructions list them.
const THEME_TOKENS = [
  '--color-kumo-base',
  '--color-kumo-elevated',
  '--color-kumo-line',
  '--text-color-kumo-default',
  '--text-color-kumo-subtle',
  '--color-kumo-brand',
  '--color-kumo-success',
  '--color-kumo-warning',
  '--color-kumo-danger',
] as const

/**
 * The Workshop's current theme, as `applyThemeMode` set it on the document root. Some token values
 * contain `light-dark()`, which the frame resolves through its own `color-scheme`.
 */
export function readUiBlockTheme(): UiBlockTheme {
  const root = document.documentElement
  const style = getComputedStyle(root)
  return {
    scheme: root.dataset.mode === 'dark' ? 'dark' : 'light',
    tokens: Object.fromEntries(THEME_TOKENS.map(name => [name, style.getPropertyValue(name).trim()])),
  }
}

export class UiBlockHostImpl extends RpcTarget implements UiBlockHost {
  readonly #gadget: GadgetStub | undefined
  readonly #disposeGadget: () => void

  constructor(
    gadget: GadgetStub | undefined,
    private readonly onMessageRequest: (message: string) => void,
    private readonly onResize: (height: number) => void,
    private readonly onError: (message: string) => void,
  ) {
    super()
    // A block can stay on screen as long as a dashboard, so pace a flood rather than fail it.
    const limited = gadget && createRateLimitedCapability(gadget, {
      maxConcurrency: 8,
      maxCallsPerMinute: 600,
      maxPendingCalls: 128,
      onRateLimit: 'throttle',
      label: 'Chat view',
    })
    this.#gadget = limited?.capability
    this.#disposeGadget = limited?.dispose ?? (() => {})
  }

  get gadget(): GadgetStub | undefined {
    return this.#gadget
  }

  requestMessage(message: string): void {
    if (typeof message !== 'string' || message.trim() === '') {
      throw new TypeError('agent.send() takes the message to send.')
    }
    this.onMessageRequest(message)
  }

  resize(height: number): void {
    if (Number.isFinite(height)) this.onResize(height)
  }

  reportError(message: string): void {
    this.onError(String(message))
  }

  [Symbol.dispose](): void {
    this.#disposeGadget()
  }
}

// Runs before the block's own module scripts, which run in document order, so they see `gadget`
// and `agent`. A classic script runs first and cannot use them.
const bootstrapUrl = (bound: boolean) => `data:text/javascript;charset=utf-8,${encodeURIComponent(String.raw`//# sourceURL=gadget-ui-bootstrap.js
import { RpcTarget, newMessagePortRpcSession } from "${CAPNWEB_MODULE_URL}";

const applyTheme = ({ scheme, tokens }) => {
  const root = document.documentElement.style;
  root.colorScheme = scheme;
  for (const [name, value] of Object.entries(tokens)) root.setProperty(name, value);
};
class Frame extends RpcTarget {
  setTheme(theme) { applyTheme(theme); }
}

const { port1, port2 } = new MessageChannel();
window.parent.postMessage("handshake", "*", [port2]);
const host = newMessagePortRpcSession(port1, new Frame());

${bound ? 'globalThis.gadget = host.gadget;' : ''}
globalThis.agent = Object.freeze({
  send: message => host.requestMessage(message),
});

new ResizeObserver(() => host.resize(Math.ceil(document.body.getBoundingClientRect().height)))
    .observe(document.body);
window.addEventListener("error", event => host.reportError(event.error?.message ?? event.message));
window.addEventListener("unhandledrejection",
    event => host.reportError(event.reason?.message ?? String(event.reason)));
`)}`

// Built once, because each embeds all of Cap'n Web.
const BOUND_BOOTSTRAP_URL = bootstrapUrl(true)
const UNBOUND_BOOTSTRAP_URL = bootstrapUrl(false)

const themeStyle = ({ scheme, tokens }: UiBlockTheme) =>
  `:root { color-scheme: ${scheme}; ${Object.entries(tokens).map(([name, value]) => `${name}: ${value};`).join(' ')} }`

/**
 * The document a block's frame runs: the gadget UI sandbox head, the theme, the bootstrap, then
 * the block's HTML as written.
 */
export function createUiBlockHtml(html: string, bound: boolean, theme: UiBlockTheme): string {
  return `<!DOCTYPE html>
<html>
<head>
  ${SANDBOX_HEAD}
  <style>
    ${themeStyle(theme)}
    html, body { margin: 0; height: auto; background: transparent; }
    /* The padding keeps a view's borders and focus rings off the card's edge, and stops a child's
       margin from collapsing through the body, which would leave it out of the measured height. */
    body { padding: 12px; color: var(--text-color-kumo-default); font: 14px/1.45 system-ui, sans-serif; }
  </style>
  <script type="module" src="${bound ? BOUND_BOOTSTRAP_URL : UNBOUND_BOOTSTRAP_URL}"></script>
</head>
<body>
${html}
</body>
</html>`
}
