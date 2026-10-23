// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { newMessagePortRpcSession, RpcStub, RpcTarget } from 'capnweb'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Overseer } from '@gadgets/workshop-shared/api'
import type { GadgetUiBlock } from '@gadgets/workshop-shared/gadget-ui-blocks'
import type { UiBlockFrame, UiBlockHost } from './uiBlockFrame'

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  if (previousActEnvironment === undefined) {
    delete testGlobal.IS_REACT_ACT_ENVIRONMENT
  } else {
    testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
  }
})

vi.mock('@cloudflare/kumo', () => ({
  Banner: Object.assign(
    ({ description, action }: { description: ReactNode; action?: ReactNode }) => <div>{description}{action}</div>,
    { Action: ({ children, ...props }: { children: ReactNode }) => <button {...props}>{children}</button> },
  ),
  Button: ({ children, ...props }: { children: ReactNode }) => <button {...props}>{children}</button>,
  Input: () => null,
  InputArea: () => null,
  Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}))
vi.mock('../../ThemeContext', () => ({ useTheme: () => ({ resolvedThemeMode: 'light' }) }))

import { GadgetUiBlockCard } from './GadgetUiBlockCard'

// Every card is near the viewport.
class VisibleIntersectionObserver {
  constructor(private callback: IntersectionObserverCallback) {}
  observe() {
    this.callback([{ isIntersecting: true } as IntersectionObserverEntry], this as never)
  }
  disconnect() {}
}

class FakeGadget extends RpcTarget {
  disposed = false
  read() { return 'gadget data' }
  [Symbol.dispose]() { this.disposed = true }
}

class FakeOverseer extends RpcTarget {
  connects: unknown[][] = []
  gadgets: FakeGadget[] = []
  // The server end of each gadget connection, which a test closes to restart that server.
  servers: MessagePort[] = []
  connectToUiBlockGadget(...args: unknown[]) {
    this.connects.push(args)
    const gadget = new FakeGadget()
    this.gadgets.push(gadget)
    const { port1, port2 } = new MessageChannel()
    newMessagePortRpcSession(port1, gadget)
    this.servers.push(port1)
    return newMessagePortRpcSession<FakeGadget>(port2)
  }
  restart(connection: number) {
    // Cap'n Web's signal that the peer closed the port.
    this.servers[connection]?.postMessage(null)
  }
}

class FakeFrame extends RpcTarget implements UiBlockFrame {
  setTheme() {}
}

// The host as a bound block's frame sees it, with a FakeGadget as its gadget.
type TestHost = Omit<UiBlockHost, 'gadget'> & { gadget: FakeGadget }

const BOUND: GadgetUiBlock = { kind: 'block', index: 2, html: '<p>hi</p>', title: 'Spending', gadget: 'EXPENSES' }
const UNBOUND: GadgetUiBlock = { ...BOUND, gadget: undefined }

describe('GadgetUiBlockCard', () => {
  let container: HTMLDivElement
  let root: Root
  let overseer: FakeOverseer
  let sent: string[]
  // What a Send waits on, so a test can hold one in flight or fail it.
  let reply: () => Promise<void>
  const frameSessions: RpcStub<TestHost>[] = []

  beforeEach(() => {
    vi.stubGlobal('IntersectionObserver', VisibleIntersectionObserver)
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    overseer = new FakeOverseer()
    sent = []
    reply = () => Promise.resolve()
  })

  afterEach(async () => {
    for (const session of frameSessions.splice(0)) session[Symbol.dispose]()
    await act(async () => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })

  const scrollRoot = { current: null }
  const onHeightChange = () => {}
  const card = (fake: FakeOverseer, block: GadgetUiBlock, sendBlockedReason?: string) => (
    <GadgetUiBlockCard overseer={new RpcStub(fake) as unknown as RpcStub<Overseer>} chatId={1} sequence={7}
      block={block} scrollRoot={scrollRoot} sendBlockedReason={sendBlockedReason} onHeightChange={onHeightChange}
      onSendMessage={message => { sent.push(message); return reply() }} />
  )

  async function renderCard(block = BOUND, sendBlockedReason?: string) {
    await act(async () => root.render(card(overseer, block, sendBlockedReason)))
    await vi.waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())
    return container.querySelector('iframe')!
  }

  // Plays the frame's side of the handshake, as the block document's bootstrap does. The host's
  // calls queue on the port until the card answers.
  async function handshake(iframe: HTMLIFrameElement) {
    const { port1, port2 } = new MessageChannel()
    const host = newMessagePortRpcSession<TestHost>(port1, new FakeFrame())
    frameSessions.push(host)
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', {
        data: 'handshake', origin: 'null', source: iframe.contentWindow, ports: [port2],
      }))
    })
    return host
  }

  const buttonNamed = (name: string) =>
    [...container.querySelectorAll('button')].find(button => button.textContent === name)

  it("sends the view's message as the viewer's only when they click Send", async () => {
    const host = await handshake(await renderCard(UNBOUND))
    for (let i = 0; i < 5; i++) await host.requestMessage(`Show me week ${i}.`)

    await vi.waitFor(() => expect(container.textContent).toContain('Show me week 4.'))
    expect(container.textContent).not.toContain('Show me week 3.')
    expect(sent).toEqual([])

    await act(async () => buttonNamed('Send')!.click())
    await vi.waitFor(() => expect(sent).toEqual(['Show me week 4.']))
    await vi.waitFor(() => expect(buttonNamed('Send')).toBeUndefined())
    // An unbound view never reaches for a gadget.
    expect(overseer.connects).toEqual([])
  })

  it('drops a message the viewer dismisses', async () => {
    const host = await handshake(await renderCard(UNBOUND))
    await host.requestMessage('Pick Aero.')
    await vi.waitFor(() => expect(buttonNamed('Dismiss')).toBeDefined())

    await act(async () => buttonNamed('Dismiss')!.click())
    expect(buttonNamed('Send')).toBeUndefined()
    expect(sent).toEqual([])
  })

  it('holds Send while the chat waits on the viewer', async () => {
    const host = await handshake(await renderCard(UNBOUND, 'Approve the pending action above.'))
    await host.requestMessage('Pick Aero.')
    await vi.waitFor(() => expect(buttonNamed('Send')).toBeDefined())

    expect(container.textContent).toContain('Approve the pending action above.')
    expect(buttonNamed('Send')!.disabled).toBe(true)
  })

  it('keeps the message for another try when a Send fails', async () => {
    const host = await handshake(await renderCard(UNBOUND))
    await host.requestMessage('Pick Aero.')
    await vi.waitFor(() => expect(buttonNamed('Send')).toBeDefined())
    reply = () => Promise.reject(new Error('offline'))

    await act(async () => buttonNamed('Send')!.click())
    await vi.waitFor(() => expect(buttonNamed('Send')!.disabled).toBe(false))
    expect(sent).toEqual(['Pick Aero.'])
    expect(container.textContent).toContain('Pick Aero.')
  })

  it('keeps a newer message when an earlier Send finishes', async () => {
    const host = await handshake(await renderCard(UNBOUND))
    await host.requestMessage('Pick Aero.')
    await vi.waitFor(() => expect(buttonNamed('Send')).toBeDefined())
    let finish = () => {}
    reply = () => new Promise(resolve => { finish = resolve })
    await act(async () => buttonNamed('Send')!.click())
    await vi.waitFor(() => expect(sent).toHaveLength(1))

    await host.requestMessage('Pick Bolt.')
    await vi.waitFor(() => expect(container.textContent).toContain('Pick Bolt.'))
    await act(async () => {
      finish()
      await new Promise(resolve => setTimeout(resolve))
    })
    expect(container.textContent).toContain('Pick Bolt.')
    expect(buttonNamed('Send')).toBeDefined()
  })

  it("gives a bound view the server of the gadget its block names", async () => {
    const host = await handshake(await renderCard())
    await expect(host.gadget.read()).resolves.toBe('gadget data')
    expect(overseer.connects).toEqual([[1, 7, 2]])
  })

  it("reloads a bound view each time its gadget's server restarts, however often", async () => {
    // Real dates, so each break counts as soon after connecting; fake timers skip the reload waits.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      let iframe = await renderCard()
      for (let restart = 0; restart < 5; restart++) {
        await (await handshake(iframe)).gadget.read()
        overseer.restart(restart)
        await vi.waitFor(() => {
          vi.runOnlyPendingTimers()
          expect(container.querySelector('iframe')).not.toBe(iframe)
        })
        iframe = container.querySelector('iframe')!
      }
      await expect((await handshake(iframe)).gadget.read()).resolves.toBe('gadget data')
      expect(overseer.connects).toHaveLength(6)
      expect(buttonNamed('Reload')).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops a view whose document loaded again', async () => {
    const iframe = await renderCard()
    await (await handshake(iframe)).gadget.read()
    const { port2 } = new MessageChannel()
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', {
        data: 'handshake', origin: 'null', source: iframe.contentWindow, ports: [port2],
      }))
    })

    await vi.waitFor(() => expect(container.textContent).toContain('reloaded itself'))
    await vi.waitFor(() => expect(overseer.gadgets[0]!.disposed).toBe(true))
    expect(container.querySelector('iframe')).toBeNull()
    expect(buttonNamed('Reload')).toBeDefined()
  })

  it('reloads a bound view on a new connection to the Workshop', async () => {
    const first = await renderCard()
    await (await handshake(first)).gadget.read()
    const reconnected = new FakeOverseer()
    await act(async () => root.render(card(reconnected, BOUND)))
    await vi.waitFor(() => expect(container.querySelector('iframe')).not.toBe(first))

    const host = await handshake(container.querySelector('iframe')!)
    await expect(host.gadget.read()).resolves.toBe('gadget data')
    await vi.waitFor(() => expect(overseer.gadgets[0]!.disposed).toBe(true))
  })

  it("disposes its gadget's server when it unmounts", async () => {
    await (await handshake(await renderCard())).gadget.read()
    await act(async () => root.render(<></>))
    await vi.waitFor(() => expect(overseer.gadgets[0]!.disposed).toBe(true))
  })

  it('runs nothing for a block that must not run', async () => {
    await act(async () => root.render(card(overseer, { ...UNBOUND, error: 'Not a binding name.' })))
    expect(container.textContent).toContain('Not a binding name.')
    expect(container.querySelector('iframe')).toBeNull()
    expect(buttonNamed('Reload')).toBeUndefined()
  })
})
