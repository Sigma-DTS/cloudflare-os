// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import { MAX_ADMIN_AUDIT_RETENTION_DAYS } from '@gadgets/workshop-shared/api'
import type {
  AdminAccessRecord,
  AdminApi,
  AdminAuditPage,
  AdminAuditStats,
  AdminSettingRecord,
} from '@gadgets/workshop-shared/api'
import { formatFullTimestamp } from '../../utils/formatTimestamp'
import type { AuditSettings } from './auditSettings'

const { addToast } = vi.hoisted(() => ({
  addToast: vi.fn<(toast: { title: string; description?: string; variant: string }) => void>(),
}))

vi.mock('@cloudflare/kumo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cloudflare/kumo')>()),
  useKumoToastManager: () => ({ add: addToast }),
}))

import { AdminAuditPanel } from './AdminAuditPanel'

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  if (previousActEnvironment === undefined) delete testGlobal.IS_REACT_ACT_ENVIRONMENT
  else testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const RETENTION_LABEL = 'Keep audit records for (days)'

const settingsWith = (patch: {
  access?: Partial<AuditSettings['adminWorkspaceAccess']>
  retention?: Partial<AuditSettings['adminAuditRetentionDays']>
} = {}): AuditSettings => ({
  adminWorkspaceAccess: { effective: 'metadata', chosen: 'metadata', max: 'full', ...patch.access },
  adminAuditRetentionDays: { effective: 90, chosen: 90, min: 90, ...patch.retention },
})

const testStats = (patch: Partial<AdminAuditStats> = {}): AdminAuditStats => ({
  days: 7,
  totalEvents: 5,
  byDay: [
    { day: '2026-10-15', count: 0 },
    { day: '2026-10-16', count: 1 },
    { day: '2026-10-17', count: 0 },
    { day: '2026-10-18', count: 0 },
    { day: '2026-10-19', count: 2 },
    { day: '2026-10-20', count: 0 },
    { day: '2026-10-21', count: 2 },
  ],
  topAdmins: [{ admin: 'admin', count: 4 }, { admin: 'second-admin', count: 1 }],
  topWorkspaces: [
    { workspaceId: 'ws-titled', title: 'Quarterly report', count: 2 },
    { workspaceId: 'ws-untitled', title: '', count: 1 },
  ],
  contentReads: 2,
  topAdminsByContentReads: [{ admin: 'admin', count: 2 }],
  topWorkspacesByContentReads: [{ workspaceId: 'ws-titled', title: 'Quarterly report', count: 2 }],
  ...patch,
})

const ACCESS_AT = new Date('2026-10-21T09:15:00Z')
const SETTING_AT = new Date('2026-10-21T08:00:00Z')

const accessRecord = (patch: Partial<AdminAccessRecord> = {}): AdminAccessRecord => ({
  kind: 'workspace',
  at: ACCESS_AT,
  admin: 'admin',
  sessionId: 'session-1',
  via: 'cli',
  workspaceId: 'ws-untitled',
  workspaceTitle: '',
  method: 'getChat',
  args: { chatId: 3 },
  reason: 'Ticket 42: agent stuck',
  requested: 'metadata',
  access: 'metadata',
  exposed: 'metadata',
  refused: 'ADMIN_CONTENT_WITHHELD',
  ...patch,
})

const settingRecord = (patch: Partial<AdminSettingRecord> = {}): AdminSettingRecord => ({
  kind: 'setting',
  at: SETTING_AT,
  admin: 'second-admin',
  sessionId: 'session-2',
  via: 'api',
  method: 'setSiteName',
  changes: [{ setting: 'siteName', before: 'Old name', after: 'New name' }],
  ...patch,
})

const testPage = (records = [accessRecord(), settingRecord()]): AdminAuditPage => ({ records })

const fakeAdmin = () => ({
  getAdminAuditStats: vi.fn<AdminApi['getAdminAuditStats']>(async () => testStats()),
  listAdminAudit: vi.fn<AdminApi['listAdminAudit']>(async () => testPage()),
  setAdminWorkspaceAccess: vi.fn<AdminApi['setAdminWorkspaceAccess']>(async () => {}),
  setAdminAuditRetentionDays: vi.fn<AdminApi['setAdminAuditRetentionDays']>(async () => {}),
})

const type = (element: HTMLInputElement, value: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value)
  element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }))
})

const click = (element: HTMLElement) => act(async () => { element.click() })

const button = (name: string) => {
  const element = [...document.body.querySelectorAll('button')]
    .find((b) => (b.getAttribute('aria-label') ?? b.textContent?.trim()) === name)
  if (!element) throw new Error(`no button ${name}`)
  return element
}

// What a screen reader names an element by: the elements its aria-labelledby names, which take
// precedence, or else its aria-label.
const accessibleName = (element: HTMLElement) => {
  const labelledBy = element.getAttribute('aria-labelledby')
  return labelledBy
    ? labelledBy.split(' ').map((id) => document.getElementById(id)?.textContent ?? '').join(' ')
    : element.getAttribute('aria-label')
}

describe('AdminAuditPanel', () => {
  let container: HTMLDivElement
  let root: Root

  const render = async (settings: AuditSettings = settingsWith(), admin = fakeAdmin()) => {
    const onSettingsChanged = vi.fn<() => Promise<void>>(async () => {})
    // Shows what a re-read of the settings reported.
    const show = (reported: AuditSettings) => act(async () => root.render(
      <AdminAuditPanel
        admin={admin as unknown as RpcStub<AdminApi>}
        settings={reported}
        onSettingsChanged={onSettingsChanged}
      />))
    await show(settings)
    return { ...admin, onSettingsChanged, show }
  }

  const hasButton = (name: string) =>
    [...container.querySelectorAll('button')].some((b) => b.textContent?.trim() === name)

  // The card a heading titles.
  const card = (title: string) => {
    const heading = [...container.querySelectorAll('h2, h3')].find((h) => h.textContent === title)
    if (!heading?.parentElement) throw new Error(`no card ${title}`)
    return heading.parentElement
  }

  const accessSelect = () => {
    const element = card('Workspace access').querySelector<HTMLElement>('[role="combobox"]')
    if (!element) throw new Error('no access select')
    return element
  }

  /** The options of the list the access select opens, which is left open. */
  const openOptions = async () => {
    const select = accessSelect()
    if (select.getAttribute('aria-expanded') !== 'true') await click(select)
    const list = document.getElementById(select.getAttribute('aria-controls') ?? '')
    return [...list?.querySelectorAll<HTMLElement>('[role="option"]') ?? []]
  }

  const enabledOptions = async () => (await openOptions())
    .filter((option) => option.getAttribute('aria-disabled') !== 'true' && !option.hasAttribute('data-disabled'))
    .map((option) => option.textContent)

  // By keyboard. The option turns Enter into a click it builds as a PointerEvent, which jsdom
  // lacks, so the window has a stand-in for as long as the choice takes.
  const choose = async (label: string) => {
    const option = (await openOptions()).find((element) => element.textContent === label)
    if (!option) throw new Error(`no option ${label}`)
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

  const retentionInput = () => {
    const labelElement = [...container.querySelectorAll('label')]
      .find((element) => element.textContent?.startsWith(RETENTION_LABEL))
    const element = labelElement && document.getElementById(labelElement.htmlFor)
    if (!(element instanceof HTMLInputElement)) throw new Error(`no input labeled ${RETENTION_LABEL}`)
    return element
  }

  const recentItems = () => [...card('Recent activity').querySelectorAll('li')]
    .filter((li) => li.parentElement?.parentElement === card('Recent activity'))

  const contentOnlySwitch = () => {
    const element = card('Recent activity').querySelector<HTMLElement>('[role="switch"]')
    if (!element) throw new Error('no content reads switch')
    return element
  }

  // The switch forwards a click as a PointerEvent, which jsdom lacks, so the window has a stand-in
  // for as long as the click takes.
  const flipContentOnly = async () => {
    const view: { PointerEvent?: typeof MouseEvent } = window
    view.PointerEvent = MouseEvent
    try {
      await click(contentOnlySwitch())
    } finally {
      delete view.PointerEvent
    }
  }

  beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    document.body.innerHTML = ''
    addToast.mockReset()
    vi.restoreAllMocks()
  })

  describe('the log', () => {
    it('loads the last week’s counts and the 20 newest records', async () => {
      const { getAdminAuditStats, listAdminAudit } = await render()

      expect(getAdminAuditStats).toHaveBeenCalledExactlyOnceWith({ days: 7 })
      expect(listAdminAudit).toHaveBeenCalledExactlyOnceWith({ limit: 20 })
    })

    it('shows the week’s total and each day’s count, oldest first, labelled with its date', async () => {
      await render()

      const week = card('Last 7 days')
      expect(week.textContent).toContain('5 events')
      const rows = [...week.querySelectorAll('tbody tr')]
      expect(rows.map((row) => row.querySelector('time')?.getAttribute('dateTime')))
        .toEqual(testStats().byDay.map(({ day }) => day))
      expect(rows.map((row) => row.lastElementChild?.textContent)).toEqual(['0', '1', '0', '0', '2', '0', '2'])
    })

    it('shows the top admins and workspaces, a workspace without a title by its id', async () => {
      await render()

      expect([...card('Top admins').querySelectorAll('li')].map((li) => li.textContent))
        .toEqual(['admin4', 'second-admin1'])
      expect([...card('Top workspaces').querySelectorAll('li')].map((li) => li.textContent))
        .toEqual(['Quarterly reportws-titled2', 'ws-untitledws-untitled1'])
    })

    it('shows a workspace access record: its time, admin, via, workspace, method, reason, access and refusal', async () => {
      await render()

      const [access] = recentItems()
      expect(access.textContent).toContain(`${formatFullTimestamp(ACCESS_AT)} · admin via CLI`)
      // An empty title falls back to the id.
      expect(access.textContent).toContain('ws-untitled')
      expect(access.textContent).toContain('getChat')
      expect(access.textContent).toContain('Reason: Ticket 42: agent stuck')
      expect(access.textContent).toContain('Access: Metadata only')
      expect(access.textContent).toContain('Content withheld')
    })

    it('badges an open the access level refused as access off', async () => {
      const admin = fakeAdmin()
      admin.listAdminAudit.mockResolvedValue(testPage([accessRecord({
        method: 'inspectWorkspace', access: 'off', refused: 'ADMIN_WORKSPACE_ACCESS_OFF',
        workspaceTitle: 'Payroll…',
      })]))

      await render(settingsWith(), admin)

      const [access] = recentItems()
      expect(access.textContent).toContain('Payroll…')
      expect(access.textContent).toContain('Access off')
      expect(access.textContent).toContain('Access: Off')
    })

    it('shows a setting record: its method, and each change as before → after', async () => {
      await render()

      const [, setting] = recentItems()
      expect(setting.textContent).toContain(`${formatFullTimestamp(SETTING_AT)} · second-admin via API`)
      expect(setting.textContent).toContain('setSiteName')
      expect(setting.textContent).toContain('siteNameOld name→ changed to New name')
    })

    it('names an entry by its key, shows an absent side as — (announced as none), and labels a keyless formats change as the order', async () => {
      const admin = fakeAdmin()
      admin.listAdminAudit.mockResolvedValue(testPage([settingRecord({
        method: 'setFormatOrder',
        changes: [
          { setting: 'formats', key: 'bp-new', after: '{"agentHint":"x"}' },
          { setting: 'formats', before: '["bp-a","bp-b"]', after: '["bp-b","bp-a"]' },
        ],
      })]))

      await render(settingsWith(), admin)

      const changes = [...recentItems()[0].querySelectorAll('li')].map((li) => li.textContent)
      expect(changes).toEqual([
        'formats · bp-new—none→ changed to {"agentHint":"x"}',
        'Order of formats["bp-a","bp-b"]→ changed to ["bp-b","bp-a"]',
      ])
      // The glyphs are hidden from screen readers, which hear "changed to" and "none" instead.
      const glyphs = [...recentItems()[0].querySelectorAll('li span')]
        .filter((span) => span.textContent === '→' || span.textContent === '—')
      expect(glyphs).toHaveLength(3)
      for (const glyph of glyphs) expect(glyph.getAttribute('aria-hidden')).toBe('true')
    })

    it('labels an excerpt with where it starts and the whole lengths', async () => {
      const admin = fakeAdmin()
      admin.listAdminAudit.mockResolvedValue(testPage([settingRecord({
        method: 'setInstanceInstructions',
        changes: [{
          setting: 'disabledResources', key: 'vendor',
          before: 'a'.repeat(100), after: 'b'.repeat(100),
          excerpt: { offset: 7900, beforeLength: 8000, afterLength: 8020 },
        }],
      })]))

      await render(settingsWith(), admin)

      expect(recentItems()[0].textContent)
        .toContain('Excerpt from character 7,901 · 8,000 → 8,020 characters')
    })

    it('says when there is nothing to show', async () => {
      const admin = fakeAdmin()
      admin.getAdminAuditStats.mockResolvedValue(testStats({ totalEvents: 0, topAdmins: [], topWorkspaces: [] }))
      admin.listAdminAudit.mockResolvedValue(testPage([]))

      await render(settingsWith(), admin)

      expect(card('Top admins').textContent).toContain('No admin activity in this window.')
      expect(card('Top workspaces').textContent).toContain('No workspace was inspected in this window.')
      expect(card('Recent activity').textContent).toContain('No admin activity is recorded yet.')
    })

    it('loads both again on Refresh', async () => {
      const { getAdminAuditStats, listAdminAudit } = await render()
      listAdminAudit.mockResolvedValueOnce(testPage([settingRecord({ admin: 'newest-admin' })]))

      await click(button('Refresh'))

      expect(getAdminAuditStats).toHaveBeenCalledTimes(2)
      expect(listAdminAudit).toHaveBeenCalledTimes(2)
      expect(recentItems()[0].textContent).toContain('newest-admin')
    })

    it('counts the week’s content reads', async () => {
      await render()
      expect(card('Last 7 days').textContent).toContain('2 content reads')
    })

    it('counts a single content read in the singular', async () => {
      const admin = fakeAdmin()
      admin.getAdminAuditStats.mockResolvedValue(testStats({ contentReads: 1 }))

      await render(settingsWith(), admin)

      expect(card('Last 7 days').textContent).toContain('1 content read')
      expect(card('Last 7 days').textContent).not.toContain('content reads')
    })

    it('marks a content read, and only a content read', async () => {
      const admin = fakeAdmin()
      admin.listAdminAudit.mockResolvedValue(testPage([
        accessRecord({ requested: 'full', access: 'full', exposed: 'content', refused: undefined }),
        accessRecord({ method: 'listChats', args: {}, requested: 'full', access: 'full', refused: undefined }),
      ]))

      await render(settingsWith(), admin)

      const [content, metadata] = recentItems()
      expect(content.textContent).toContain('Content read')
      expect(metadata.textContent).not.toContain('Content read')
    })

    it('shows the level asked for only where it differs from the level granted', async () => {
      const admin = fakeAdmin()
      admin.listAdminAudit.mockResolvedValue(testPage([
        accessRecord({ requested: 'full', access: 'metadata' }),
        accessRecord({ requested: 'metadata', access: 'off', refused: 'ADMIN_WORKSPACE_ACCESS_OFF' }),
        accessRecord({ requested: 'full', access: 'full', refused: undefined }),
      ]))

      await render(settingsWith(), admin)

      const [capped, off, granted] = recentItems()
      expect(capped.textContent).toContain('Access: Metadata only (Full requested)')
      expect(off.textContent).toContain('Access: Off (Metadata only requested)')
      expect(granted.textContent).toContain('Access: Full')
      expect(granted.textContent).not.toContain('requested')
    })

    describe('the content reads filter', () => {
      it('is a switch named “Content reads only”, off at first', async () => {
        await render()

        expect(accessibleName(contentOnlySwitch())).toBe('Content reads only')
        expect(contentOnlySwitch().getAttribute('aria-checked')).toBe('false')
      })

      it('loads only the content reads while on, and every record again once off', async () => {
        const { getAdminAuditStats, listAdminAudit } = await render()
        listAdminAudit.mockResolvedValueOnce(testPage([
          accessRecord({ reason: 'Ticket 43: read the chat', requested: 'full', access: 'full', exposed: 'content', refused: undefined }),
        ]))

        await flipContentOnly()

        expect(listAdminAudit).toHaveBeenLastCalledWith({ limit: 20, exposed: 'content' })
        expect(getAdminAuditStats).toHaveBeenCalledTimes(2)
        expect(contentOnlySwitch().getAttribute('aria-checked')).toBe('true')
        expect(recentItems()).toHaveLength(1)
        expect(recentItems()[0].textContent).toContain('Ticket 43: read the chat')

        await flipContentOnly()

        expect(listAdminAudit).toHaveBeenLastCalledWith({ limit: 20 })
        expect(listAdminAudit).toHaveBeenCalledTimes(3)
        expect(recentItems()).toHaveLength(2)
      })

      it('says when no content read is recorded', async () => {
        const { listAdminAudit } = await render()
        listAdminAudit.mockResolvedValueOnce(testPage([]))

        await flipContentOnly()

        expect(card('Recent activity').textContent).toContain('No content reads are recorded yet.')
        expect(card('Recent activity').textContent).not.toContain('No admin activity is recorded yet.')
      })

      it('stays on through Refresh', async () => {
        const { listAdminAudit } = await render()
        await flipContentOnly()

        await click(button('Refresh'))

        expect(listAdminAudit).toHaveBeenCalledTimes(3)
        expect(listAdminAudit).toHaveBeenLastCalledWith({ limit: 20, exposed: 'content' })
      })

      it('stays on through the reload after a settings change', async () => {
        const { listAdminAudit } = await render()
        await flipContentOnly()

        await choose('Full')

        expect(listAdminAudit).toHaveBeenCalledTimes(3)
        expect(listAdminAudit).toHaveBeenLastCalledWith({ limit: 20, exposed: 'content' })
      })

      it('ignores the load it superseded', async () => {
        const admin = fakeAdmin()
        await render(settingsWith(), admin)
        const unfiltered = deferred<AdminAuditPage>()
        admin.listAdminAudit.mockReturnValueOnce(unfiltered.promise as ReturnType<AdminApi['listAdminAudit']>)
        await click(button('Refresh'))
        admin.listAdminAudit.mockResolvedValueOnce(testPage([accessRecord({ reason: 'filtered', exposed: 'content' })]))

        await flipContentOnly()
        await act(async () => unfiltered.resolve(testPage([settingRecord({ admin: 'unfiltered-admin' })])))

        expect(recentItems()[0].textContent).toContain('filtered')
        expect(container.textContent).not.toContain('unfiltered-admin')
      })
    })

    // A change reloads the log so that its own record shows, even while an earlier load is out.
    it('ignores a load that a later one superseded', async () => {
      const admin = fakeAdmin()
      const first = deferred<AdminAuditPage>()
      admin.listAdminAudit.mockReturnValueOnce(first.promise as ReturnType<AdminApi['listAdminAudit']>)
      await render(settingsWith(), admin)
      admin.listAdminAudit.mockResolvedValueOnce(testPage([settingRecord({ admin: 'later-admin' })]))

      await choose('Full')
      expect(admin.listAdminAudit).toHaveBeenCalledTimes(2)
      await act(async () => first.resolve(testPage([settingRecord({ admin: 'earlier-admin' })])))

      expect(recentItems()[0].textContent).toContain('later-admin')
      expect(container.textContent).not.toContain('earlier-admin')
    })

    it('offers Retry after a failed load, which recovers', async () => {
      const admin = fakeAdmin()
      admin.listAdminAudit.mockRejectedValueOnce(new Error('The audit log is unavailable'))

      await render(settingsWith(), admin)

      expect(container.querySelector('[role="alert"]')?.textContent).toBe('Couldn’t load the admin audit log.')
      await click(button('Retry'))

      expect(container.querySelector('[role="alert"]')).toBeNull()
      expect(hasButton('Retry')).toBe(false)
      expect(card('Recent activity').textContent).toContain('Ticket 42: agent stuck')
    })

    // The router can serve this frontend before the backend updates.
    it('shows the error state, with the settings, when the backend has no audit methods', async () => {
      const admin = fakeAdmin()
      admin.getAdminAuditStats.mockRejectedValue(new TypeError('The RPC receiver does not implement the method "getAdminAuditStats".'))

      await render(settingsWith(), admin)

      expect(container.querySelector('[role="alert"]')?.textContent).toBe('Couldn’t load the admin audit log.')
      expect(hasButton('Retry')).toBe(true)
      expect(card('Workspace access')).toBeDefined()
      expect(card('Audit retention')).toBeDefined()
      expect(retentionInput().value).toBe('90')
    })
  })

  describe('workspace access', () => {
    it('shows the level enforced', async () => {
      await render(settingsWith({ access: { effective: 'metadata', chosen: 'full', max: 'metadata' } }))

      expect(accessSelect().textContent).toContain('Metadata only')
      expect(card('Workspace access').textContent)
        .toContain('Admins chose Full, which that maximum limits to Metadata only. Choose Metadata ' +
          'only to make it the admins’ choice, so that a higher maximum does not raise it.')
    })

    it('disables the levels above the deployment’s maximum, naming it', async () => {
      await render(settingsWith({ access: { max: 'metadata' } }))

      expect(await enabledOptions()).toEqual(['Off', 'Metadata only'])
      expect(card('Workspace access').textContent).toContain('This deployment allows at most Metadata only')
      expect(card('Workspace access').textContent).toContain('ADMIN_WORKSPACE_ACCESS_MAX')
    })

    it('leaves only Off when the deployment allows no inspection', async () => {
      await render(settingsWith({ access: { effective: 'off', chosen: 'metadata', max: 'off' } }))

      expect(await enabledOptions()).toEqual(['Off'])
      expect(card('Workspace access').textContent)
        .toContain('ADMIN_WORKSPACE_ACCESS_MAX allows no inspection')
    })

    it('sets the level chosen, then re-reads the settings and the log', async () => {
      const { setAdminWorkspaceAccess, onSettingsChanged, listAdminAudit } = await render()

      await choose('Full')

      expect(setAdminWorkspaceAccess).toHaveBeenCalledExactlyOnceWith('full')
      expect(onSettingsChanged).toHaveBeenCalledOnce()
      expect(setAdminWorkspaceAccess.mock.invocationCallOrder[0])
        .toBeLessThan(onSettingsChanged.mock.invocationCallOrder[0])
      expect(listAdminAudit).toHaveBeenCalledTimes(2)
    })

    it('stores the level shown as the admins’ choice while the maximum holds a higher one down', async () => {
      const { setAdminWorkspaceAccess, onSettingsChanged } =
        await render(settingsWith({ access: { effective: 'metadata', chosen: 'full', max: 'metadata' } }))

      await choose('Metadata only')

      expect(setAdminWorkspaceAccess).toHaveBeenCalledExactlyOnceWith('metadata')
      expect(onSettingsChanged).toHaveBeenCalledOnce()
    })

    it('sends nothing when the admins’ own choice is picked again', async () => {
      const { setAdminWorkspaceAccess, onSettingsChanged } = await render()

      await choose('Metadata only')

      expect(setAdminWorkspaceAccess).not.toHaveBeenCalled()
      expect(onSettingsChanged).not.toHaveBeenCalled()
    })

    it('is disabled while its change is in flight', async () => {
      const admin = fakeAdmin()
      const call = deferred()
      admin.setAdminWorkspaceAccess.mockReturnValueOnce(call.promise)
      await render(settingsWith(), admin)

      await choose('Full')
      expect(accessSelect().hasAttribute('data-disabled') || accessSelect().hasAttribute('disabled')).toBe(true)

      await act(async () => call.resolve())
      expect(accessSelect().hasAttribute('data-disabled') || accessSelect().hasAttribute('disabled')).toBe(false)
    })

    it('reports a failed change and keeps the server’s level', async () => {
      const admin = fakeAdmin()
      admin.setAdminWorkspaceAccess.mockRejectedValueOnce(new Error('ADMIN_WORKSPACE_ACCESS_MAX allows at most "metadata"'))
      const { onSettingsChanged } = await render(settingsWith(), admin)

      await choose('Full')

      expect(addToast).toHaveBeenCalledExactlyOnceWith({
        title: 'Couldn’t update “Workspace access”',
        description: 'ADMIN_WORKSPACE_ACCESS_MAX allows at most "metadata"',
        variant: 'error',
      })
      expect(onSettingsChanged).not.toHaveBeenCalled()
      expect(accessSelect().textContent).toContain('Metadata only')
    })
  })

  describe('audit retention', () => {
    it('saves the days typed, then re-reads the settings', async () => {
      const { setAdminAuditRetentionDays, onSettingsChanged } = await render()

      await type(retentionInput(), '365')
      await click(button(`Save “${RETENTION_LABEL}”`))

      expect(setAdminAuditRetentionDays).toHaveBeenCalledExactlyOnceWith(365)
      expect(onSettingsChanged).toHaveBeenCalledOnce()
    })

    it('refuses fewer days than the deployment’s minimum without a call', async () => {
      const { setAdminAuditRetentionDays } = await render(settingsWith({ retention: { effective: 120, chosen: 120, min: 120 } }))
      expect(card('Audit retention').textContent).toContain('at least 120 days')
      expect(card('Audit retention').textContent).toContain('ADMIN_AUDIT_RETENTION_MIN_DAYS')

      await type(retentionInput(), '119')
      await click(button(`Save “${RETENTION_LABEL}”`))

      expect(setAdminAuditRetentionDays).not.toHaveBeenCalled()
      expect(container.textContent)
        .toContain(`Enter a whole number of days from 120 to ${MAX_ADMIN_AUDIT_RETENTION_DAYS}`)
    })

    it('reports a failed save', async () => {
      const admin = fakeAdmin()
      admin.setAdminAuditRetentionDays.mockRejectedValueOnce(new Error('Retention must be a whole number'))
      await render(settingsWith(), admin)

      await type(retentionInput(), '365')
      await click(button(`Save “${RETENTION_LABEL}”`))

      expect(addToast).toHaveBeenCalledExactlyOnceWith({
        title: `Couldn’t update “${RETENTION_LABEL}”`,
        description: 'Retention must be a whole number',
        variant: 'error',
      })
      expect(retentionInput().value).toBe('365')
    })

    it('says when the deployment’s minimum holds the retention up, naming the admins’ choice', async () => {
      await render(settingsWith({ retention: { effective: 180, chosen: 30, min: 180 } }))

      const text = card('Audit retention').textContent
      expect(text).toContain('Admins chose 30 days')
      expect(text).toContain('minimum of 180 days is what holds the retention up')
      expect(text).toContain('choice of 30 days applies again')
      expect(retentionInput().value).toBe('180')
    })

    it('says nothing of the minimum while the admins’ choice is at or above it', async () => {
      await render(settingsWith({ retention: { effective: 365, chosen: 365, min: 90 } }))

      expect(card('Audit retention').textContent).not.toContain('holds the retention up')
    })
  })
})
