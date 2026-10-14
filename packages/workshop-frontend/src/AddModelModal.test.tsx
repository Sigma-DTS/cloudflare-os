// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type {
  AiGatewayInfo, AuthenticatedApi, GatewayModelLevelTest, ModelDescription, RedactedAiModelConfig,
} from '@gadgets/workshop-shared/api'

vi.mock('@cloudflare/kumo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cloudflare/kumo')>()),
  useKumoToastManager: () => ({ add: vi.fn<(toast: unknown) => void>() }),
}))

import AddModelModal, { type ModelModalMode } from './AddModelModal'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const PROFILE = { type: 'agent' as const, id: 'gemma', name: 'Gemma' }
const CONFIG: RedactedAiModelConfig = {
  provider: 'ollama',
  model: 'gemma',
  apiToken: null,
  apiUrl: 'https://ollama.example',
  extraHeaders: { 'X-Key': null },
}

const input = (selector: string) => {
  const element = document.body.querySelector<HTMLInputElement>(selector)
  if (!element) throw new Error(`No input matching ${selector}`)
  return element
}

const labeledInput = (label: string) => {
  const labelElement = Array.from(document.body.querySelectorAll('label'))
    .find(element => element.textContent?.startsWith(label))
  if (!labelElement) throw new Error(`No label ${label}`)
  const element = document.getElementById(labelElement.htmlFor)
  if (!(element instanceof HTMLInputElement)) throw new Error(`No input labeled ${label}`)
  return element
}

const button = (name: string) => {
  const element = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
    .find(b => b.textContent === name || b.getAttribute('aria-label') === name)
  if (!element) throw new Error(`No button ${name}`)
  return element
}

const GATEWAY: AiGatewayInfo = {
  enabled: true,
  enabledProviders: ['anthropic'],
  builtInModelIds: ['claude-opus-5-5'],
  defaultReasoning: null,
  userModelsEnabled: true,
  modelsDevSuggestions: false,
}
const OPUS: ModelDescription = {
  reasoningLevels: ['low', 'medium', 'high'],
  builtInReasoning: 'adaptive',
  builtInCompactionInputBudget: 1000000,
  maxCompactionInputBudget: 1000000,
  runtimeKnown: true,
}

const type = (element: HTMLInputElement, value: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value)
  element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }))
})

const click = (element: HTMLElement) => act(() => { element.click() })

// The model is described once it has stayed the same for a moment.
const settle = () => act(() => new Promise(resolve => setTimeout(resolve, 350)))

// The select whose shown value starts with `shown`.
const selectShowing = (shown: string) => {
  const element = Array.from(document.body.querySelectorAll<HTMLElement>('[role="combobox"]'))
    .find(select => select.textContent?.startsWith(shown))
  if (!element) throw new Error(`No select showing ${shown}`)
  return element
}

// By keyboard. The option turns Enter into a click it builds as a PointerEvent, which jsdom lacks,
// so the window has a stand-in for as long as the choice takes. The provider select is the first.
const choose = async (label: string, select = document.body.querySelector<HTMLElement>('[role="combobox"]')!) => {
  await click(select)
  const list = document.getElementById(select.getAttribute('aria-controls') ?? '')
  const option = Array.from((list ?? document.body).querySelectorAll<HTMLElement>('[role="option"]'))
    .find(element => element.textContent === label)
  if (!option) throw new Error(`No option ${label}`)
  const view: { PointerEvent?: typeof MouseEvent } = window
  view.PointerEvent = MouseEvent
  try {
    await act(async () => { option.focus() })
    await act(async () => {
      option.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
  } finally {
    delete view.PointerEvent
  }
}

describe('AddModelModal', () => {
  let root: Root | undefined

  afterEach(() => {
    act(() => root?.unmount())
    document.body.innerHTML = ''
  })

  const render = async (mode: ModelModalMode, { chatModelsOnly = false, aiConfig = { enabled: false } }: {
    chatModelsOnly?: boolean, aiConfig?: AiGatewayInfo,
  } = {}) => {
    const updateModel = vi.fn<AuthenticatedApi['updateModel']>(async () => {})
    const addModel = vi.fn<AuthenticatedApi['addModel']>(async () => {})
    const describeModel = vi.fn<AuthenticatedApi['describeModel']>(async () => OPUS)
    const testModel = vi.fn<AuthenticatedApi['testModel']>(async () => [])
    const api = { updateModel, addModel, describeModel, testModel } as unknown as RpcStub<AuthenticatedApi>
    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => root!.render(<AddModelModal
      visible
      mode={mode}
      chatModelsOnly={chatModelsOnly}
      onCancel={() => {}}
      onSuccess={() => {}}
      authenticatedApi={api}
      aiConfig={aiConfig}
    />))
    return { updateModel, addModel, describeModel, testModel }
  }

  // Describes a custom Anthropic model through AI Gateway, with Advanced Settings open.
  const describeAnthropic = async (modelId: string, name: string) => {
    await choose('Other Anthropic...')
    await type(labeledInput('Provider Model ID'), modelId)
    await type(labeledInput('Display Name'), name)
    await click(button('Advanced Settings'))
    await settle()
  }

  // Onboarding picks the user's chat model, which a decision model can't be; the Providers page adds both.
  it.each([false, true])('offers decision models only without chatModelsOnly (chatModelsOnly: %s)', async (chatModelsOnly) => {
    await render({ type: 'add' }, { chatModelsOnly })
    await click(document.body.querySelector<HTMLElement>('[role="combobox"]')!)

    const options = Array.from(document.body.querySelectorAll('[role="option"]'), option => option.textContent)
    expect(options).toContain('GLM 5.2 (Workers AI)')
    expect(options.includes('Clef (Workers AI)')).toBe(!chatModelsOnly)
  })

  it.each([false, true])('adds a decision model typed as a custom model only without chatModelsOnly (chatModelsOnly: %s)', async (chatModelsOnly) => {
    const { addModel } = await render({ type: 'add' }, { chatModelsOnly })
    await choose('Other Cloudflare Workers AI...')
    await type(labeledInput('Provider Model ID'), '@cf/cloudflare/clef')
    await type(labeledInput('Display Name'), 'Clef')
    await type(labeledInput('Cloudflare Account ID'), 'account-id')
    await type(labeledInput('API Token'), 'token')
    await click(button('Add Model'))

    expect(addModel).toHaveBeenCalledTimes(chatModelsOnly ? 0 : 1)
  })

  it('sends withheld secrets back as null when they are left untouched', async () => {
    const { updateModel } = await render({ type: 'edit', source: { profile: PROFILE, config: CONFIG } })
    expect(labeledInput('API Token').value).toBe('')
    expect(labeledInput('API Token').placeholder).toBe('********')

    await type(labeledInput('Display Name'), 'Gemma 4')
    await click(button('Save Changes'))

    expect(updateModel).toHaveBeenCalledWith(
      { ...PROFILE, name: 'Gemma 4' },
      { ...CONFIG, apiToken: null, extraHeaders: { 'X-Key': null } },
    )
  })

  it('sends a secret only once the user replaces it', async () => {
    const { updateModel } = await render({ type: 'edit', source: { profile: PROFILE, config: CONFIG } })

    const token = labeledInput('API Token')
    act(() => token.focus())
    await type(token, 'new-token')
    // The first keystroke must not swap in a different element, taking focus with it.
    expect(document.activeElement).toBe(labeledInput('API Token'))
    await click(button('Advanced Settings'))
    await type(input('input[aria-label="Header value"]'), 'new-key')
    await click(button('Save Changes'))

    expect(updateModel).toHaveBeenCalledWith(PROFILE, { ...CONFIG, apiToken: 'new-token', extraHeaders: { 'X-Key': 'new-key' } })
  })

  it('returns to keeping a stored value after starting to replace it', async () => {
    const { updateModel } = await render({ type: 'edit', source: { profile: PROFILE, config: CONFIG } })

    await type(labeledInput('API Token'), 'oops')
    await click(button('Keep stored value'))
    expect(labeledInput('API Token').placeholder).toBe('********')
    await click(button('Save Changes'))

    expect(updateModel).toHaveBeenCalledWith(PROFILE, CONFIG)
  })

  it('requires withheld header values to be re-entered once the API URL changes', async () => {
    const { updateModel } = await render({ type: 'edit', source: { profile: PROFILE, config: CONFIG } })

    await type(labeledInput('API URL'), 'https://elsewhere.example')
    expect(labeledInput('API Token').value).toBe('')
    await click(button('Save Changes'))
    expect(updateModel).not.toHaveBeenCalled()

    await type(input('input[aria-label="Header value"]'), 'key')
    await click(button('Save Changes'))
    expect(updateModel).toHaveBeenCalledWith(PROFILE, {
      ...CONFIG, apiUrl: 'https://elsewhere.example', apiToken: '', extraHeaders: { 'X-Key': 'key' },
    })
  })

  it('clones with the source as the origin of withheld secrets', async () => {
    const { addModel } = await render({ type: 'clone', source: { profile: PROFILE, config: CONFIG } })

    await type(labeledInput('Provider Model ID'), 'qwen')
    await type(labeledInput('Display Name'), 'Qwen')
    await click(button('Add Model'))

    expect(addModel).toHaveBeenCalledWith(
      { type: 'agent', id: 'qwen', name: 'Qwen' },
      { ...CONFIG, model: 'qwen' },
      PROFILE.id,
    )
  })

  it('follows the provider model ID with the ID until the ID is edited', async () => {
    const { addModel } = await render({ type: 'add' })
    await choose('Other Ollama...')
    await type(labeledInput('Provider Model ID'), 'qwen')
    expect(labeledInput('ID').value).toBe('qwen')
    await type(labeledInput('ID'), 'my-qwen')
    await type(labeledInput('Provider Model ID'), 'qwen3')
    expect(labeledInput('ID').value).toBe('my-qwen')

    await type(labeledInput('Display Name'), 'Qwen')
    await click(button('Add Model'))
    expect(addModel).toHaveBeenCalledWith(
      { type: 'agent', id: 'my-qwen', name: 'Qwen' },
      { provider: 'ollama', model: 'qwen3', apiToken: '', apiUrl: 'http://localhost:11434' },
      undefined,
    )
  })

  it('adds the user’s own version of a built-in model under its own ID, with its own settings', async () => {
    const { addModel, describeModel } = await render({ type: 'add' }, { aiConfig: GATEWAY })
    await describeAnthropic('claude-opus-5-5', 'Opus 1M')
    // What is described is the model, not the settings given to it.
    expect(describeModel).toHaveBeenLastCalledWith(
      { provider: 'anthropic', model: 'claude-opus-5-5', apiToken: '' })

    await type(labeledInput('ID'), 'opus-1m')
    await type(labeledInput('Compaction Budget'), '900000')
    expect(document.body.textContent).toContain('compacts at about 765,000 tokens')
    await choose('High', selectShowing('Deployment default'))
    await click(button('Add Model'))

    expect(addModel).toHaveBeenCalledWith(
      { type: 'agent', id: 'opus-1m', name: 'Opus 1M' },
      {
        provider: 'anthropic', model: 'claude-opus-5-5', apiToken: '',
        reasoning: 'high', compactionInputBudget: 900000,
      },
      undefined,
    )
  })

  it('refuses a built-in model’s ID, and a budget over the model’s maximum, before sending', async () => {
    const { addModel } = await render({ type: 'add' }, { aiConfig: GATEWAY })
    await describeAnthropic('claude-opus-5-5', 'Opus')
    await type(labeledInput('Compaction Budget'), '1000001')
    await click(button('Add Model'))

    expect(addModel).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('such as “claude-opus-5-5-custom”')
    expect(document.body.textContent).toContain('Please enter at most 1,000,000 tokens')

    await type(labeledInput('ID'), 'claude-opus-5-5-custom')
    await type(labeledInput('Compaction Budget'), '1000000')
    await click(button('Add Model'))
    expect(addModel).toHaveBeenCalledOnce()
  })

  it('names the deployment’s default level, or else the built-in behaviour, for no level of the model’s own', async () => {
    await render({ type: 'add' }, { aiConfig: { ...GATEWAY, defaultReasoning: 'high' } })
    await describeAnthropic('claude-opus-5-5', 'Opus')
    expect(selectShowing('Deployment default').textContent).toBe('Deployment default (High)')
    act(() => root?.unmount())
    document.body.innerHTML = ''

    await render({ type: 'add' }, { aiConfig: GATEWAY })
    await describeAnthropic('claude-opus-5-5', 'Opus')
    expect(selectShowing('Deployment default').textContent)
      .toBe('Deployment default (built-in: Provider default)')
  })

  it('prefills an edit with the model’s own settings, and keeps them', async () => {
    const config: RedactedAiModelConfig = {
      provider: 'anthropic', model: 'claude-opus-5-5', apiToken: '',
      reasoning: 'low', compactionInputBudget: 500000,
    }
    const profile = { type: 'agent' as const, id: 'opus-1m', name: 'Opus 1M' }
    const { updateModel } = await render(
      { type: 'edit', source: { profile, config } }, { aiConfig: GATEWAY })
    await click(button('Advanced Settings'))
    await settle()

    expect(labeledInput('ID').value).toBe('opus-1m')
    expect(labeledInput('ID').disabled).toBe(true)
    expect(labeledInput('Compaction Budget').value).toBe('500000')
    expect(selectShowing('Low')).toBeTruthy()
    await click(button('Save Changes'))
    expect(updateModel).toHaveBeenCalledWith(profile, config)
  })

  it('offers the settings that only AI Gateway runs, and the test, only in AI Gateway mode', async () => {
    const { describeModel } = await render({ type: 'add' })
    await choose('Other Ollama...')
    await type(labeledInput('Provider Model ID'), 'qwen')
    await click(button('Advanced Settings'))
    await settle()

    expect(document.body.textContent).not.toContain('Compaction Budget')
    expect(document.body.textContent).not.toContain('Reasoning level')
    expect(() => button('Test this model')).toThrow('No button Test this model')
    expect(describeModel).not.toHaveBeenCalled()
  })

  it('tests the model as described, and shows what each level answered', async () => {
    const { testModel } = await render({ type: 'add' }, { aiConfig: GATEWAY })
    const results: GatewayModelLevelTest[] = [
      { model: 'claude-opus-5-5', ok: true, reasoning: null },
      { model: 'claude-opus-5-5', ok: false, status: 401, message: 'Unauthorized', reasoning: 'high' },
    ]
    testModel.mockResolvedValue(results)
    await describeAnthropic('claude-opus-5-5', 'Opus 1M')
    await type(labeledInput('ID'), 'opus-1m')
    await click(button('Test this model'))

    expect(testModel).toHaveBeenCalledWith(
      { provider: 'anthropic', model: 'claude-opus-5-5', apiToken: '' })
    const status = Array.from(document.body.querySelectorAll('[role="status"]'))
      .map(region => region.textContent).join('')
    expect(status).toContain('As chats ask: Answered through the gateway.')
    expect(status).toContain('High: Failed (401): Unauthorized')
    // The deployment's settings are an admin's to change, so a user is not pointed at them.
    expect(status).not.toContain('CF_AI_GATEWAY_API_TOKEN')

    // A result is of the model as it was described.
    await type(labeledInput('Compaction Budget'), '500000')
    expect(document.body.textContent).not.toContain('Answered through the gateway.')
  })

  describe('suggestions from models.dev', () => {
    const MODELS_DEV = {
      anthropic: {
        models: {
          'claude-opus-5-5': {
            id: 'claude-opus-5-5', name: 'Claude Opus 5.5', tool_call: true,
            modalities: { input: ['text', 'image'], output: ['text'] },
            limit: { context: 1000000, output: 128000 },
          },
        },
      },
    }

    afterEach(() => vi.unstubAllGlobals())

    it.each([false, true])('are offered only while the deployment allows them (allowed: %s)', async (allowed) => {
      const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify(MODELS_DEV)))
      vi.stubGlobal('fetch', fetch)
      await render({ type: 'add' }, { aiConfig: { ...GATEWAY, modelsDevSuggestions: allowed } })
      await choose('Other Anthropic...')
      const modelId = labeledInput('Provider Model ID')
      await act(async () => { modelId.focus() })

      expect(modelId.getAttribute('role') === 'combobox').toBe(allowed)
      expect(fetch).toHaveBeenCalledTimes(allowed ? 1 : 0)
    })

    it('fill the form in from a pick, the built-in model included', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(MODELS_DEV))))
      const { addModel } = await render({ type: 'add' }, { aiConfig: { ...GATEWAY, modelsDevSuggestions: true } })
      await choose('Other Anthropic...')
      const modelId = labeledInput('Provider Model ID')
      await act(async () => { modelId.focus() })
      await settle()
      await type(modelId, 'opus')
      const list = document.getElementById(modelId.getAttribute('aria-controls') ?? '')
      await click(list!.querySelector<HTMLElement>('[role="option"]')!)

      expect(labeledInput('Display Name').value).toBe('Claude Opus 5.5')
      await click(button('Advanced Settings'))
      expect(labeledInput('Context Window').value).toBe('1000000')
      expect(labeledInput('Output Limit').value).toBe('128000')
      await type(labeledInput('ID'), 'opus-mine')
      await click(button('Add Model'))
      expect(addModel).toHaveBeenCalledWith(
        { type: 'agent', id: 'opus-mine', name: 'Claude Opus 5.5' },
        expect.objectContaining({ model: 'claude-opus-5-5', contextWindow: 1000000, outputLimit: 128000 }),
        undefined,
      )
    })
  })
})
