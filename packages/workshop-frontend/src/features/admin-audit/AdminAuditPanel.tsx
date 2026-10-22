import { useEffect, useId, useRef, useState } from 'react'
import { Badge, Button, Loader, Select, Switch, Table, useKumoToastManager } from '@cloudflare/kumo'
import { ArrowsClockwise } from '@phosphor-icons/react'
import type { RpcStub } from 'capnweb'
import {
  ADMIN_ACCESS_ERROR_CODES,
  ADMIN_WORKSPACE_ACCESS_LEVELS,
  MAX_ADMIN_AUDIT_RETENTION_DAYS,
} from '@gadgets/workshop-shared/api'
import type {
  AdminAccessRecord,
  AdminApi,
  AdminAuditRecord,
  AdminAuditStats,
  AdminSettingChange,
  AdminSettingRecord,
  AdminVia,
  AdminWorkspaceAccess,
} from '@gadgets/workshop-shared/api'
import { DurationSetting } from '../../components/DurationSetting'
import { logRpcFailure, rpcFailureDescription } from '../../rpcErrors'
import { formatFullTimestamp } from '../../utils/formatTimestamp'
import type { AuditSettings } from './auditSettings'

type AdminAuditPanelProps = {
  admin: RpcStub<AdminApi>
  /** What the server last reported. */
  settings: AuditSettings
  /**
   * Re-reads the settings after a change, so that the panel shows what the server holds. Rejects
   * when the re-read failed.
   */
  onSettingsChanged: () => Promise<void>
}

const CARD = 'bg-kumo-elevated border border-kumo-line rounded-xl p-6'
const ACCESS_LABEL = 'Workspace access'
const RETENTION_LABEL = 'Keep audit records for (days)'
const STATS_DAYS = 7
const RECENT_LIMIT = 20

const ACCESS_LEVEL_NAMES: Record<AdminWorkspaceAccess, string> = {
  off: 'Off',
  metadata: 'Metadata only',
  full: 'Full',
}

const VIA_NAMES: Record<AdminVia, string> = { api: 'API', cli: 'CLI' }

const REFUSAL_NAMES: Record<NonNullable<AdminAccessRecord['refused']>, string> = {
  [ADMIN_ACCESS_ERROR_CODES.contentWithheld]: 'Content withheld',
  [ADMIN_ACCESS_ERROR_CODES.accessOff]: 'Access off',
}

// The settings stored as lists of entries with ids, whose keyless change is a change of order.
const ORDERED_SETTING_NAMES = new Map([
  ['formats', 'formats'],
  ['addedModels', 'added models'],
])

const accessRank = (level: AdminWorkspaceAccess) => ADMIN_WORKSPACE_ACCESS_LEVELS.indexOf(level)

const NUMBER = new Intl.NumberFormat('en')

// A UTC day (YYYY-MM-DD), named as a date. The stats count UTC days, so it is read in UTC.
const DAY = new Intl.DateTimeFormat('en', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })
const dayName = (day: string) => {
  const date = new Date(`${day}T00:00:00Z`)
  return Number.isNaN(date.getTime()) ? day : DAY.format(date)
}

type Activity =
  | { state: 'loading' }
  | { state: 'failed' }
  | {
    state: 'loaded'
    stats: AdminAuditStats
    records: AdminAuditRecord[]
    /** Whether `records` were loaded as content reads only. */
    contentOnly: boolean
    refreshing: boolean
  }

const changeName = (change: AdminSettingChange) => {
  if (change.key !== undefined) return `${change.setting} · ${change.key}`
  const ordered = ORDERED_SETTING_NAMES.get(change.setting)
  return ordered === undefined ? change.setting : `Order of ${ordered}`
}

// Where an excerpt starts and how long the values it was cut from are, in words.
const excerptLabel = ({ offset, beforeLength, afterLength }: NonNullable<AdminSettingChange['excerpt']>) => {
  const length = (characters: number | undefined) => characters === undefined ? '—' : NUMBER.format(characters)
  return `Excerpt from character ${NUMBER.format(offset + 1)} · ` +
    `${length(beforeLength)} → ${length(afterLength)} characters`
}

// One side of a change, verbatim: a value may be thousands of characters, so it is clamped to a
// few lines, with the whole value in its tooltip. An absent side shows a dash, which a screen
// reader would read as "em dash", so it is announced as "none".
const ChangeValue = ({ value }: { value: string | undefined }) => (
  <span
    title={value}
    className="min-w-0 font-mono text-xs text-kumo-default whitespace-pre-wrap break-all line-clamp-3"
  >
    {value ?? (
      <>
        <span aria-hidden="true">—</span>
        <span className="sr-only">none</span>
      </>
    )}
  </span>
)

const SettingChanges = ({ record }: { record: AdminSettingRecord }) => (
  <ul className="mt-2 space-y-2">
    {record.changes.map((change, index) => (
      <li key={index} className="text-sm">
        <p className="font-mono text-xs text-kumo-subtle break-all">{changeName(change)}</p>
        <div className="mt-0.5 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-start gap-2">
          <ChangeValue value={change.before} />
          {/* The arrow glyph reads as "right arrow", and a plain span's aria-label is ignored. */}
          <span className="text-kumo-subtle">
            <span aria-hidden="true">→</span>
            <span className="sr-only"> changed to </span>
          </span>
          <ChangeValue value={change.after} />
        </div>
        {change.excerpt && (
          <p className="mt-0.5 text-xs text-kumo-subtle">{excerptLabel(change.excerpt)}</p>
        )}
      </li>
    ))}
  </ul>
)

const WorkspaceAccess = ({ record }: { record: AdminAccessRecord }) => (
  <div className="mt-1 space-y-0.5 text-sm">
    <p className="flex flex-wrap items-center gap-2">
      <span className="font-medium text-kumo-default break-all">{record.workspaceTitle || record.workspaceId}</span>
      <span className="font-mono text-xs text-kumo-subtle">{record.method}</span>
      {record.exposed === 'content' && <Badge variant="info">Content read</Badge>}
      {record.refused && <Badge variant="warning">{REFUSAL_NAMES[record.refused]}</Badge>}
    </p>
    <p className="text-kumo-subtle break-words">
      <span className="text-kumo-default">Reason:</span> {record.reason}
    </p>
    <p className="text-kumo-subtle">
      <span className="text-kumo-default">Access:</span> {ACCESS_LEVEL_NAMES[record.access]}
      {record.requested !== record.access && ` (${ACCESS_LEVEL_NAMES[record.requested]} requested)`}
    </p>
  </div>
)

const RecentRecord = ({ record }: { record: AdminAuditRecord }) => (
  <li className="py-3 first:pt-0 last:pb-0">
    <p className="text-xs text-kumo-subtle">
      {formatFullTimestamp(record.at)} · <span className="text-kumo-default">{record.admin}</span>
      {' '}via {VIA_NAMES[record.via]}
    </p>
    {record.kind === 'workspace'
      ? <WorkspaceAccess record={record} />
      : (
        <>
          <p className="mt-1 font-mono text-sm text-kumo-default">{record.method}</p>
          <SettingChanges record={record} />
        </>
      )}
  </li>
)

const EmptyNote = ({ children }: { children: string }) => (
  <p className="text-sm text-kumo-subtle">{children}</p>
)

const ActivityCards = ({ stats, records, recordsContentOnly, contentOnly, onContentOnlyChange }: {
  stats: AdminAuditStats
  records: AdminAuditRecord[]
  /** Whether `records` are content reads only. */
  recordsContentOnly: boolean
  /** Whether the filter asks for content reads only, which a load may not have answered yet. */
  contentOnly: boolean
  onContentOnlyChange: (contentOnly: boolean) => void
}) => (
  <>
    <div className="grid items-start gap-6 md:grid-cols-2">
      <div className={CARD}>
        <h3 className="text-lg font-semibold text-kumo-strong mb-1">Last {stats.days} days</h3>
        <p className="text-sm text-kumo-subtle mb-4">
          <span className="text-2xl font-semibold text-kumo-default tabular-nums">{NUMBER.format(stats.totalEvents)}</span>
          {' '}{stats.totalEvents === 1 ? 'event' : 'events'}, by UTC day
          <span className="block mt-1">
            {NUMBER.format(stats.contentReads)} {stats.contentReads === 1 ? 'content read' : 'content reads'}
          </span>
        </p>
        <Table>
          <Table.Header>
            <Table.Row>
              <Table.Head>Day</Table.Head>
              <Table.Head className="text-right">Events</Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {stats.byDay.map(({ day, count }) => (
              <Table.Row key={day}>
                <Table.Cell><time dateTime={day}>{dayName(day)}</time></Table.Cell>
                <Table.Cell className="text-right tabular-nums">{NUMBER.format(count)}</Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      </div>

      <div className="space-y-6">
        <div className={CARD}>
          <h3 className="text-lg font-semibold text-kumo-strong mb-4">Top admins</h3>
          {stats.topAdmins.length === 0
            ? <EmptyNote>No admin activity in this window.</EmptyNote>
            : (
              <ul className="space-y-2 text-sm">
                {stats.topAdmins.map(({ admin, count }) => (
                  <li key={admin} className="flex items-baseline justify-between gap-4">
                    <span className="min-w-0 break-all text-kumo-default">{admin}</span>
                    <span className="tabular-nums text-kumo-subtle">{NUMBER.format(count)}</span>
                  </li>
                ))}
              </ul>
            )}
        </div>

        <div className={CARD}>
          <h3 className="text-lg font-semibold text-kumo-strong mb-4">Top workspaces</h3>
          {stats.topWorkspaces.length === 0
            ? <EmptyNote>No workspace was inspected in this window.</EmptyNote>
            : (
              <ul className="space-y-2 text-sm">
                {stats.topWorkspaces.map(({ workspaceId, title, count }) => (
                  <li key={workspaceId} className="flex items-baseline justify-between gap-4">
                    <span className="min-w-0">
                      <span className="block break-all text-kumo-default">{title || workspaceId}</span>
                      <span className="block break-all font-mono text-xs text-kumo-subtle">{workspaceId}</span>
                    </span>
                    <span className="tabular-nums text-kumo-subtle">{NUMBER.format(count)}</span>
                  </li>
                ))}
              </ul>
            )}
        </div>
      </div>
    </div>

    <div className={`${CARD} grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4`}>
      <h3 className="text-lg font-semibold text-kumo-strong">Recent activity</h3>
      <Switch label="Content reads only" checked={contentOnly} onCheckedChange={onContentOnlyChange} />
      {records.length === 0
        ? (
          <div className="col-span-2">
            <EmptyNote>
              {recordsContentOnly ? 'No content reads are recorded yet.' : 'No admin activity is recorded yet.'}
            </EmptyNote>
          </div>
        )
        : (
          <ul className="col-span-2 divide-y divide-kumo-line">
            {records.map((record, index) => (
              <RecentRecord key={`${record.at.getTime()}:${index}`} record={record} />
            ))}
          </ul>
        )}
    </div>
  </>
)

const accessHelp = ({ chosen, effective, max }: AuditSettings['adminWorkspaceAccess']): string[] => {
  const help = [
    'The most of a workspace an admin may see when inspecting it: each inspection asks for ' +
      'Metadata only (the default) or Full, and gets the lower of that and this level. Metadata ' +
      'only withholds chat messages, file contents, and the descriptions of actions, observations ' +
      'and hooks; titles stay, and can echo content. Off refuses inspection. Lowering it reaches ' +
      'views already open within about a minute.',
  ]
  if (max === 'off') {
    help.push('This deployment’s ADMIN_WORKSPACE_ACCESS_MAX allows no inspection (a value that is ' +
      'not a level counts as off).')
  } else {
    help.push(`This deployment allows at most ${ACCESS_LEVEL_NAMES[max]}, which only a change to ` +
      'its ADMIN_WORKSPACE_ACCESS_MAX variable can raise.')
  }
  if (chosen !== effective) {
    help.push(`Admins chose ${ACCESS_LEVEL_NAMES[chosen]}, which that maximum limits to ` +
      `${ACCESS_LEVEL_NAMES[effective]}. Choose ${ACCESS_LEVEL_NAMES[effective]} to make it the ` +
      'admins’ choice, so that a higher maximum does not raise it.')
  }
  return help
}

/**
 * The admin Audit tab: what the deployment-wide admin audit log holds for the last week, its most
 * recent records (all of them, or only the content reads), and the settings that bound admin access
 * to workspaces and the log's retention.
 */
export const AdminAuditPanel = ({ admin, settings, onSettingsChanged }: AdminAuditPanelProps) => {
  const toasts = useKumoToastManager()
  const [activity, setActivity] = useState<Activity>({ state: 'loading' })
  // Each load is one value of this; a new one supersedes those before it.
  const [loads, setLoads] = useState(0)
  const [contentOnly, setContentOnly] = useState(false)
  const [savingAccess, setSavingAccess] = useState(false)
  const activityHeading = useId()
  const { adminWorkspaceAccess: access, adminAuditRetentionDays: retention } = settings

  useEffect(() => {
    let current = true
    // Both or neither: a backend older than the audit log rejects either as an unknown method.
    Promise.all([
      admin.getAdminAuditStats({ days: STATS_DAYS }),
      admin.listAdminAudit(contentOnly ? { limit: RECENT_LIMIT, exposed: 'content' } : { limit: RECENT_LIMIT }),
    ]).then(
      ([stats, page]) => {
        if (current) setActivity({ state: 'loaded', stats, records: page.records, contentOnly, refreshing: false })
      },
      (err: unknown) => {
        if (!current) return
        logRpcFailure('Failed to load the admin audit log:', err)
        setActivity({ state: 'failed' })
      },
    )
    return () => { current = false }
  }, [admin, loads, contentOnly])

  // reload() and changeContentOnly() load the log again, keeping what is shown until the new load
  // answers.
  const showRefreshing = () =>
    setActivity((shown) => shown.state === 'loaded' ? { ...shown, refreshing: true } : { state: 'loading' })
  const reload = () => {
    showRefreshing()
    setLoads((n) => n + 1)
  }
  const changeContentOnly = (on: boolean) => {
    showRefreshing()
    setContentOnly(on)
  }

  // The access select is disabled while its change is in flight, and a browser takes focus from a
  // control that becomes disabled without giving it back. So the control that had focus when the
  // change began gets it again once it settles, unless focus has gone elsewhere since.
  const focusBeforeSave = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (savingAccess) return
    if (document.activeElement === document.body) focusBeforeSave.current?.focus()
    focusBeforeSave.current = null
  }, [savingAccess])

  const reportFailure = (title: string, err: unknown) => {
    logRpcFailure(`${title}:`, err)
    toasts.add({ title, description: rpcFailureDescription(err), variant: 'error' })
  }

  // Resolves whether `op` went through and the settings were re-read after it. Once it went
  // through, the log is loaded again so that the change's own record shows.
  const change = async (failureTitle: string, op: () => Promise<unknown>): Promise<boolean> => {
    try {
      await op()
    } catch (err) {
      reportFailure(failureTitle, err)
      return false
    }
    reload()
    try {
      await onSettingsChanged()
      return true
    } catch (err) {
      reportFailure('Couldn’t reload the admin settings', err)
      return false
    }
  }

  const changeAccess = async (level: AdminWorkspaceAccess) => {
    // Against the stored choice, not the level shown: picking the shown level again while the
    // maximum holds a higher choice down makes it the admins' choice, which a later rise of
    // ADMIN_WORKSPACE_ACCESS_MAX then cannot raise.
    if (level === access.chosen) return
    focusBeforeSave.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setSavingAccess(true)
    try {
      await change(`Couldn’t update “${ACCESS_LABEL}”`, () => admin.setAdminWorkspaceAccess(level))
    } finally {
      setSavingAccess(false)
    }
  }

  return (
    <div className="space-y-6">
      <section className="space-y-6" aria-labelledby={activityHeading}>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <h2 id={activityHeading} className="text-lg font-semibold text-kumo-strong">Admin activity</h2>
            <p className="text-sm text-kumo-subtle mt-0.5">
              Every change an admin makes to the deployment&rsquo;s settings, and every admin call into a
              workspace, kept for {NUMBER.format(retention.effective)} days.
            </p>
          </div>
          <Button
            variant="secondary"
            size="sm"
            icon={ArrowsClockwise}
            loading={activity.state === 'loaded' && activity.refreshing}
            disabled={activity.state === 'loading' || (activity.state === 'loaded' && activity.refreshing)}
            onClick={reload}
          >
            Refresh
          </Button>
        </div>

        {activity.state === 'loading' && (
          <div className="flex justify-center py-16">
            <Loader size="lg" />
          </div>
        )}
        {activity.state === 'failed' && (
          <div className={`${CARD} text-center`}>
            <p role="alert" className="text-sm text-kumo-danger">Couldn’t load the admin audit log.</p>
            <Button variant="secondary" size="sm" className="mt-3" onClick={reload}>Retry</Button>
          </div>
        )}
        {activity.state === 'loaded' && (
          <ActivityCards
            stats={activity.stats}
            records={activity.records}
            recordsContentOnly={activity.contentOnly}
            contentOnly={contentOnly}
            onContentOnlyChange={changeContentOnly}
          />
        )}
      </section>

      <div className={CARD}>
        <h2 className="text-lg font-semibold text-kumo-strong mb-4">{ACCESS_LABEL}</h2>
        <Select<AdminWorkspaceAccess>
          label="Access level"
          value={access.effective}
          disabled={savingAccess}
          onValueChange={(level) => { if (level !== null) void changeAccess(level) }}
          renderValue={(level) => ACCESS_LEVEL_NAMES[level]}
          description={(
            <span className="block space-y-1">
              {accessHelp(access).map((text) => <span key={text} className="block">{text}</span>)}
            </span>
          )}
        >
          {ADMIN_WORKSPACE_ACCESS_LEVELS.map((level) => (
            <Select.Option key={level} value={level} disabled={accessRank(level) > accessRank(access.max)}>
              {ACCESS_LEVEL_NAMES[level]}
            </Select.Option>
          ))}
        </Select>
      </div>

      <div className={CARD}>
        <h2 className="text-lg font-semibold text-kumo-strong mb-4">Audit retention</h2>
        {retention.chosen < retention.min && (
          <p className="text-sm text-kumo-subtle mb-4">
            Admins chose {NUMBER.format(retention.chosen)} days, so this deployment&rsquo;s minimum
            of {NUMBER.format(retention.min)} days is what holds the retention up. If a deploy lowers
            or removes ADMIN_AUDIT_RETENTION_MIN_DAYS, as a deploy tool that writes the
            backend&rsquo;s variables without it does, the admins&rsquo; choice
            of {NUMBER.format(retention.chosen)} days applies again. To keep a retention either way,
            type the number of days and save it, even the minimum.
          </p>
        )}
        <div className="max-w-md">
          <DurationSetting
            label={RETENTION_LABEL}
            help={
              'How long the admin audit log keeps a record, in the deployment-wide log and in each ' +
              `workspace inspected. This deployment keeps at least ${NUMBER.format(retention.min)} days, ` +
              'which its ADMIN_AUDIT_RETENTION_MIN_DAYS variable sets.'
            }
            unit="days"
            min={retention.min}
            max={MAX_ADMIN_AUDIT_RETENTION_DAYS}
            value={retention.effective}
            onSave={(days) =>
              change(`Couldn’t update “${RETENTION_LABEL}”`, () => admin.setAdminAuditRetentionDays(days))}
          />
        </div>
      </div>
    </div>
  )
}
