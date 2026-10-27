// A `<gadget-ui>` block's frame, in Chromium: the browser, not the agent's instructions, keeps a
// view's code from parsing the data it shows as HTML.

import { newMessagePortRpcSession } from 'capnweb'
import { afterEach, expect, it } from 'vitest'
import {
  createUiBlockDocumentStart, createUiBlockShell, UiBlockHostImpl, type UiBlockFrame, type UiBlockTheme,
} from './uiBlockFrame'

const THEME: UiBlockTheme = { scheme: 'light', tokens: {} }

const resources: Disposable[] = []

afterEach(() => {
  for (const resource of resources.splice(0).toReversed()) resource[Symbol.dispose]()
})

/** Runs `body` as a block in a frame, as the card does, and returns the first message it asks to send. */
function runBlock(body: string): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>()
  const iframe = document.body.appendChild(document.createElement('iframe'))
  iframe.sandbox.add('allow-scripts')
  resources.push({ [Symbol.dispose]: () => iframe.remove() })
  window.addEventListener('message', function handshake(event) {
    const port = event.ports[0]
    if (event.source !== iframe.contentWindow || port === undefined) return
    window.removeEventListener('message', handshake)
    const frame = newMessagePortRpcSession<UiBlockFrame>(port, new UiBlockHostImpl({
      onMessageRequest: resolve,
      onResize: () => {},
      onError: message => reject(new Error(message)),
    }))
    resources.push(frame)
    frame.write(createUiBlockDocumentStart(THEME) + body).catch(reject)
    frame.close().catch(reject)
  })
  iframe.srcdoc = createUiBlockShell(THEME)
  return promise
}

it('lets a view clear an element, but not parse a string as HTML or as a handler', async () => {
  const message = await runBlock(`
    <p id="out">Loading</p>
    <script type="module">
      const out = document.getElementById("out");
      const attempts = {
        innerHTML: () => { out.innerHTML = "<img src=x onerror=alert(1)>"; },
        insertAdjacentHTML: () => out.insertAdjacentHTML("beforeend", "<b>x</b>"),
        onclickAttribute: () => out.setAttribute("onclick", "alert(1)"),
        ownPolicy: () => trustedTypes.createPolicy("mine", { createHTML: html => html }),
        blockPolicy: () => trustedTypes.createPolicy("gadget-ui", { createHTML: html => html }),
      };
      const refused = Object.keys(attempts).filter(name => {
        try { attempts[name](); return false; } catch { return true; }
      });
      out.innerHTML = "";
      agent.send(JSON.stringify({ refused, cleared: out.childNodes.length === 0 }));
    </script>`)

  expect(JSON.parse(message)).toEqual({
    refused: ['innerHTML', 'insertAdjacentHTML', 'onclickAttribute', 'ownPolicy', 'blockPolicy'],
    cleared: true,
  })
})
