// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ComponentProps, type ReactElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type {
  AiChatAuthorInfo,
  AuthenticatedApi,
  CollaboratorInfo,
  CollaboratorRole,
  GadgetMetadata,
  GatekeeperVendorInfo,
  ObserverBindingNeed,
  Overseer,
  ServerConfig,
  ShareLinkInfo,
  UserDirectoryRecord,
} from '@gadgets/workshop-shared/api'
import { ServerConfigContext } from './ServerConfigContext'

const toastAdd = vi.hoisted(() => vi.fn<(toast: unknown) => void>())

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  if (previousActEnvironment === undefined) delete testGlobal.IS_REACT_ACT_ENVIRONMENT
  else testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

const previousScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView')
Object.defineProperty(Element.prototype, 'scrollIntoView', {
  configurable: true,
  value: vi.fn<Element['scrollIntoView']>(),
})
afterAll(() => {
  if (previousScrollIntoView) {
    Object.defineProperty(Element.prototype, 'scrollIntoView', previousScrollIntoView)
  } else {
    Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
  }
})

vi.mock('@cloudflare/kumo', async (importOriginal) => {
  const { InputGroup } = await importOriginal<typeof import('@cloudflare/kumo')>()
  const Dialog = Object.assign(
    ({ children }: { children: ReactNode }) => <dialog open>{children}</dialog>,
    {
      Root: ({ children }: { children: ReactNode }) => <>{children}</>,
      Title: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
      Description: ({ children }: { children: ReactNode }) => <p>{children}</p>,
      Close: ({ render }: { render: (props: object) => ReactElement }) =>
        render({ 'aria-label': 'Close' }),
    },
  )
  const DropdownMenu = Object.assign(
    ({ children }: { children: ReactNode }) => <div>{children}</div>,
    {
      Trigger: ({ render }: { render: ReactElement }) => render,
      Content: ({ children }: { children: ReactNode }) => <div>{children}</div>,
      Item: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
        <button type="button" data-testid="role-option" onClick={onClick}>{children}</button>
      ),
    },
  )
  return {
    Button: ({ children, variant: _variant, size: _size, ...props }: ComponentProps<'button'> & { variant?: string; size?: string }) => (
      <button type="button" {...props}>{children}</button>
    ),
    InputGroup,
    Checkbox: ({ label }: { label: ReactNode }) => <label>{label}</label>,
    Dialog,
    DropdownMenu,
    useKumoToastManager: () => ({ add: toastAdd }),
  }
})

vi.mock('./components/WorkshopControls', () => ({
  WorkshopButton: ({ children, ...props }: ComponentProps<'button'>) => (
    <button type="button" {...props}>{children}</button>
  ),
  WorkshopIconButton: ({ children, ...props }: ComponentProps<'button'>) => (
    <button type="button" {...props}>{children}</button>
  ),
}))

vi.mock('./components/PersonAvatar', () => ({
  PersonAvatar: () => <span data-testid="avatar" />,
}))

const copyToClipboard = vi.fn<(text: string) => Promise<boolean>>(async () => true)
vi.mock('./clipboard', () => ({ copyToClipboard: (text: string) => copyToClipboard(text) }))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

import ShareModal from './ShareModal'

const METADATA = { id: 'trip-planner', title: 'Trip planner' } as GadgetMetadata
const WORKSPACE_URL = `${window.location.origin}/workspace/trip-planner`

const CURRENT_USER: AiChatAuthorInfo = { type: 'user', id: 'dan@cloudflare.com', name: 'Dan' }

const DOC_REQUIREMENT: ObserverBindingNeed = {
  gatekeeperId: 7,
  vendorId: 'google',
  resourceTitle: 'Q3 planning',
  resourceUrl: 'https://docs.google.com/document/d/quarterly',
}

const CRM_REQUIREMENT: ObserverBindingNeed = {
  gatekeeperId: 8,
  vendorId: 'salesforce',
  resourceTitle: 'Pipeline dashboard',
}

const SHARE_LINK: ShareLinkInfo = {
  linkId: 'link-1',
  note: 'Team link',
  created: new Date('2026-08-01T00:00:00Z'),
  createdBy: CURRENT_USER,
  role: 'use',
}

type OverseerOverrides = {
  requirements?: Partial<Record<CollaboratorRole, ObserverBindingNeed[]>>
  listObserverRequirements?: (role: CollaboratorRole) => Promise<ObserverBindingNeed[]>
  collaborators?: CollaboratorInfo[]
  listCollaborators?: () => Promise<CollaboratorInfo[]>
  shareLinks?: ShareLinkInfo[]
  previewRevokeShareLink?: Overseer['previewRevokeShareLink']
  revokeShareLink?: Overseer['revokeShareLink']
  addCollaborator?: (
    userId: string,
    role: CollaboratorRole,
    note?: string,
  ) => Promise<CollaboratorInfo | null>
}

function fakeOverseer(overrides: OverseerOverrides = {}): RpcStub<Overseer> {
  const requirements = overrides.requirements ?? { use: [], build: [] }
  return {
    listCollaborators: overrides.listCollaborators ?? (async () => overrides.collaborators ?? []),
    listShareLinks: async () => overrides.shareLinks ?? [],
    listObserverRequirements:
      overrides.listObserverRequirements ??
      (async (role: CollaboratorRole) => requirements[role] ?? []),
    addCollaborator: overrides.addCollaborator ?? (async () => ({
      profile: { type: 'user', id: 'ada@cloudflare.com', name: 'Ada' },
      role: 'use',
      addedBy: [],
    })),
    createShareLink: async () => ({ key: 'secret', linkId: 'link-1' }),
    previewRevokeShareLink: overrides.previewRevokeShareLink ?? (async () => []),
    revokeShareLink: overrides.revokeShareLink ?? (async () => []),
  } as unknown as RpcStub<Overseer>
}

type AuthenticatedApiOverrides = {
  searchUsers?: (query: string, excludeIds: string[]) => Promise<UserDirectoryRecord[]>
  listGatekeeperVendors?: () => Promise<GatekeeperVendorInfo[]>
}

function fakeAuthenticatedApi(overrides: AuthenticatedApiOverrides = {}): RpcStub<AuthenticatedApi> {
  return {
    listGatekeeperVendors: async () => [],
    listAddableGatekeepers: async () => [],
    searchUsers: async (query: string, _excludeIds: string[]) => query ? [{
      id: `${query}@example.com`,
      name: query === 'ada' ? 'Ada' : query,
    }] : [],
    ...overrides,
  } as unknown as RpcStub<AuthenticatedApi>
}

function click(element: Element) {
  return act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

function button(rendered: HTMLElement, label: string): HTMLButtonElement {
  const found = [...rendered.querySelectorAll('button')].find(candidate =>
    candidate.textContent?.trim() === label || candidate.getAttribute('aria-label') === label)
  if (!found) throw new Error(`No button labelled “${label}”`)
  return found
}

function roleOption(rendered: HTMLElement, label: string): HTMLButtonElement {
  const found = [...rendered.querySelectorAll<HTMLButtonElement>('[data-testid="role-option"]')]
    .find(candidate => candidate.textContent?.startsWith(label))
  if (!found) throw new Error(`No role option for “${label}”`)
  return found
}

// Types into the people field and waits out the search debounce (200ms), so a directory lookup
// -- or the absence of one -- has had its chance to happen.
async function typeInto(input: HTMLInputElement, query: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  vi.useFakeTimers()
  try {
    await act(async () => {
      setValue.call(input, query)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => vi.advanceTimersByTimeAsync(225))
  } finally {
    vi.useRealTimers()
  }
}

async function typeDirectorySearch(rendered: HTMLElement, query: string) {
  await typeInto(rendered.querySelector<HTMLInputElement>('input[aria-label="Search people"]')!, query)
}

async function invite(rendered: HTMLElement, username: string) {
  await typeDirectorySearch(rendered, username)
  const option = rendered.querySelector<HTMLButtonElement>('[role="option"]')
  if (!option) throw new Error('Expected a directory search result.')
  await click(option)
}

function peopleInput(rendered: HTMLElement): HTMLInputElement {
  return rendered.querySelector<HTMLInputElement>('input[aria-label="Search people"]')!
}

function pressKey(input: HTMLInputElement, key: string) {
  return act(async () => input.dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
  ))
}

function profileFor(userId: string, role: CollaboratorRole, name: string): CollaboratorInfo {
  return { profile: { type: 'user', id: userId, name }, role, addedBy: [] }
}

// jsdom has no ResizeObserver; the stub records each observer so a test can fire its callback
// and check it was disconnected.
type RecordedResizeObserver = { targets: Element[]; callback: () => void; disconnect: ReturnType<typeof vi.fn<() => void>> }
const resizeObservers: RecordedResizeObserver[] = []

describe('ShareModal', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  beforeEach(() => {
    copyToClipboard.mockClear()
    toastAdd.mockClear()
    resizeObservers.length = 0
    vi.stubGlobal('ResizeObserver', class {
      readonly #record: RecordedResizeObserver
      constructor(callback: () => void) {
        this.#record = { targets: [], callback, disconnect: vi.fn<() => void>() }
        resizeObservers.push(this.#record)
      }
      observe(target: Element) { this.#record.targets.push(target) }
      disconnect() { this.#record.disconnect() }
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    act(() => root?.unmount())
    container?.remove()
    root = undefined
    container = undefined
  })

  // The last rendered tree, parameterised on `open` so a test can close and reopen the dialog the
  // way its parent would (the component stays mounted either way), and on the metadata so a test
  // can deliver a live update.
  let renderTree: (open: boolean, metadata?: GadgetMetadata) => ReactNode

  async function render(
    overseer: RpcStub<Overseer>,
    authenticatedApi = fakeAuthenticatedApi(),
    metadata: GadgetMetadata = METADATA,
    { userSearchEnabled = true } = {},
  ) {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    const serverConfig = { userSearchEnabled } as ServerConfig
    renderTree = (open, currentMetadata = metadata) => (
      <ServerConfigContext.Provider value={serverConfig}>
        <ShareModal
          open={open}
          onClose={() => {}}
          overseer={overseer}
          metadata={currentMetadata}
          currentUser={CURRENT_USER}
          authenticatedApi={authenticatedApi}
        />
      </ServerConfigContext.Provider>
    )
    await act(async () => { root!.render(renderTree(true)) })
    // Let the load effects settle.
    await act(async () => { await Promise.resolve() })
    return document.body
  }

  async function setOpen(open: boolean) {
    await act(async () => { root!.render(renderTree(open)) })
    await act(async () => { await Promise.resolve() })
  }

  async function updateMetadata(metadata: GadgetMetadata) {
    await act(async () => { root!.render(renderTree(true, metadata)) })
  }

  it('keeps the workspace link available after a direct invite', async () => {
    const rendered = await render(fakeOverseer())
    expect(rendered.textContent).not.toContain(WORKSPACE_URL)

    await invite(rendered, 'ada')

    expect(toastAdd).toHaveBeenCalledWith({ title: 'Added Ada as a collaborator.', variant: 'success' })
    expect(button(rendered, 'Copy link')).toBeDefined()
  })

  it('keeps Invite disabled until a recipient can be submitted', async () => {
    const rendered = await render(fakeOverseer())
    expect(button(rendered, 'Invite').disabled).toBe(true)

    await invite(rendered, 'ada')
    expect(button(rendered, 'Invite').disabled).toBe(true)
  })

  it('copies the plain workspace link, never a share-link secret', async () => {
    const rendered = await render(fakeOverseer())
    await invite(rendered, 'ada')

    await click(button(rendered, 'Copy link'))

    expect(copyToClipboard).toHaveBeenCalledWith(WORKSPACE_URL)
    expect(button(rendered, 'Copied')).toBeDefined()
  })

  it('excludes existing people and submits the selected directory result id', async () => {
    const addCollaborator = vi.fn<(
      userId: string,
      role: CollaboratorRole,
      note?: string,
    ) => Promise<CollaboratorInfo | null>>(async (userId, role) => ({
      profile: { type: 'user' as const, id: userId, name: 'Ada Lovelace' },
      role,
      addedBy: [],
    }))
    const existingCollaborator: CollaboratorInfo = {
      profile: { type: 'user', id: 'maximo@cloudflare.com', name: 'maximo' },
      role: 'use',
      addedBy: [],
    }
    const searchUsers = vi.fn<(
      query: string,
      excludeIds: string[],
    ) => Promise<UserDirectoryRecord[]>>(async () => [
      { id: 'ada@cloudflare.com', name: 'Ada Lovelace' },
    ])
    const rendered = await render(
      fakeOverseer({ addCollaborator, collaborators: [existingCollaborator] }),
      fakeAuthenticatedApi({ searchUsers }),
    )

    await typeDirectorySearch(rendered, 'love')
    expect(searchUsers).toHaveBeenCalledWith('love', [
      'dan@cloudflare.com',
      'maximo@cloudflare.com',
    ])
    expect(rendered.textContent).toContain('Ada Lovelace')
    expect(rendered.textContent).toContain('ada@cloudflare.com')

    const option = rendered.querySelector<HTMLButtonElement>('[role="option"]')!
    const mouseDown = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    await act(async () => option.dispatchEvent(mouseDown))
    expect(mouseDown.defaultPrevented).toBe(true)
    await act(async () => {
      option.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
      option.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    // Picking a result immediately invites that account and clears the field for the next name.
    expect(peopleInput(rendered).value).toBe('')

    expect(addCollaborator).toHaveBeenCalledWith('ada@cloudflare.com', 'use', undefined)
    expect(addCollaborator).toHaveBeenCalledTimes(1)
  })

  it('submits the highlighted result from the primary Invite action', async () => {
    const addCollaborator = vi.fn<NonNullable<OverseerOverrides['addCollaborator']>>(async (userId, role) => ({
      profile: { type: 'user' as const, id: userId, name: 'Ada Lovelace' },
      role,
      addedBy: [],
    }))
    const rendered = await render(
      fakeOverseer({ addCollaborator }),
      fakeAuthenticatedApi({
        searchUsers: async () => [{ id: 'ada@cloudflare.com', name: 'Ada Lovelace' }],
      }),
    )

    await typeDirectorySearch(rendered, 'ada')
    expect(rendered.querySelector('[role="option"][aria-selected="true"]')?.textContent)
      .toContain('Ada Lovelace')
    await click(button(rendered, 'Invite'))

    expect(addCollaborator).toHaveBeenCalledWith('ada@cloudflare.com', 'use', undefined)
  })

  it('excludes the workspace owner when the caller is a collaborator', async () => {
    const searchUsers = vi.fn<(
      query: string,
      excludeIds: string[],
    ) => Promise<UserDirectoryRecord[]>>(async () => [])
    const rendered = await render(
      fakeOverseer(),
      fakeAuthenticatedApi({ searchUsers }),
      { ...METADATA, owner: { type: 'user', id: 'owner@cloudflare.com', name: 'Owner' } } as GadgetMetadata,
    )

    await typeDirectorySearch(rendered, 'own')
    expect(searchUsers).toHaveBeenCalledWith('own', ['dan@cloudflare.com', 'owner@cloudflare.com'])
  })

  it('waits for the membership list before searching', async () => {
    const membership = deferred<CollaboratorInfo[]>()
    const existingCollaborator: CollaboratorInfo = {
      profile: { type: 'user', id: 'maximo@cloudflare.com', name: 'Maximo' },
      role: 'use',
      addedBy: [],
    }
    const searchUsers = vi.fn<NonNullable<AuthenticatedApiOverrides['searchUsers']>>(async () => [])
    const rendered = await render(
      fakeOverseer({ listCollaborators: () => membership.promise }),
      fakeAuthenticatedApi({ searchUsers }),
    )

    await typeDirectorySearch(rendered, 'ada')
    expect(searchUsers).not.toHaveBeenCalled()
    expect(button(rendered, 'Invite').disabled).toBe(true)

    vi.useFakeTimers()
    try {
      await act(async () => {
        membership.resolve([existingCollaborator])
        await Promise.resolve()
        await Promise.resolve()
      })
      await act(async () => vi.advanceTimersByTimeAsync(225))
    } finally {
      vi.useRealTimers()
    }

    expect(searchUsers).toHaveBeenCalledWith('ada', [
      'dan@cloudflare.com',
      'maximo@cloudflare.com',
    ])
  })

  it('submits a typed exact id when the directory has not indexed the account', async () => {
    const addCollaborator = vi.fn<(
      userId: string,
      role: CollaboratorRole,
      note?: string,
    ) => Promise<CollaboratorInfo | null>>(async (userId, role) => ({
      profile: { type: 'user' as const, id: userId, name: 'Dormant User' },
      role,
      addedBy: [],
    }))
    const rendered = await render(
      fakeOverseer({ addCollaborator }),
      fakeAuthenticatedApi({ searchUsers: async () => [] }),
    )

    await typeDirectorySearch(rendered, 'dormant@example.com')
    expect(rendered.textContent).toContain('No users found.')
    const input = peopleInput(rendered)
    await pressKey(input, 'Enter')
    expect(addCollaborator).toHaveBeenCalledWith('dormant@example.com', 'use', undefined)
    expect(addCollaborator).toHaveBeenCalledTimes(1)
  })

  it('clears the field and restores focus after inviting a typed id', async () => {
    const rendered = await render(
      fakeOverseer(),
      fakeAuthenticatedApi({ searchUsers: async () => [] }),
    )

    await typeDirectorySearch(rendered, 'dormant@example.com')
    await pressKey(peopleInput(rendered), 'Enter')

    expect(peopleInput(rendered).value).toBe('')
    expect(document.activeElement).toBe(peopleInput(rendered))
    expect(rendered.querySelector('[role="listbox"]')).toBeNull()
  })

  it('never queries the directory and invites by exact id when user search is off', async () => {
    const addCollaborator = vi.fn<(
      userId: string,
      role: CollaboratorRole,
      note?: string,
    ) => Promise<CollaboratorInfo | null>>(async (userId, role) => ({
      profile: { type: 'user' as const, id: userId, name: 'Grace Hopper' },
      role,
      addedBy: [],
    }))
    const searchUsers = vi.fn<(
      query: string,
      excludeIds: string[],
    ) => Promise<UserDirectoryRecord[]>>(async () => [
      { id: 'grace@example.com', name: 'Grace Hopper' },
    ])
    const rendered = await render(
      fakeOverseer({ addCollaborator }),
      fakeAuthenticatedApi({ searchUsers }),
      METADATA,
      { userSearchEnabled: false },
    )

    expect(rendered.querySelector('input[aria-label="Search people"]')).toBeNull()
    const input = rendered.querySelector<HTMLInputElement>('input[aria-label="Username or email"]')!
    expect(input.getAttribute('role')).toBeNull()
    expect(button(rendered, 'Invite').disabled).toBe(true)

    await typeInto(input, 'grace@example.com')

    expect(searchUsers).not.toHaveBeenCalled()
    expect(rendered.querySelector('[role="listbox"]')).toBeNull()
    expect(button(rendered, 'Invite').disabled).toBe(false)
    await click(button(rendered, 'Invite'))

    expect(addCollaborator).toHaveBeenCalledWith('grace@example.com', 'use', undefined)
    expect(toastAdd).toHaveBeenCalledWith({ title: 'Added Grace Hopper as a collaborator.', variant: 'success' })
  })

  it('distinguishes directory accounts with the same display name', async () => {
    const addCollaborator = vi.fn<NonNullable<OverseerOverrides['addCollaborator']>>(
      async (userId, role) => profileFor(userId, role, 'Alex Smith'))
    const rendered = await render(fakeOverseer({ addCollaborator }), fakeAuthenticatedApi({
      searchUsers: async (_query, excludeIds) => [
        { id: 'alex.smith@example.com', name: 'Alex Smith' },
        { id: 'alex.smith2@example.com', name: 'Alex Smith' },
      ].filter(user => !excludeIds.includes(user.id)),
    }))

    await typeDirectorySearch(rendered, 'alex')
    expect(rendered.textContent).toContain('alex.smith@example.com')
    expect(rendered.textContent).toContain('alex.smith2@example.com')
    await click(rendered.querySelectorAll<HTMLButtonElement>('[role="option"]')[1])
    expect(addCollaborator).toHaveBeenCalledWith('alex.smith2@example.com', 'use', undefined)
  })

  it('does not submit a raw query while search is pending', async () => {
    const pending = deferred<UserDirectoryRecord[]>()
    const addCollaborator = vi.fn<NonNullable<OverseerOverrides['addCollaborator']>>(
      async (userId, role) => profileFor(userId, role, 'Alex Smith'))
    const rendered = await render(
      fakeOverseer({ addCollaborator }),
      fakeAuthenticatedApi({ searchUsers: async () => pending.promise }),
    )

    await typeDirectorySearch(rendered, 'alex')
    const input = rendered.querySelector<HTMLInputElement>('input[aria-label="Search people"]')!
    expect(button(rendered, 'Invite').disabled).toBe(true)
    await act(async () => input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    ))
    expect(addCollaborator).not.toHaveBeenCalled()

    await act(async () => {
      pending.resolve([{ id: 'alex.smith@example.com', name: 'Alex Smith' }])
      await Promise.resolve()
    })
    // Enter invites the highlighted match rather than submitting the raw text.
    await act(async () => input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    ))
    expect(peopleInput(rendered).value).toBe('')
    expect(addCollaborator).toHaveBeenCalledWith('alex.smith@example.com', 'use', undefined)
  })

  it('waits for the next search after inviting one person', async () => {
    const pending = deferred<UserDirectoryRecord[]>()
    const addCollaborator = vi.fn<NonNullable<OverseerOverrides['addCollaborator']>>(
      async (userId, role) => profileFor(userId, role, userId))
    const rendered = await render(
      fakeOverseer({ addCollaborator }),
      fakeAuthenticatedApi({
        searchUsers: async query => query === 'grace' ? pending.promise : [],
      }),
    )
    const input = peopleInput(rendered)

    await typeDirectorySearch(rendered, 'ada@example.com')
    await pressKey(input, 'Enter')
    expect(addCollaborator).toHaveBeenCalledTimes(1)

    await typeDirectorySearch(rendered, 'grace')
    expect(button(rendered, 'Invite').disabled).toBe(true)
    await click(button(rendered, 'Invite'))
    expect(addCollaborator).toHaveBeenCalledTimes(1)

    await act(async () => {
      pending.resolve([])
      await Promise.resolve()
    })
    expect(button(rendered, 'Invite').disabled).toBe(false)
    await click(button(rendered, 'Invite'))
    expect(addCollaborator.mock.calls.map(([userId]) => userId)).toEqual(['ada@example.com', 'grace'])
  })

  it('still invites the typed canonical id when unrelated users match it', async () => {
    const addCollaborator = vi.fn<NonNullable<OverseerOverrides['addCollaborator']>>(async (userId, role) => ({
      profile: { type: 'user' as const, id: userId, name: 'Alex' },
      role,
      addedBy: [],
    }))
    const rendered = await render(
      fakeOverseer({ addCollaborator }),
      fakeAuthenticatedApi({ searchUsers: async () => [{ id: 'alexander@example.com', name: 'Alexander' }] }),
    )

    // The directory is backfilled lazily, so "alex" may be a real account it has not indexed yet.
    await typeDirectorySearch(rendered, 'alex')
    expect(rendered.textContent).toContain('Alexander')
    const exactOption = [...rendered.querySelectorAll<HTMLButtonElement>('[role="option"]')]
      .find(option => option.textContent?.includes('Add “alex” exactly'))
    expect(exactOption).toBeDefined()
    await click(exactOption!)
    expect(addCollaborator).toHaveBeenCalledWith('alex', 'use', undefined)
  })

  it('falls back to a direct invite when the directory lookup fails', async () => {
    const addCollaborator = vi.fn<NonNullable<OverseerOverrides['addCollaborator']>>(async (userId, role) => ({
      profile: { type: 'user' as const, id: userId, name: 'Dormant User' },
      role,
      addedBy: [],
    }))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const rendered = await render(
      fakeOverseer({ addCollaborator }),
      fakeAuthenticatedApi({ searchUsers: async () => { throw new Error('offline') } }),
    )

    await typeDirectorySearch(rendered, 'dormant@example.com')
    expect(rendered.textContent).toContain('User search is temporarily unavailable.')
    expect(button(rendered, 'Invite').disabled).toBe(false)
    const input = peopleInput(rendered)
    await pressKey(input, 'Enter')
    await pressKey(input, 'Enter')
    expect(addCollaborator).toHaveBeenCalledWith('dormant@example.com', 'use', undefined)
    consoleError.mockRestore()
  })

  it('hides the result popover on blur or Escape and keeps the query', async () => {
    const addCollaborator = vi.fn<NonNullable<OverseerOverrides['addCollaborator']>>(async (userId, role) => ({
      profile: { type: 'user' as const, id: userId, name: 'Alex' },
      role,
      addedBy: [],
    }))
    const rendered = await render(
      fakeOverseer({ addCollaborator }),
      fakeAuthenticatedApi({ searchUsers: async () => [{ id: 'alexander@example.com', name: 'Alexander' }] }),
    )
    const input = rendered.querySelector<HTMLInputElement>('input[aria-label="Search people"]')!
    const listbox = () => rendered.querySelector('[role="listbox"]')

    await typeDirectorySearch(rendered, 'alex')
    expect(listbox()).not.toBeNull()
    expect(input.getAttribute('aria-expanded')).toBe('true')

    // Tabbing on to the role picker or Invite button must not leave the list covering them.
    await act(async () => input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
    expect(listbox()).toBeNull()
    expect(input.getAttribute('aria-expanded')).toBe('false')
    expect(input.getAttribute('aria-activedescendant')).toBeNull()
    expect(input.value).toBe('alex')
    expect(button(rendered, 'Invite').disabled).toBe(false)

    await act(async () => input.dispatchEvent(new FocusEvent('focusin', { bubbles: true })))
    expect(listbox()).not.toBeNull()

    // Escape closes the popover without reaching the dialog, and Enter then submits the typed id.
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    const dialogSawEscape = vi.fn<(event: Event) => void>()
    document.addEventListener('keydown', dialogSawEscape)
    try {
      await act(async () => input.dispatchEvent(escape))
    } finally {
      document.removeEventListener('keydown', dialogSawEscape)
    }
    expect(escape.defaultPrevented).toBe(true)
    expect(dialogSawEscape).not.toHaveBeenCalled()
    expect(listbox()).toBeNull()
    await pressKey(input, 'Enter')
    expect(addCollaborator).toHaveBeenCalledWith('alex', 'use', undefined)

    // Arrow keys reopen the list instead of moving a hidden highlight.
    await typeDirectorySearch(rendered, 'alex')
    await pressKey(peopleInput(rendered), 'Escape')
    expect(listbox()).toBeNull()
    await pressKey(peopleInput(rendered), 'ArrowDown')
    expect(listbox()).not.toBeNull()
    expect(peopleInput(rendered).getAttribute('aria-activedescendant'))
      .toBe(`${peopleInput(rendered).getAttribute('aria-controls')}-option-0`)
  })

  it('repositions directory results when the composer is resized', async () => {
    const rendered = await render(
      fakeOverseer(),
      fakeAuthenticatedApi({ searchUsers: async () => [{ id: 'grace@example.com', name: 'Grace' }] }),
    )
    const input = peopleInput(rendered)
    const composer = rendered.querySelector<HTMLElement>('[data-testid="people-composer"]')!

    await typeDirectorySearch(rendered, 'grace')
    const listbox = rendered.querySelector<HTMLElement>('[role="listbox"]')!
    const observer = resizeObservers.find(candidate => candidate.targets.includes(composer))
    expect(observer).toBeDefined()

    composer.getBoundingClientRect = () =>
      ({ top: 80, bottom: 120, left: 0, right: 300, width: 300, height: 40 }) as DOMRect
    await act(async () => observer!.callback())
    expect(listbox.style.top).toBe('128px')
    expect(listbox.style.width).toBe('300px')

    await pressKey(input, 'Escape')
    expect(rendered.querySelector('[role="listbox"]')).toBeNull()
    expect(observer!.disconnect).toHaveBeenCalled()
  })

  it('ignores stale searches and selects the highlighted result with Enter', async () => {
    const first = deferred<UserDirectoryRecord[]>()
    const second = deferred<UserDirectoryRecord[]>()
    const searchUsers = vi.fn<(
      query: string,
      excludeIds: string[],
    ) => Promise<UserDirectoryRecord[]>>(
      query => query === 'ada' ? first.promise : second.promise,
    )
    const addCollaborator = vi.fn<NonNullable<OverseerOverrides['addCollaborator']>>(
      async (userId, role) => profileFor(userId, role, 'Grace Hopper'))
    const rendered = await render(
      fakeOverseer({ addCollaborator }),
      fakeAuthenticatedApi({ searchUsers }),
    )

    await typeDirectorySearch(rendered, 'ada')
    await typeDirectorySearch(rendered, 'grace')
    await act(async () => {
      second.resolve([{ id: 'grace@example.com', name: 'Grace Hopper' }])
      await Promise.resolve()
    })
    expect(rendered.textContent).toContain('Grace Hopper')

    await act(async () => {
      first.resolve([{ id: 'ada@example.com', name: 'Ada Lovelace' }])
      await Promise.resolve()
    })
    expect(rendered.textContent).not.toContain('Ada Lovelace')

    const input = peopleInput(rendered)
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    expect(addCollaborator).toHaveBeenCalledWith('grace@example.com', 'use', undefined)
    expect(peopleInput(rendered).value).toBe('')
  })

  it('invites people one by one and refreshes membership after each addition', async () => {
    const addCollaborator = vi.fn<NonNullable<OverseerOverrides['addCollaborator']>>(
      async (userId, role) => profileFor(userId, role,
        userId === 'ada@example.com' ? 'Ada Lovelace' : 'Grace Hopper'))
    const listCollaborators = vi.fn<() => Promise<CollaboratorInfo[]>>(async () =>
      addCollaborator.mock.calls.map(([userId, role]) => profileFor(userId, role, userId)))
    const searchUsers = vi.fn<NonNullable<AuthenticatedApiOverrides['searchUsers']>>(
      async query => query === 'ada' ? [{ id: 'ada@example.com', name: 'Ada Lovelace' }] : [])
    const rendered = await render(
      fakeOverseer({ addCollaborator, listCollaborators }),
      fakeAuthenticatedApi({ searchUsers }),
    )
    const loadsBefore = listCollaborators.mock.calls.length

    await typeDirectorySearch(rendered, 'ada')
    await click(rendered.querySelector<HTMLButtonElement>('[role="option"]')!)
    await typeDirectorySearch(rendered, 'grace@example.com')
    // The person just invited is now excluded from directory results.
    expect(searchUsers).toHaveBeenLastCalledWith('grace@example.com', ['dan@cloudflare.com', 'ada@example.com'])
    await pressKey(peopleInput(rendered), 'Enter')

    expect(addCollaborator).toHaveBeenCalledTimes(2)
    expect(addCollaborator).toHaveBeenCalledWith('ada@example.com', 'use', undefined)
    expect(addCollaborator).toHaveBeenCalledWith('grace@example.com', 'use', undefined)
    expect(listCollaborators).toHaveBeenCalledTimes(loadsBefore + 2)
    expect(peopleInput(rendered).value).toBe('')
    expect(toastAdd).toHaveBeenCalledWith({
      title: 'Added Grace Hopper as a collaborator.',
      variant: 'success',
    })
  })

  it('uses the selected role for each individual invitation', async () => {
    const addCollaborator = vi.fn<NonNullable<OverseerOverrides['addCollaborator']>>(
      async (userId, role) => profileFor(userId, role, userId))
    const rendered = await render(
      fakeOverseer({ addCollaborator }),
      fakeAuthenticatedApi({ searchUsers: async () => [] }),
    )

    await typeDirectorySearch(rendered, 'ada@example.com')
    await pressKey(peopleInput(rendered), 'Enter')
    expect(button(rendered, 'Invite').disabled).toBe(true)
    await click(roleOption(rendered, 'Workspace'))
    await typeDirectorySearch(rendered, 'grace@example.com')

    await click(button(rendered, 'Invite'))

    expect(addCollaborator).toHaveBeenCalledWith('ada@example.com', 'use', undefined)
    expect(addCollaborator).toHaveBeenCalledWith('grace@example.com', 'build', undefined)
  })

  it('blocks duplicate submissions while an invitation is pending', async () => {
    const pending = deferred<CollaboratorInfo | null>()
    const addCollaborator = vi.fn<NonNullable<OverseerOverrides['addCollaborator']>>(
      (userId, role) => userId === 'ada@example.com'
        ? pending.promise
        : Promise.resolve(profileFor(userId, role, 'Grace Hopper')))
    const rendered = await render(
      fakeOverseer({ addCollaborator }),
      fakeAuthenticatedApi({ searchUsers: async () => [] }),
    )
    const input = peopleInput(rendered)

    await typeDirectorySearch(rendered, 'ada@example.com')
    await pressKey(input, 'Enter')
    await pressKey(input, 'Enter')
    expect(addCollaborator).toHaveBeenCalledTimes(1)
    expect(button(rendered, 'Inviting…').disabled).toBe(true)

    expect(input.readOnly).toBe(true)
    await pressKey(input, 'Enter')
    await click(button(rendered, 'Inviting…'))
    expect(addCollaborator).toHaveBeenCalledTimes(1)

    await act(async () => {
      pending.resolve(profileFor('ada@example.com', 'use', 'Ada Lovelace'))
      await Promise.resolve()
    })
    expect(input.value).toBe('')
    expect(input.readOnly).toBe(false)
    expect(document.activeElement).toBe(input)
    expect(toastAdd).toHaveBeenCalledWith({
      title: 'Added Ada Lovelace as a collaborator.',
      variant: 'success',
    })
    expect(addCollaborator).toHaveBeenCalledTimes(1)
    expect(button(rendered, 'Invite').disabled).toBe(true)

    await typeDirectorySearch(rendered, 'grace@example.com')
    await pressKey(input, 'Enter')
    expect(addCollaborator).toHaveBeenLastCalledWith('grace@example.com', 'use', undefined)
    expect(input.value).toBe('')
  })

  it('keeps an in-flight invite and its failure across close and reopen', async () => {
    const pending = deferred<CollaboratorInfo | null>()
    const rendered = await render(
      fakeOverseer({ addCollaborator: () => pending.promise }),
      fakeAuthenticatedApi({ searchUsers: async () => [] }),
    )

    await typeDirectorySearch(rendered, 'ada@example.com')
    await pressKey(peopleInput(rendered), 'Enter')
    await pressKey(peopleInput(rendered), 'Enter')

    await setOpen(false)
    await setOpen(true)
    expect(peopleInput(rendered).readOnly).toBe(true)

    const refusal = 'Sharing is disabled for this workspace.'
    await act(async () => {
      pending.reject(new Error(refusal))
      await Promise.resolve()
    })
    expect(peopleInput(rendered).value).toBe('ada@example.com')
    expect(peopleInput(rendered).readOnly).toBe(false)
    expect(rendered.querySelector('[role="alert"]')?.textContent)
      .toContain(refusal)
    expect(toastAdd).not.toHaveBeenCalledWith(expect.objectContaining({ variant: 'error' }))
  })

  it('keeps a failed invitation editable and allows a retry', async () => {
    const addCollaborator = vi.fn<NonNullable<OverseerOverrides['addCollaborator']>>()
      .mockRejectedValueOnce(new Error('Sharing is temporarily unavailable.'))
      .mockImplementation(async (userId, role) => profileFor(userId, role, 'Ada Lovelace'))
    const rendered = await render(
      fakeOverseer({ addCollaborator }),
      fakeAuthenticatedApi({ searchUsers: async () => [] }),
    )

    await typeDirectorySearch(rendered, 'ada@example.com')
    await pressKey(peopleInput(rendered), 'Enter')
    expect(peopleInput(rendered).value).toBe('ada@example.com')
    expect(rendered.querySelector('[role="alert"]')?.textContent)
      .toContain('Sharing is temporarily unavailable.')
    await typeDirectorySearch(rendered, 'ada@example.com')
    expect(rendered.querySelector('[role="alert"]')).toBeNull()
    await pressKey(peopleInput(rendered), 'Enter')
    expect(addCollaborator).toHaveBeenCalledTimes(2)
    expect(peopleInput(rendered).value).toBe('')
    expect(rendered.querySelector('[role="alert"]')).toBeNull()
  })

  it('does not submit another invitation on Enter in the cleared field', async () => {
    const addCollaborator = vi.fn<NonNullable<OverseerOverrides['addCollaborator']>>(
      async (userId, role) => profileFor(userId, role, 'Ada Lovelace'))
    const rendered = await render(
      fakeOverseer({ addCollaborator }),
      fakeAuthenticatedApi({ searchUsers: async () => [] }),
    )

    await typeDirectorySearch(rendered, 'ada@example.com')
    await pressKey(peopleInput(rendered), 'Enter')
    await pressKey(peopleInput(rendered), 'Enter')

    expect(addCollaborator).toHaveBeenCalledTimes(1)
    expect(addCollaborator).toHaveBeenCalledWith('ada@example.com', 'use', undefined)
  })

  it('does not invite a recipient while Enter is completing IME composition', async () => {
    const addCollaborator = vi.fn<NonNullable<OverseerOverrides['addCollaborator']>>()
    const rendered = await render(fakeOverseer({ addCollaborator }), fakeAuthenticatedApi({ searchUsers: async () => [] }))
    await typeDirectorySearch(rendered, 'ada@example.com')
    await act(async () => peopleInput(rendered).dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', isComposing: true, bubbles: true, cancelable: true,
    })))
    expect(addCollaborator).not.toHaveBeenCalled()
    expect(peopleInput(rendered).value).toBe('ada@example.com')
  })

  it('keeps an unknown account in the input with an accessible error', async () => {
    const addCollaborator = vi.fn<NonNullable<OverseerOverrides['addCollaborator']>>(
      async (userId, role) => userId === 'nobody@example.com'
        ? null
        : profileFor(userId, role, 'Ada Lovelace'))
    const rendered = await render(
      fakeOverseer({ addCollaborator }),
      fakeAuthenticatedApi({ searchUsers: async () => [] }),
    )
    const input = peopleInput(rendered)

    await typeDirectorySearch(rendered, 'ada@example.com')
    await pressKey(input, 'Enter')
    await typeDirectorySearch(rendered, 'nobody@example.com')
    await pressKey(input, 'Enter')
    expect(input.value).toBe('nobody@example.com')
    expect(input.getAttribute('aria-invalid')).toBe('true')
    const errorId = input.getAttribute('aria-describedby')!
    expect(document.getElementById(errorId)?.textContent)
      .toContain('No account found for that username or email.')
    expect(rendered.querySelector('[role="alert"]')?.textContent)
      .toContain('No account found for that username or email.')
    expect(toastAdd).toHaveBeenCalledWith({
      title: 'Added Ada Lovelace as a collaborator.',
      variant: 'success',
    })
    expect(toastAdd).not.toHaveBeenCalledWith(expect.objectContaining({ variant: 'error' }))
    expect(input.disabled).toBe(false)
    expect(button(rendered, 'Invite').disabled).toBe(false)
  })

  it('does not expose results from the previous query', async () => {
    const addCollaborator = vi.fn<NonNullable<OverseerOverrides['addCollaborator']>>()
    const rendered = await render(
      fakeOverseer({ addCollaborator }),
      fakeAuthenticatedApi({
        searchUsers: async query => query === 'ada'
          ? [{ id: 'ada@example.com', name: 'Ada Lovelace' }]
          : [],
      }),
    )
    await typeDirectorySearch(rendered, 'ada')
    expect(rendered.textContent).toContain('Ada Lovelace')

    const input = rendered.querySelector<HTMLInputElement>('input[aria-label="Search people"]')!
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setValue.call(input, 'grace')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })

    expect(input.value).toBe('grace')
    expect(rendered.textContent).not.toContain('Ada Lovelace')
    expect(addCollaborator).not.toHaveBeenCalled()
  })

  it('scrolls only the result list for keyboard navigation', async () => {
    const results = Array.from({ length: 10 }, (_, index) => ({
      id: `user${index}@example.com`,
      name: `User ${index}`,
    }))
    const rendered = await render(
      fakeOverseer(),
      fakeAuthenticatedApi({ searchUsers: async () => results }),
    )
    await typeDirectorySearch(rendered, 'user')

    const input = rendered.querySelector<HTMLInputElement>('input[aria-label="Search people"]')!
    const listbox = rendered.querySelector<HTMLDivElement>('[role="listbox"]')!
    const modalScroller = input.closest<HTMLDivElement>('.chat-panel')!
    expect(listbox.closest('dialog')).not.toBeNull()
    const targetId = `${input.getAttribute('aria-controls')}-option-6`
    const target = document.getElementById(targetId)!
    listbox.getBoundingClientRect = () => ({
      top: 100, bottom: 286, left: 0, right: 600, width: 600, height: 186,
      x: 0, y: 100, toJSON: () => ({}),
    })
    target.getBoundingClientRect = () => ({
      top: 388, bottom: 436, left: 0, right: 600, width: 600, height: 48,
      x: 0, y: 388, toJSON: () => ({}),
    })
    modalScroller.scrollTop = 31

    await act(async () => {
      for (let index = 0; index < 6; index++) {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
      }
    })

    expect(input.getAttribute('aria-activedescendant')).toBe(targetId)
    expect(listbox.scrollTop).toBe(150)
    expect(modalScroller.scrollTop).toBe(31)
  })

  it('keeps the canonical copy link available while directory search loads or fails', async () => {
    const offline = deferred<UserDirectoryRecord[]>()
    const searchUsers = (query: string) => query === 'offline' ? offline.promise : Promise.resolve([])
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const rendered = await render(
      fakeOverseer(),
      fakeAuthenticatedApi({ searchUsers }),
    )
    await typeDirectorySearch(rendered, 'offline')
    expect(rendered.textContent).toContain('Searching…')
    expect(button(rendered, 'Copy link').disabled).toBe(false)

    await act(async () => {
      offline.reject(new Error('offline'))
      await Promise.resolve()
    })
    expect(rendered.textContent).toContain('User search is temporarily unavailable.')
    expect(button(rendered, 'Copy link').disabled).toBe(false)

    await typeDirectorySearch(rendered, 'nobody')
    expect(rendered.textContent).toContain('No users found.')
    consoleError.mockRestore()
  })

  it('names the connections a recipient must verify for the selected role', async () => {
    const rendered = await render(fakeOverseer({
      requirements: { use: [DOC_REQUIREMENT], build: [DOC_REQUIREMENT, CRM_REQUIREMENT] },
    }))

    expect(button(rendered, 'Protected resources').textContent).toContain('(1)')
    expect(rendered.textContent).not.toContain('Q3 planning')
    expect(rendered.textContent).not.toContain('Pipeline dashboard')
    await click(button(rendered, 'Protected resources'))
    expect(rendered.textContent).toContain('Q3 planning')
    expect(rendered.textContent).not.toContain('Pipeline dashboard')
    await click(button(rendered, 'Back to sharing'))

    await click(roleOption(rendered, 'Workspace'))
    expect(button(rendered, 'Protected resources').textContent).toContain('(2)')
    await click(button(rendered, 'Protected resources'))
    expect(rendered.textContent).toContain('Pipeline dashboard')
  })

  it('replaces sharing with protected resources and restores the composer and focus on back', async () => {
    const rendered = await render(fakeOverseer({
      requirements: { use: [DOC_REQUIREMENT], build: [DOC_REQUIREMENT, CRM_REQUIREMENT] },
    }))
    await typeDirectorySearch(rendered, 'ada')
    await click(rendered.querySelector('[role="option"]')!)
    await click(button(rendered, 'Protected resources'))
    expect(rendered.querySelector('h2')?.textContent).toBe('Protected resources')
    expect(rendered.querySelector('input[aria-label="Search people"]')).toBeNull()
    expect(rendered.textContent).not.toContain('People with access')
    expect(document.activeElement).toBe(button(rendered, 'Back to sharing'))
    expect(rendered.textContent).toContain('before seeing or interacting with this gadget or workspace')

    await click(button(rendered, 'Back to sharing'))
    expect(rendered.querySelector('h2')?.textContent).toBe('Share “Trip planner”')
    expect(peopleInput(rendered).value).toBe('')
    expect(document.activeElement).toBe(button(rendered, 'Protected resources'))
  })

  it('hides the protected resources pill when recipients have nothing to verify', async () => {
    const rendered = await render(fakeOverseer())
    expect(rendered.querySelector('button[aria-label="Protected resources"]')).toBeNull()
    expect(button(rendered, 'Copy link').disabled).toBe(false)
  })

  it('shows and hides the pill as the selected access level gains or loses requirements', async () => {
    const rendered = await render(fakeOverseer({ requirements: { use: [], build: [CRM_REQUIREMENT] } }))
    expect(rendered.querySelector('button[aria-label="Protected resources"]')).toBeNull()
    await click(roleOption(rendered, 'Workspace'))
    expect(button(rendered, 'Protected resources').textContent).toContain('(1)')
    await click(roleOption(rendered, 'Gadget only'))
    expect(rendered.querySelector('button[aria-label="Protected resources"]')).toBeNull()
  })

  it('degrades quietly when the requirements lookup fails', async () => {
    const rendered = await render(fakeOverseer({
      listObserverRequirements: async () => { throw new Error('offline') },
    }))

    expect(rendered.textContent).toContain('People with access')
    expect(button(rendered, 'Copy link').disabled).toBe(false)
    await click(button(rendered, 'Protected resources'))
    expect(rendered.textContent).toContain('Couldn’t check')
    await click(button(rendered, 'Back to sharing'))
    expect(rendered.textContent).toContain('People with access')
  })

  it('refreshes requirements when the modal regains focus', async () => {
    const listObserverRequirements = vi.fn<
      (role: CollaboratorRole) => Promise<ObserverBindingNeed[]>
    >(async () => [])
    await render(fakeOverseer({ listObserverRequirements }))
    expect(listObserverRequirements).toHaveBeenCalledTimes(2)

    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      await Promise.resolve()
    })

    expect(listObserverRequirements).toHaveBeenCalledTimes(4)
  })

  it('keeps sharing controls live when the workspace has read restricted data', async () => {
    const restrictedMetadata = {
      ...METADATA, containsRestrictedData: true,
    } as GadgetMetadata
    const rendered = await render(fakeOverseer({
      collaborators: [{
        profile: { type: 'user', id: 'ada@cloudflare.com', name: 'Ada' },
        role: 'use',
        addedBy: [],
      }],
      shareLinks: [SHARE_LINK],
    }), fakeAuthenticatedApi(), restrictedMetadata)

    // The inline warning replaces the old full-panel "can't be shared" wall: the server allows
    // sharing after containsRestrictedData is set (refusing only unverifiable producers), so the modal
    // must warn rather than block.
    expect(rendered.textContent).toContain('This workspace has read sensitive data')
    expect(rendered.textContent).not.toContain('This workspace can’t be shared')
    // The warning states the guarantee the server actually makes: verification is scoped to the
    // recipient's role (the panel below lists the connections per level), and output the
    // workspace has already persisted is readable by anyone who can open it. It must not claim
    // invitees are verified against "the same data" -- never-bound and since-removed producers
    // fall outside that check.
    expect(rendered.textContent).toContain('verify their own access')
    expect(rendered.textContent).not.toContain('the same data')

    // Existing access links can still be revoked; copying uses the canonical workspace URL.
    expect(rendered.textContent).toContain('People with access')
    expect(button(rendered, 'Remove Ada').disabled).toBe(false)
    expect(button(rendered, 'Copy link').disabled).toBe(false)
    expect(button(rendered, 'Revoke Team link').disabled).toBe(false)
    const usernameInput =
      rendered.querySelector<HTMLInputElement>('input[aria-label="Search people"]')!
    expect(usernameInput.disabled).toBe(false)
    await typeDirectorySearch(rendered, 'ada')
    const option = rendered.querySelector<HTMLButtonElement>('[role="option"]')
    if (!option) throw new Error('Expected a directory search result.')
    await click(option)
    expect(button(rendered, 'Invite').disabled).toBe(false)
  })

  it('drops share-link controls but keeps revocation once the workspace is owner-invites-only', async () => {
    const ownerInvitesOnlyMetadata = {
      ...METADATA, containsRestrictedData: true, ownerInvitesOnly: true,
    } as GadgetMetadata
    const rendered = await render(fakeOverseer({
      requirements: { use: [CRM_REQUIREMENT], build: [CRM_REQUIREMENT] },
      shareLinks: [SHARE_LINK],
    }), fakeAuthenticatedApi(), ownerInvitesOnlyMetadata)

    expect(rendered.textContent).toContain('doesn’t allow share links')
    expect(rendered.textContent).toContain('Invite people.')
    expect(rendered.textContent).not.toContain('share a link.')
    expect(rendered.textContent).not.toContain('This workspace has read sensitive data')
    // The link restriction adds to the restricted-data caveats rather than replacing them.
    expect(rendered.textContent).toContain('verify their own access')
    expect(rendered.textContent).toContain('already saved is visible to everyone who can')

    // No way to mint access; the canonical URL is still safe to copy.
    expect(rendered.textContent).not.toContain('Create a share link')
    expect(rendered.querySelector('button[aria-label="Copy Team link"]')).toBeNull()
    expect(button(rendered, 'Copy link').disabled).toBe(false)
    expect(button(rendered, 'Revoke Team link').disabled).toBe(false)

    // The owner still invites people directly, and sees what they will be asked to verify.
    expect(rendered.querySelector('input[aria-label="Search people"]')).not.toBeNull()
    await click(button(rendered, 'Protected resources'))
    expect(rendered.textContent).toContain('Pipeline dashboard')
    await click(button(rendered, 'Back to sharing'))
    await invite(rendered, 'ada')
    expect(rendered.textContent).toContain('Added Ada')
  })

  it('hides the invite box from collaborators once the workspace is owner-invites-only', async () => {
    const ownerInvitesOnlyMetadata = {
      ...METADATA,
      ownerInvitesOnly: true,
      owner: { type: 'user', id: 'owner@cloudflare.com', name: 'Owner' },
    } as GadgetMetadata
    const rendered = await render(fakeOverseer({
      requirements: { use: [CRM_REQUIREMENT], build: [CRM_REQUIREMENT] },
    }), fakeAuthenticatedApi(), ownerInvitesOnlyMetadata)

    expect(rendered.textContent).toContain('only the owner can add people')
    expect(rendered.textContent).toContain('Manage access.')
    expect(rendered.textContent).not.toContain('Invite people')
    expect(rendered.querySelector('input[aria-label="Search people"]')).toBeNull()
    expect(rendered.textContent).not.toContain('Create a share link')
    expect(rendered.textContent).not.toContain('Recipient verification')
    expect(rendered.textContent).toContain('People with access')
  })

  it('releases the results scroll lock when a live ownerInvitesOnly update stops a collaborator inviting', async () => {
    const collaboratorMetadata = {
      ...METADATA,
      owner: { type: 'user', id: 'owner@cloudflare.com', name: 'Owner' },
    } as GadgetMetadata
    const rendered = await render(fakeOverseer(), fakeAuthenticatedApi(), collaboratorMetadata)
    const body = () => rendered.querySelector<HTMLElement>('.chat-panel')!

    await typeDirectorySearch(rendered, 'ada')
    expect(rendered.querySelector('[role="listbox"]')).not.toBeNull()
    expect(body().classList).toContain('overflow-hidden')

    // Another session sets ownerInvitesOnly while the results are open: the search field goes
    // away without ever blurring, and the body must scroll again.
    await updateMetadata({ ...collaboratorMetadata, ownerInvitesOnly: true } as GadgetMetadata)
    expect(rendered.querySelector('input[aria-label="Search people"]')).toBeNull()
    expect(rendered.querySelector('[role="listbox"]')).toBeNull()
    expect(body().classList).toContain('overflow-y-auto')
    expect(body().classList).not.toContain('overflow-hidden')
  })

  it('surfaces the server’s refusal when sharing is no longer allowed', async () => {
    const restrictedMetadata = {
      ...METADATA, containsRestrictedData: true,
    } as GadgetMetadata
    const refusal =
      'This workspace can no longer be shared: it read sensitive data through a connection ' +
      'that has since been removed, so new collaborators can no longer be verified for ' +
      'access to that data.'
    const rendered = await render(fakeOverseer({
      addCollaborator: async () => { throw new Error(refusal) },
    }), fakeAuthenticatedApi(), restrictedMetadata)

    await invite(rendered, 'ada')

    expect(peopleInput(rendered).value).toBe('ada@example.com')
    const alertLine = rendered.querySelector('[role="alert"]')
    expect(alertLine?.textContent).toContain(refusal)
    expect(alertLine?.className).not.toContain('truncate')
    expect(toastAdd).not.toHaveBeenCalled()
  })

  it('copies the canonical URL before inviting anyone without granting access', async () => {
    const overseer = fakeOverseer({ shareLinks: [SHARE_LINK] })
    const createShareLink = vi.spyOn(overseer, 'createShareLink')
    const addCollaborator = vi.spyOn(overseer, 'addCollaborator')
    const rendered = await render(overseer)
    expect(rendered.textContent).not.toContain('Create a share link')
    expect(rendered.querySelector('button[aria-label="Copy Team link"]')).toBeNull()
    await click(button(rendered, 'Copy link'))
    expect(copyToClipboard).toHaveBeenCalledWith(WORKSPACE_URL)
    expect(button(rendered, 'Copied')).toBeDefined()
    expect(createShareLink).not.toHaveBeenCalled()
    expect(addCollaborator).not.toHaveBeenCalled()
  })

  it('retains revocation of existing access-granting links', async () => {
    const revokeShareLink = vi.fn<Overseer['revokeShareLink']>(async () => [])
    const previewRevokeShareLink = vi.fn<Overseer['previewRevokeShareLink']>(async () => [])
    const rendered = await render(fakeOverseer({ shareLinks: [SHARE_LINK], revokeShareLink, previewRevokeShareLink }))
    await click(button(rendered, 'Revoke Team link'))
    expect(previewRevokeShareLink).toHaveBeenCalledWith('link-1')
    await click(button(rendered, 'Revoke'))
    expect(revokeShareLink).toHaveBeenCalledWith('link-1', [])
  })

  it('reopens on the sharing view after closing from protected resources', async () => {
    const rendered = await render(fakeOverseer({ requirements: { use: [DOC_REQUIREMENT] } }))
    await click(button(rendered, 'Protected resources'))
    await setOpen(false)
    await setOpen(true)
    expect(rendered.querySelector('h2')?.textContent).toBe('Share “Trip planner”')
    expect(rendered.querySelector('input[aria-label="Search people"]')).not.toBeNull()
  })

  it('renders vendor logos and resource types in protected resource rows', async () => {
    const rendered = await render(
      fakeOverseer({ requirements: { use: [DOC_REQUIREMENT] } }),
      fakeAuthenticatedApi({ listGatekeeperVendors: async () => [{
        id: 'google',
        description: { displayName: 'Google', logo: { url: 'https://example.com/google.svg' } },
        supportedResources: [{ urlPattern: 'https://docs.google.com/document/d/*', title: 'Google Doc', description: 'Document' }],
      } as GatekeeperVendorInfo] }),
    )
    await click(button(rendered, 'Protected resources'))
    const list = rendered.querySelector('ul[aria-label="Protected resources"]')!
    expect(list.textContent).toContain('Q3 planning')
    expect(list.textContent).toContain('Google Doc')
    expect(list.querySelector('img')?.getAttribute('src')).toBe('https://example.com/google.svg')
  })

  it('shows the protected resources pill only after nonempty requirements arrive', async () => {
    const pending = deferred<ObserverBindingNeed[]>()
    const rendered = await render(fakeOverseer({ listObserverRequirements: () => pending.promise }))
    expect(rendered.querySelector('button[aria-label="Protected resources"]')).toBeNull()
    await act(async () => pending.resolve([DOC_REQUIREMENT]))
    expect(button(rendered, 'Protected resources').textContent).toContain('(1)')
    await click(button(rendered, 'Protected resources'))
    expect(rendered.textContent).toContain('Q3 planning')
    expect(rendered.textContent).not.toContain('Loading protected resources…')
  })

  it('reports clipboard failure and leaves the copy action available for retry', async () => {
    copyToClipboard.mockResolvedValueOnce(false)
    const rendered = await render(fakeOverseer())
    await click(button(rendered, 'Copy link'))
    expect(toastAdd).toHaveBeenCalledWith({ title: 'Could not copy the workspace link.', variant: 'error' })
    await click(button(rendered, 'Copy link'))
    expect(button(rendered, 'Copied')).toBeDefined()
  })
})
