import { type RefObject, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react'
import { Banner, Text } from '@cloudflare/kumo'
import { CaretDownIcon, CaretRightIcon, PaperPlaneRightIcon } from '@phosphor-icons/react'
import { newMessagePortRpcSession, type RpcStub } from 'capnweb'
import type { Overseer } from '@gadgets/workshop-shared/api'
import type { GadgetUiBlock } from '@gadgets/workshop-shared/gadget-ui-blocks'
import { useTheme } from '../../ThemeContext'
import { WorkshopButton, WorkshopIconButton } from '../../components/WorkshopControls'
import {
  createUiBlockHtml,
  readUiBlockTheme,
  UiBlockHostImpl,
  type UiBlockFrame,
} from './uiBlockFrame'

const MIN_HEIGHT = 40
const MAX_HEIGHT = 720
// A view reloads when one of its bindings breaks, as a gadget's server does on every code change.
// One that keeps breaking within STABLE_CONNECTION_MS of its handshake waits longer each time.
const STABLE_CONNECTION_MS = 10_000
const MAX_RELOAD_DELAY_MS = 30_000
const reloadDelay = (quickBreaks: number) =>
  quickBreaks === 0 ? 0 : Math.min(1000 * 2 ** (quickBreaks - 1), MAX_RELOAD_DELAY_MS)

export type GadgetUiBlockCardProps = {
  overseer: RpcStub<Overseer>
  chatId: number
  block: GadgetUiBlock
  /** Sends a message as the viewer, as the composer does. Reports its own failures, then throws. */
  onSendMessage: (message: string) => Promise<void>
  /** Why the viewer cannot send now, e.g. the chat waits on an approval. */
  sendBlockedReason?: string
  /**
   * Runs after the card's height may have changed: its view reported a new height, its chip came
   * or went, or a binding's name joined its header.
   */
  onHeightChange: () => void
  /** The chat's scrolling message list. It clips the card before the window does. */
  scrollRoot: RefObject<HTMLElement | null>
}

/** A message the view asked to send, waiting on the viewer's Send, and whether that Send is running. */
type Chip = { message: string; sending: boolean }

const clampHeight = (height: number) =>
  Math.min(Math.max(height, MIN_HEIGHT), Math.min(MAX_HEIGHT, window.innerHeight - 120))

/** A live `<gadget-ui>` block of a stored agent answer, drawn in a sandboxed frame. */
export const GadgetUiBlockCard = ({
  overseer, chatId, block, onSendMessage, sendBlockedReason, onHeightChange, scrollRoot,
}: GadgetUiBlockCardProps) => {
  const { resolvedThemeMode } = useTheme()
  const cardRef = useRef<HTMLDivElement>(null)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const frameRef = useRef<RpcStub<UiBlockFrame> | null>(null)
  const quickBreaksRef = useRef(0)
  const [nearViewport, setNearViewport] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const [height, setHeight] = useState(MIN_HEIGHT)
  const [error, setError] = useState<string | null>(block.error ?? null)
  // The latest uncaught error in the block's own code. The view keeps running.
  const [codeError, setCodeError] = useState<string | null>(null)
  const [frameKey, setFrameKey] = useState(0)
  const [chip, setChip] = useState<Chip | null>(null)
  // Names the view's code opened, in the order it opened them.
  const [names, setNames] = useState<string[]>([])
  // The first document's theme avoids a flash; the handshake sends the current one.
  const [srcDoc] = useState(() => createUiBlockHtml(block.html, readUiBlockTheme()))

  // The Overseer connection the current frame load asked for a binding on. Its stubs and lookups
  // die with that connection, so a new one (the Workshop reconnected) needs a new load. A frame
  // that never asked keeps running.
  const [askedOn, setAskedOn] = useState<{ stub: RpcStub<Overseer> } | null>(null)
  if (askedOn !== null && askedOn.stub !== overseer) {
    setAskedOn(null)
    setFrameKey(key => key + 1)
  }

  const openBinding = useEffectEvent((name: string) => {
    // Marked before the lookup, so a lookup still in flight when the Workshop reconnects counts.
    setAskedOn(current => current ?? { stub: overseer })
    return overseer.connectToChatBinding(chatId, name)
  })

  const live = nearViewport && !collapsed && error === null

  useEffect(() => {
    const card = cardRef.current
    if (!card) return
    // The margin has to grow the message list's box: a scrolling ancestor clips the card first.
    const observer = new IntersectionObserver(
      ([entry]) => setNearViewport(entry?.isIntersecting ?? false),
      { root: scrollRoot.current, rootMargin: '100% 0px' },
    )
    observer.observe(card)
    return () => observer.disconnect()
  }, [scrollRoot])

  useEffect(() => {
    if (!live) return
    let closed = false
    let handshakes = 0
    let reloading = false
    const resources: Disposable[] = []
    const teardown = () => {
      frameRef.current = null
      // A request needs the frame that made it, and an error the document that threw it.
      setChip(null)
      setCodeError(null)
      setAskedOn(null)
      for (const resource of resources.splice(0).toReversed()) resource[Symbol.dispose]()
    }

    const handleMessage = (event: MessageEvent) => {
      // Only our own frame, still at its opaque origin ("null" is the string the browser reports).
      if (event.source !== iframeRef.current?.contentWindow || event.origin !== 'null') return
      const port = event.ports[0]
      if (event.data !== 'handshake' || !port) return
      if (++handshakes > 1) {
        // The document loaded again without the Workshop reloading it: its code navigated.
        port.close()
        teardown()
        setError('This view reloaded itself, so it was stopped.')
        return
      }
      const openedAt = Date.now()
      const host = new UiBlockHostImpl({
        openBinding: name => openBinding(name),
        onBinding: name => setNames(current => current.includes(name) ? current : [...current, name]),
        onBindingBroken: () => {
          // Disposing a stub can report it broken, and the stubs of one load often break together.
          if (closed || reloading) return
          reloading = true
          if (Date.now() - openedAt > STABLE_CONNECTION_MS) quickBreaksRef.current = 0
          const timer = setTimeout(() => setFrameKey(key => key + 1), reloadDelay(quickBreaksRef.current++))
          resources.push({ [Symbol.dispose]: () => clearTimeout(timer) })
        },
        onMessageRequest: message => setChip({ message, sending: false }),
        onResize: reported => setHeight(clampHeight(reported)),
        onError: setCodeError,
      })
      resources.push(host)
      const frame = newMessagePortRpcSession<UiBlockFrame>(port, host)
      resources.push(frame)
      frameRef.current = frame
      void frame.setTheme(readUiBlockTheme())
    }

    window.addEventListener('message', handleMessage)
    return () => {
      closed = true
      window.removeEventListener('message', handleMessage)
      teardown()
    }
  }, [live, frameKey])

  useEffect(() => {
    // ThemeProvider applies a mode to the document before it publishes it.
    void frameRef.current?.setTheme(readUiBlockTheme())
  }, [resolvedThemeMode])

  useLayoutEffect(() => onHeightChange(), [height, chip, names, onHeightChange])

  const send = async () => {
    if (!chip || chip.sending || sendBlockedReason !== undefined) return
    const { message } = chip
    setChip({ message, sending: true })
    // The view may ask again while this one is in flight; the newer request stays.
    try {
      await onSendMessage(message)
      setChip(current => current?.message === message ? null : current)
    } catch {
      setChip(current => current?.message === message ? { message, sending: false } : current)
    }
  }

  const reload = () => {
    quickBreaksRef.current = 0
    setError(null)
    setFrameKey(key => key + 1)
  }

  const title = block.title ?? 'View'
  return (
    <div ref={cardRef} className="my-2 overflow-hidden rounded-lg border border-kumo-line bg-kumo-base">
      <div className="flex flex-wrap items-center gap-2 px-2 py-1.5">
        <WorkshopIconButton
          aria-label={collapsed ? `Show ${title}` : `Hide ${title}`}
          aria-expanded={!collapsed}
          onClick={() => setCollapsed(value => !value)}
          className="!h-7 !w-7"
        >
          {collapsed ? <CaretRightIcon size={14} /> : <CaretDownIcon size={14} />}
        </WorkshopIconButton>
        <Text size="sm" bold>{title}</Text>
        {names.map(name => (
          <span key={name} className="rounded bg-kumo-tint px-1.5 font-mono text-[11px] leading-5 text-kumo-subtle">
            {name}
          </span>
        ))}
      </div>
      {!collapsed && (error !== null ? (
        <div className="px-3 pb-3">
          <Banner
            variant="error"
            title="This view stopped"
            description={error}
            // A block the parser refused must never run.
            action={block.error === undefined ? <Banner.Action onClick={reload}>Reload</Banner.Action> : undefined}
          />
        </div>
      ) : (
        <div className="border-t border-kumo-line" style={{ height }}>
          {live && (
            <iframe
              key={frameKey}
              ref={iframeRef}
              srcDoc={srcDoc}
              title={title}
              sandbox="allow-scripts"
              className="block h-full w-full border-0"
            />
          )}
        </div>
      ))}
      {!collapsed && error === null && codeError !== null && (
        <div className="border-t border-kumo-line px-3 py-1.5">
          <Text size="sm" variant="error">{codeError}</Text>
        </div>
      )}
      <div aria-live="polite">
        {!collapsed && chip && (
          <div className="flex flex-wrap items-center gap-2 border-t border-kumo-line px-3 py-2" role="group" aria-label="Send to the agent">
            <PaperPlaneRightIcon size={14} className="text-kumo-subtle" aria-hidden />
            <div
              // A keyboard user has to be able to scroll a long message to read it all.
              tabIndex={0}
              role="region"
              aria-label="Message to send"
              className="max-h-32 min-w-0 flex-1 overflow-y-auto whitespace-pre-wrap break-words"
            >
              <Text size="sm">{chip.message}</Text>
            </div>
            {sendBlockedReason !== undefined && <Text size="sm" variant="secondary">{sendBlockedReason}</Text>}
            <div className="ml-auto flex gap-2">
              <WorkshopButton onClick={() => setChip(null)}>Dismiss</WorkshopButton>
              <WorkshopButton tone="primary" disabled={chip.sending || sendBlockedReason !== undefined} onClick={send}>
                Send
              </WorkshopButton>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/** A `<gadget-ui>` block still streaming: its title, and no frame until the answer is stored. */
export const GadgetUiBlockPending = ({ title }: { title?: string }) => (
  <div className="my-2 flex items-center gap-2 rounded-lg border border-dashed border-kumo-line px-3 py-2.5">
    <Text size="sm" variant="secondary">Drawing {title ?? 'a view'}…</Text>
  </div>
)
