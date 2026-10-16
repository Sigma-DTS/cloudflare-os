// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act, type ReactElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AiChatAuthorInfo, AuthenticatedApi, CollaboratorInfo, GadgetMetadata, Overseer, ServerConfig } from '@gadgets/workshop-shared/api'
import { ServerConfigContext } from '../../ServerConfigContext'
import { WorkspaceInviteModal } from './WorkspaceInviteModal'
import { GadgetShareModal } from './GadgetShareModal'

const { toastAdd, copyToClipboard } = vi.hoisted(() => ({ toastAdd: vi.fn<(toast: unknown) => void>(), copyToClipboard: vi.fn<(text: string) => Promise<boolean>>(async () => true) }))
vi.mock('../../clipboard', () => ({ copyToClipboard }))
vi.mock('../../components/PersonAvatar', () => ({ PersonAvatar: () => <span /> }))
vi.mock('@cloudflare/kumo', async importOriginal => {
  const actual = await importOriginal<typeof import('@cloudflare/kumo')>()
  return {
    ...actual,
    // Keep a fresh manager object each render, as the real Kumo hook does.
    useKumoToastManager: () => ({ add: toastAdd }),
    Dialog: Object.assign(({ children }: { children: ReactNode }) => <dialog open>{children}</dialog>, {
      Root: ({ open, children }: { open: boolean; children: ReactNode }) => open ? children : null,
      Title: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
      Description: ({ children }: { children: ReactNode }) => <p>{children}</p>,
      Close: ({ render }: { render: (props: object) => ReactElement }) => render({}),
    }),
    DropdownMenu: Object.assign(({ children }: { children: ReactNode }) => <div>{children}</div>, {
      Trigger: ({ render }: { render: ReactElement }) => render,
      Content: ({ children }: { children: ReactNode }) => <div>{children}</div>,
      Item: ({ children, onClick, disabled }: { children: ReactNode; onClick: () => void; disabled?: boolean }) => <button disabled={disabled} onClick={onClick}>{children}</button>,
    }),
  }
})

const OWNER: AiChatAuthorInfo = { type: 'user', id: 'owner@example.com', name: 'Owner' }
const METADATA = { id: 'workspace-1', title: 'Workspace' } as GadgetMetadata
const GADGET = { id: 7, title: 'My Application' }
const person = (id: string, name: string, sharer = OWNER.id): CollaboratorInfo => ({
  profile: { type: 'user', id, name }, role: 'build',
  addedBy: [{ type: 'user', sharer, role: 'build', created: new Date() }],
})

const makeApi = () => ({
  listCollaborators: vi.fn<Overseer['listCollaborators']>(async () => [person('alice', 'Alice')]),
  addCollaborator: vi.fn<Overseer['addCollaborator']>(async () => person('bob', 'Bob')),
  getGadgetSharing: vi.fn<Overseer['getGadgetSharing']>(async () => ({ allUsersCanView: false, viewers: [] })),
  addGadgetViewer: vi.fn<Overseer['addGadgetViewer']>(async () => ({ ...person('bob', 'Bob'), role: 'use' as const })),
  setGadgetAllUsersAccess: vi.fn<Overseer['setGadgetAllUsersAccess']>(async () => {}),
  removeGadgetViewer: vi.fn<Overseer['removeGadgetViewer']>(async () => {}),
  listObserverRequirements: vi.fn<Overseer['listObserverRequirements']>(async () => []),
  previewRemoveCollaborator: vi.fn<Overseer['previewRemoveCollaborator']>(async () => []),
  removeCollaborator: vi.fn<Overseer['removeCollaborator']>(async () => []),
})

let root: Root
let host: HTMLDivElement
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('PointerEvent', MouseEvent)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  copyToClipboard.mockClear()
  toastAdd.mockClear()
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

const click = async (label: string) => {
  const target = [...document.body.querySelectorAll('button')].find(button => button.textContent?.trim() === label || button.getAttribute('aria-label') === label)
  if (!target) throw new Error(`Missing button: ${label}`)
  await act(async () => { target.click() })
}
const type = async (value: string) => {
  const input = document.body.querySelector('input')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const render = async (kind: 'workspace' | 'gadget', api = makeApi(), searchEnabled = false, metadata = METADATA) => {
  const authenticatedApi = { searchUsers: vi.fn<AuthenticatedApi['searchUsers']>(async () => [{ id: 'bob', name: 'Bob' }]) } as unknown as RpcStub<AuthenticatedApi>
  const shared = { open: true, onClose: () => {}, overseer: api as unknown as RpcStub<Overseer>, metadata, currentUser: OWNER, authenticatedApi }
  await act(async () => root.render(
    <ServerConfigContext.Provider value={{ userSearchEnabled: searchEnabled } as ServerConfig}>
      {kind === 'workspace' ? <WorkspaceInviteModal {...shared} /> : <GadgetShareModal {...shared} gadget={GADGET} />}
    </ServerConfigContext.Provider>,
  ))
  return { api, authenticatedApi }
}

describe('separate sharing flows', () => {
  it('invites workspace members with edit access and no role selector', async () => {
    const { api } = await render('workspace')
    expect(document.body.textContent).toContain('Invite to Workspace')
    expect(document.body.textContent).toContain('Member')
    expect(document.body.textContent).not.toContain('Can view')
    expect(document.body.textContent).not.toContain('Protected resources')
    await type('bob')
    await click('Invite')
    expect(api.addCollaborator).toHaveBeenCalledWith('bob', 'build', undefined)
    expect(api.addGadgetViewer).not.toHaveBeenCalled()
  })

  it('copies an existing-members-only workspace URL', async () => {
    const { api } = await render('workspace')
    await click('Copy link')
    expect(copyToClipboard).toHaveBeenCalledWith(`${window.location.origin}/workspace/workspace-1`)
    expect(api.addCollaborator).not.toHaveBeenCalled()
  })

  it('shares an individual gadget as View only, independently of membership', async () => {
    const { api } = await render('gadget')
    expect(document.body.textContent).toContain('My Application')
    expect(document.body.textContent).toContain('People in this workspaceCan edit')
    expect(document.body.textContent).toContain('Anyone in OrganizationNo access')
    await type('bob')
    await click('Share')
    expect(api.addGadgetViewer).toHaveBeenCalledWith(7, 'bob')
    expect(api.addCollaborator).not.toHaveBeenCalled()
    await click('Copy link')
    expect(copyToClipboard).toHaveBeenCalledWith(`${window.location.origin}/workspace/workspace-1?w=7`)
  })

  it('sets all-users viewing on the gadget, not the workspace', async () => {
    const { api } = await render('gadget')
    await click('Can view')
    expect(api.setGadgetAllUsersAccess).toHaveBeenCalledWith(7, true)
    expect(api.listObserverRequirements).toHaveBeenCalledWith('use', 7)
  })

  it('keeps gadget removal inside the sharing modal and returns on Cancel', async () => {
    const api = makeApi()
    api.getGadgetSharing.mockResolvedValue({ allUsersCanView: false, viewers: [{ ...person('bob', 'Bob'), role: 'use' }] })
    await render('gadget', api)
    await click('Remove')
    expect(document.body.querySelectorAll('dialog')).toHaveLength(1)
    expect(document.body.querySelector('h2')?.textContent).toBe('Remove Bob?')
    expect(document.body.textContent).not.toContain('Copy link')
    await click('Cancel')
    expect(document.body.querySelector('h2')?.textContent).toContain('Share')
    expect(document.body.textContent).toContain('Copy link')
    expect(api.removeGadgetViewer).not.toHaveBeenCalled()
  })

  it('reviews and selects indirect invitees in the removal table', async () => {
    const api = makeApi()
    api.previewRemoveCollaborator.mockResolvedValue([
      { ...person('alice', 'Alice'), oldRole: 'build', newRole: null },
      { ...person('bob', 'Bob', 'alice'), oldRole: 'build', newRole: null },
      { ...person('carol', 'Carol', 'bob'), oldRole: 'build', newRole: null },
    ])
    api.listCollaborators.mockResolvedValue([person('alice', 'Alice'), person('bob', 'Bob', 'alice'), person('carol', 'Carol', 'bob')])
    await render('workspace', api)
    await click('Remove')
    await click('You can also remove people Alice invited')
    const rows = document.body.querySelectorAll('tbody tr')
    expect(rows[0]?.querySelector('td:last-child')?.textContent).toBe('Alice')
    expect(rows[1]?.querySelector('td:last-child')?.textContent).toBe('Bob')
    const checkboxes = [...document.body.querySelectorAll('tbody [role="checkbox"]')]
    expect(checkboxes.map(checkbox => checkbox.getAttribute('aria-checked'))).toEqual(['false', 'false'])
    const selectAll = document.body.querySelector<HTMLElement>('[role="checkbox"][aria-label="Select all people to remove"]')!
    await act(async () => { selectAll.click() })
    expect(checkboxes.map(checkbox => checkbox.getAttribute('aria-checked'))).toEqual(['true', 'true'])
    expect([...document.body.querySelectorAll('button')].some(button => button.textContent?.trim() === 'Remove (3)')).toBe(true)
    await act(async () => { selectAll.click() })
    expect(checkboxes.map(checkbox => checkbox.getAttribute('aria-checked'))).toEqual(['false', 'false'])
    const bobCheckbox = document.body.querySelector<HTMLElement>('[role="checkbox"][aria-label="Remove Bob"]')!
    await act(async () => { bobCheckbox.closest('tr')!.click() })
    expect(bobCheckbox.getAttribute('aria-checked')).toBe('true')
    expect(selectAll.getAttribute('aria-checked')).toBe('mixed')
    await act(async () => { bobCheckbox.click() })
    expect(bobCheckbox.getAttribute('aria-checked')).toBe('false')
    await act(async () => { bobCheckbox.click() })
    expect(bobCheckbox.getAttribute('aria-checked')).toBe('true')
    await click('Remove (2)')
    expect(api.removeCollaborator).toHaveBeenCalledWith('alice', ['carol'])
  })

  it('keeps indirect invitees by default without opening the review', async () => {
    const api = makeApi()
    api.previewRemoveCollaborator.mockResolvedValue([
      { ...person('alice', 'Alice'), oldRole: 'build', newRole: null },
      { ...person('bob', 'Bob', 'alice'), oldRole: 'build', newRole: null },
      { ...person('carol', 'Carol', 'bob'), oldRole: 'build', newRole: null },
    ])
    await render('workspace', api)
    await click('Remove')
    await click('Remove')
    expect(api.removeCollaborator).toHaveBeenCalledWith('alice', ['bob', 'carol'])
  })

  it.each(['workspace', 'gadget'] as const)('keeps %s search open without repeatedly refreshing membership or restarting the directory request', async kind => {
    const { api, authenticatedApi } = await render(kind, makeApi(), true)
    await type('bob')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 250)) })
    expect(api.listCollaborators).toHaveBeenCalledTimes(1)
    expect(authenticatedApi.searchUsers).toHaveBeenCalledTimes(1)
    expect(document.body.querySelector('[role="combobox"]')?.getAttribute('aria-expanded')).toBe('true')
    expect(document.body.querySelector('[role="option"]')?.textContent).toContain('Bob')
  })

  it.each(['workspace', 'gadget'] as const)('locks and restores %s access through the inline owner controls', async kind => {
    const api = makeApi()
    api.getGadgetSharing.mockResolvedValue({ allUsersCanView: true, viewers: [{ ...person('bob', 'Bob'), role: 'use' }] })
    await render(kind, api, false, { ...METADATA, id: `owner-lock-${kind}` })
    const personName = kind === 'workspace' ? 'Alice' : 'Bob'
    await click('Owner controls')
    expect(document.body.querySelector('h2')?.textContent).toBe('Owner controls')
    expect(document.body.querySelectorAll('dialog')).toHaveLength(1)
    expect(document.body.textContent).not.toContain('Copy link')
    await click('Lock access')
    expect(document.body.querySelector('[role="switch"][aria-label="Lock access"]')?.getAttribute('aria-checked')).toBe('true')
    await click('Done')
    expect(document.activeElement?.textContent).toBe('Owner controls')
    expect(document.body.textContent).toContain('Access locked.')
    expect(document.body.textContent).not.toContain(personName)
    await click('Owner controls')
    await click('Lock access')
    await click('Done')
    expect(document.body.textContent).toContain(personName)
    expect(document.body.textContent).not.toContain('Access locked.')
    expect(api.removeCollaborator).not.toHaveBeenCalled()
    expect(api.removeGadgetViewer).not.toHaveBeenCalled()
  })

  it.each(['workspace', 'gadget'] as const)('confirms removing everyone from the %s and keeps access cleared after unlocking', async kind => {
    const api = makeApi()
    api.getGadgetSharing.mockResolvedValue({ allUsersCanView: true, viewers: [{ ...person('bob', 'Bob'), role: 'use' }] })
    await render(kind, api, false, { ...METADATA, id: `owner-clear-${kind}` })
    await click('Owner controls')
    await click('Lock access')
    await click('Remove everyone')
    expect(document.body.querySelector('h2')?.textContent).toBe('Remove everyone?')
    expect(document.body.querySelectorAll('dialog')).toHaveLength(1)
    expect(document.activeElement?.textContent).toBe('Cancel')
    await click('Cancel')
    expect(document.body.querySelector('h2')?.textContent).toBe('Owner controls')
    await click('Remove everyone')
    await click('Remove everyone')
    expect(document.body.querySelector('h2')?.textContent).toBe('Owner controls')
    await click('Lock access')
    await click('Done')
    expect(document.body.textContent).not.toContain(kind === 'workspace' ? 'Alice' : 'Bob')
    expect(document.body.textContent).toContain(kind === 'gadget' ? 'People in this workspaceCan edit' : 'Invite to Workspace')
    // Owner-control mutations are intentionally local in this interactive prototype.
    expect(api.removeCollaborator).not.toHaveBeenCalled()
    expect(api.removeGadgetViewer).not.toHaveBeenCalled()
  })

  it('inherits workspace locks and access removal in gadget owner controls', async () => {
    const api = makeApi()
    const metadata = { ...METADATA, id: 'owner-workspace-inheritance' }
    api.getGadgetSharing.mockResolvedValue({ allUsersCanView: true, viewers: [{ ...person('bob', 'Bob'), role: 'use' }] })
    await render('workspace', api, false, metadata)
    await click('Owner controls')
    await click('Lock access')
    await render('gadget', api, false, metadata)
    expect(document.body.textContent).toContain('Access locked by workspace.')
    await click('Owner controls')
    const lockSwitch = document.body.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Lock access"]')!
    expect(lockSwitch.disabled).toBe(true)
    expect(lockSwitch.getAttribute('aria-checked')).toBe('true')
    await render('workspace', api, false, metadata)
    await click('Owner controls')
    await click('Lock access')
    await click('Remove everyone')
    await click('Remove everyone')
    await render('gadget', api, false, metadata)
    expect(document.body.textContent).not.toContain('Bob')
    expect(document.body.textContent).toContain('People in this workspaceCan edit')
    expect(document.body.textContent).toContain('Anyone in OrganizationNo access')
  })

  it.each(['workspace', 'gadget'] as const)('hides %s owner controls from members', async kind => {
    await render(kind, makeApi(), false, { ...METADATA, id: `owner-hidden-${kind}`, owner: { ...OWNER, id: 'another-owner' }, role: 'build' })
    expect(document.body.textContent).not.toContain('Owner controls')
  })

  it('keeps invitation restrictions required by protected resources enabled', async () => {
    await render('workspace', makeApi(), false, { ...METADATA, id: 'owner-protected-resources', ownerInvitesOnly: true })
    await click('Owner controls')
    const invitations = document.body.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Only owners can invite"]')!
    expect(invitations.disabled).toBe(true)
    expect(invitations.getAttribute('aria-checked')).toBe('true')
  })

  it('restricts gadget sharing without changing workspace invitation or edit access', async () => {
    const api = makeApi()
    const metadata = { ...METADATA, id: 'gadget-owner-sharing-only' }
    await render('gadget', api, false, metadata)
    await click('Owner controls')
    await click('Only owners can share')
    await click('Remove everyone')
    await click('Remove everyone')
    expect(document.body.querySelector('[role="switch"][aria-label="Only owners can share"]')?.getAttribute('aria-checked')).toBe('true')
    await render('workspace', api, false, metadata)
    await click('Owner controls')
    expect(document.body.querySelector('[role="switch"][aria-label="Only owners can invite"]')?.getAttribute('aria-checked')).toBe('false')
    await render('gadget', api, false, { ...metadata, owner: { ...OWNER, id: 'another-owner' }, role: 'build' })
    expect(document.body.textContent).toContain('Only the owner can share this gadget.')
    expect(document.body.textContent).toContain('People in this workspaceCan edit')
    expect(document.body.querySelector('input[type="search"]')).toBeNull()
  })

  it('inherits owner-only sharing from the workspace without overwriting the gadget preference', async () => {
    const api = makeApi()
    const metadata = { ...METADATA, id: 'gadget-inherited-sharing-only' }
    await render('workspace', api, false, metadata)
    await click('Owner controls')
    await click('Only owners can invite')
    await render('gadget', api, false, metadata)
    await click('Owner controls')
    const inherited = document.body.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Only owners can share"]')!
    expect(inherited.disabled).toBe(true)
    expect(inherited.getAttribute('aria-checked')).toBe('true')
    expect(document.body.textContent).toContain('Required by the workspace’s owner controls.')
    await render('workspace', api, false, metadata)
    await click('Owner controls')
    await click('Only owners can invite')
    await render('gadget', api, false, metadata)
    await click('Owner controls')
    const independent = document.body.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Only owners can share"]')!
    expect(independent.disabled).toBe(false)
    expect(independent.getAttribute('aria-checked')).toBe('false')
  })
})
