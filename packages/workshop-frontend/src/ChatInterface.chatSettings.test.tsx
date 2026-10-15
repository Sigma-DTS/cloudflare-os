// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type * as Kumo from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import type {
  AiChatMessage, AiChatMetadata, AiChatSubscriber, ChatModelDescription, ChatModelSettings,
  ChatPreset, Overseer,
} from '@gadgets/workshop-shared/api'

// The composer's model settings, as a conversation shows and changes them.

// jsdom lays nothing out, so it has no ResizeObserver, and the message list's scrolling itself to
// the bottom on every render is a no-op.
const { scrollTo } = Element.prototype
beforeAll(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Element.prototype.scrollTo = () => {}
})
afterAll(() => {
  delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver
  Element.prototype.scrollTo = scrollTo
})

const toasts = vi.hoisted(() => ({
  add: vi.fn<(options: { title?: string, description?: string }) => string>(() => 'toast'),
  close: vi.fn<(id?: string) => void>(),
}))

vi.mock('@cloudflare/kumo', async (importOriginal) => ({
  ...await importOriginal<typeof Kumo>(),
  useKumoToastManager: () => toasts,
}))

const DEEP: ChatPreset = { id: 'deep', name: 'Deep work', settings: { reasoning: 'high' } }
const LONG: ChatPreset = { id: 'long', name: 'Long reads', settings: { compactionInputBudget: 800_000 } }

vi.mock('./AuthContext', () => {
  const context = {
    authenticatedApi: {
      listGatekeeperVendors: async () => [],
      listChatPresets: async () => [DEEP, LONG],
    },
    currentUser: null,
  }
  return {
    useAuthenticatedApi: () => context,
    useOptionalAuthenticatedApi: () => null,
  }
})

import { flushFrames, makeOverseer, makeTestRoot } from './action-test-harness'
import ChatInterface from './ChatInterface'
import { useChatModelDescription } from './features/chat/composer/useChatModelDescription'

const testRoot = makeTestRoot()

afterEach(() => {
  testRoot.cleanup()
  document.body.innerHTML = ''
  localStorage.clear()
  toasts.add.mockClear()
  vi.restoreAllMocks()
})

const CHAT_ID = 1
const MODEL = { type: 'agent', id: 'model', name: 'Model' } as const
// A model whose window has room for a budget of 900K.
const DESCRIPTION: ChatModelDescription = {
  reasoningLevels: ['low', 'medium', 'high'],
  builtInReasoning: 'adaptive',
  builtInCompactionInputBudget: 200_000,
  maxCompactionInputBudget: 900_000,
  runtimeKnown: true,
  reasoning: null,
  compactionInputBudget: 200_000,
}

const metadata = (modelSettings?: ChatModelSettings): AiChatMetadata => ({
  id: CHAT_ID,
  title: 'Chat',
  started: new Date(1700000000000),
  lastActive: new Date(1700000000000),
  totalTokens: 1200,
  ...(modelSettings && { modelSettings }),
})

// The model last spoke in the chat, so the composer has it selected.
const reply: AiChatMessage = {
  chatId: CHAT_ID,
  sequence: 0,
  timestamp: new Date(1700000000000),
  author: MODEL,
  type: 'message',
  message: 'Hello',
}

async function renderChat(options: {
  selectedChatId: number | null,
  chats?: AiChatMetadata[],
  sidebarMode?: boolean,
  setChatModelSettings?: (chatId: number, settings: ChatModelSettings) => Promise<void>,
  newChat?: (...args: unknown[]) => Promise<number>,
  describeChatModel?: () => Promise<ChatModelDescription>,
}) {
  const server = makeOverseer()
  let subscriber: AiChatSubscriber | undefined
  const setChatModelSettings = vi.fn<(chatId: number, settings: ChatModelSettings) => Promise<void>>(
    options.setChatModelSettings ?? (async () => {}))
  const newChat = vi.fn<(...args: unknown[]) => Promise<number>>(options.newChat ?? (async () => 2))
  Object.assign(server.overseer as object, {
    getChatMessage: async () => null,
    getChatHistory: async () => ({ messages: [reply] }),
    listChats: async () => options.chats ?? [],
    listModels: async () => [MODEL],
    describeChatModel: options.describeChatModel ?? (async () => DESCRIPTION),
    onRpcBroken: () => {},
    setChatModelSettings,
    newChat,
    subscribeToChat: (next: AiChatSubscriber) => {
      subscriber = next
      return { [Symbol.dispose]: () => {} }
    },
  })
  await testRoot.render(
    <ChatInterface
      workspaceId="workspace"
      overseer={server.overseer as RpcStub<Overseer>}
      selectedChatId={options.selectedChatId}
      sidebarMode={options.sidebarMode}
      onNavigateToChat={() => {}}
      pendingConsoleLogCount={0}
      consoleLogPreview=""
      consoleLogSeverity="info"
      onConsumeConsoleLogs={() => ''}
      onDiscardConsoleLogs={() => {}}
      onOpenGadget={() => {}}
      outputOfWorkpiece={() => undefined}
    />,
  )
  await server.resolveSubscription()
  await server.resolvePendingQuery({ entries: [] })
  // The chat list, its history and the model's description each take a round trip.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  return {
    setChatModelSettings,
    newChat,
    async pushMetadata(chat: AiChatMetadata) {
      await act(async () => { subscriber!.metadata(chat) })
    },
  }
}

const triggers = () =>
  Array.from(document.querySelectorAll<HTMLButtonElement>('button[aria-label^="Model settings"]'))

const trigger = () => {
  const element = triggers()[0]
  if (!element) throw new Error('No settings trigger')
  return element
}

const pickPreset = async (name: string, from = trigger()) => {
  await act(async () => { from.click() })
  flushFrames()
  const radio = Array.from(document.querySelectorAll<HTMLElement>('[role="radio"]'))
    .find((element) => element.textContent?.startsWith(name))
  if (!radio) throw new Error(`No preset ${name}`)
  await act(async () => { radio.click() })
}

const contextLine = () =>
  Array.from(document.querySelectorAll('span')).map((span) => span.textContent)
    .filter((text) => text?.startsWith('compacts at'))

describe('ChatInterface chat settings', () => {
  it('sets an existing chat’s settings, showing them at once', async () => {
    let settle!: () => void
    const chat = await renderChat({
      selectedChatId: CHAT_ID,
      chats: [metadata()],
      setChatModelSettings: () => new Promise<void>((resolve) => { settle = resolve }),
    })
    expect(trigger().getAttribute('aria-label')).toBe('Model settings')
    await pickPreset('Deep work')
    expect(chat.setChatModelSettings).toHaveBeenCalledExactlyOnceWith(CHAT_ID, { reasoning: 'high' })
    expect(trigger().getAttribute('aria-label')).toBe('Model settings: Deep work')
    // As the server does, it notifies the chat's metadata before it answers.
    await chat.pushMetadata(metadata(DEEP.settings))
    await act(async () => settle())
    expect(trigger().getAttribute('aria-label')).toBe('Model settings: Deep work')
    expect(toasts.add).not.toHaveBeenCalled()
  })

  it('puts the settings back, and says why, when the server refuses them', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    let refuse!: (err: Error) => void
    await renderChat({
      selectedChatId: CHAT_ID,
      chats: [metadata()],
      setChatModelSettings: () => new Promise<void>((_resolve, reject) => { refuse = reject }),
    })
    await pickPreset('Deep work')
    expect(trigger().getAttribute('aria-label')).toBe('Model settings: Deep work')
    await act(async () => refuse(new Error('No such chatId')))
    expect(trigger().getAttribute('aria-label')).toBe('Model settings')
    expect(toasts.add).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Couldn’t change the model settings',
      description: 'No such chatId',
      variant: 'error',
    }))
  })

  it('restores the settings the server holds when two changes in a row are refused', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const refusals: Array<(err: Error) => void> = []
    await renderChat({
      selectedChatId: CHAT_ID,
      chats: [metadata({ reasoning: 'low' })],
      setChatModelSettings: () =>
        new Promise<void>((_resolve, reject) => { refusals.push(reject) }),
    })
    expect(trigger().getAttribute('aria-label')).toBe('Model settings: Custom')
    await pickPreset('Deep work')
    const longReads = Array.from(document.querySelectorAll<HTMLElement>('[role="radio"]'))
      .find((element) => element.textContent?.startsWith('Long reads'))!
    await act(async () => { longReads.click() })
    expect(trigger().getAttribute('aria-label')).toBe('Model settings: Long reads')
    await act(async () => refusals[0](new Error('Refused')))
    expect(trigger().getAttribute('aria-label')).toBe('Model settings: Long reads')
    await act(async () => refusals[1](new Error('Refused')))
    expect(trigger().getAttribute('aria-label')).toBe('Model settings: Custom')
  })

  it('keeps a newer change over the notification of an earlier one', async () => {
    const answers: Array<() => void> = []
    const chat = await renderChat({
      selectedChatId: CHAT_ID,
      chats: [metadata()],
      setChatModelSettings: () => new Promise<void>((resolve) => { answers.push(resolve) }),
    })
    await pickPreset('Deep work')
    const longReads = Array.from(document.querySelectorAll<HTMLElement>('[role="radio"]'))
      .find((element) => element.textContent?.startsWith('Long reads'))!
    await act(async () => { longReads.click() })
    // The server notifies the first write, and answers it, while the second is on its way.
    await chat.pushMetadata(metadata(DEEP.settings))
    expect(trigger().getAttribute('aria-label')).toBe('Model settings: Long reads')
    await act(async () => answers[0]())
    expect(trigger().getAttribute('aria-label')).toBe('Model settings: Long reads')
    expect(contextLine()).toEqual(['compacts at ~680K'])
    await chat.pushMetadata(metadata(LONG.settings))
    await act(async () => answers[1]())
    expect(trigger().getAttribute('aria-label')).toBe('Model settings: Long reads')
  })

  it('starts a new chat with the settings last chosen', async () => {
    localStorage.setItem('lastChatModelSettings', JSON.stringify({ compactionInputBudget: 300_000 }))
    const chat = await renderChat({ selectedChatId: null })
    expect(trigger().getAttribute('aria-label')).toBe('Model settings: Custom')
    await pickPreset('Deep work')
    expect(JSON.parse(localStorage.getItem('lastChatModelSettings')!)).toEqual({ reasoning: 'high' })

    const textarea = document.querySelector<HTMLTextAreaElement>('[role="combobox"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        textarea, 'Build a dashboard')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(chat.newChat).toHaveBeenCalledExactlyOnceWith(
      'Build a dashboard', 'model', undefined, undefined, undefined, { reasoning: 'high' })
  })

  // In sidebar mode the list, and its new-chat composer, sit beside the selected chat.
  it('keeps the new-chat composer’s settings off the chat beside it', async () => {
    const chat = await renderChat({
      selectedChatId: CHAT_ID,
      chats: [metadata({ reasoning: 'low' })],
      sidebarMode: true,
    })
    const [newChatTrigger, chatTrigger] = triggers()
    expect(triggers()).toHaveLength(2)
    expect(newChatTrigger.getAttribute('aria-label')).toBe('Model settings')
    expect(chatTrigger.getAttribute('aria-label')).toBe('Model settings: Custom')
    await pickPreset('Deep work', newChatTrigger)
    expect(chat.setChatModelSettings).not.toHaveBeenCalled()
    expect(JSON.parse(localStorage.getItem('lastChatModelSettings')!)).toEqual({ reasoning: 'high' })
    expect(triggers().map((element) => element.getAttribute('aria-label')))
      .toEqual(['Model settings: Deep work', 'Model settings: Custom'])
  })

  it('names when the chat compacts only while its settings set a budget', async () => {
    const chat = await renderChat({ selectedChatId: CHAT_ID, chats: [metadata()] })
    expect(contextLine()).toEqual([])
    await chat.pushMetadata(metadata({ compactionInputBudget: 1_000_000 }))
    expect(contextLine()).toEqual(['compacts at ~765K'])
    await chat.pushMetadata(metadata({ reasoning: 'low' }))
    expect(contextLine()).toEqual([])
  })

  // Until then the model's maximum, which caps the budget, is unknown.
  it('names when the chat compacts only once the model is described', async () => {
    let describeModel!: (description: ChatModelDescription) => void
    const chat = await renderChat({
      selectedChatId: CHAT_ID,
      chats: [metadata({ compactionInputBudget: 1_000_000 })],
      describeChatModel: () => new Promise((resolve) => { describeModel = resolve }),
    })
    expect(contextLine()).toEqual([])
    await act(async () => describeModel(DESCRIPTION))
    expect(contextLine()).toEqual(['compacts at ~765K'])
    expect(chat.setChatModelSettings).not.toHaveBeenCalled()
  })
})

// What the composer is given for `modelId`, by way of a model's description.
const DescriptionProbe = ({ getOverseer, modelId }: {
  getOverseer: () => RpcStub<Overseer>,
  modelId: string | null,
}) => {
  const { description, failed, retry } = useChatModelDescription(getOverseer, modelId)
  return (
    <>
      <p>{failed ? 'failed' : description ? String(description.compactionInputBudget) : 'pending'}</p>
      <button type="button" onClick={retry}>Retry</button>
    </>
  )
}

const probeShows = () => document.querySelector('p')?.textContent

describe('the selected model’s description', () => {
  it('drops an answer for a model no longer selected', async () => {
    const answers = new Map<string, (description: ChatModelDescription) => void>()
    const overseer = {
      describeChatModel: (modelId: string) =>
        new Promise<ChatModelDescription>((resolve) => { answers.set(modelId, resolve) }),
    } as unknown as RpcStub<Overseer>
    const getOverseer = () => overseer
    await testRoot.render(<DescriptionProbe getOverseer={getOverseer} modelId="a" />)
    await testRoot.render(<DescriptionProbe getOverseer={getOverseer} modelId="b" />)
    expect(probeShows()).toBe('pending')
    await act(async () => answers.get('a')!({ ...DESCRIPTION, compactionInputBudget: 111 }))
    expect(probeShows()).toBe('pending')
    await act(async () => answers.get('b')!({ ...DESCRIPTION, compactionInputBudget: 222 }))
    expect(probeShows()).toBe('222')
  })

  it('is fetched again on retry once fetching it failed, and not before', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const describeChatModel = vi.fn<() => Promise<ChatModelDescription>>()
      .mockRejectedValueOnce(new Error('Unavailable'))
      .mockResolvedValue({ ...DESCRIPTION, compactionInputBudget: 333 })
    const overseer = { describeChatModel } as unknown as RpcStub<Overseer>
    const getOverseer = () => overseer
    await testRoot.render(<DescriptionProbe getOverseer={getOverseer} modelId="a" />)
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(probeShows()).toBe('failed')
    await act(async () => { document.querySelector('button')!.click() })
    expect(probeShows()).toBe('333')
    await act(async () => { document.querySelector('button')!.click() })
    expect(describeChatModel).toHaveBeenCalledTimes(2)
  })
})
