import type { Ref } from 'react'
import { Checkbox, Dialog } from '@cloudflare/kumo'
import type { AffectedCollaborator } from '@gadgets/workshop-shared/api'
import { WorkshopButton } from '../../components/WorkshopControls'

const DependentKeepList = ({
  dependents,
  keepSet,
  onKeepSetChange,
}: {
  dependents: AffectedCollaborator[]
  keepSet: Set<string>
  onKeepSetChange: (next: Set<string>) => void
}) => (
  <div className="space-y-1.5">
    {dependents.map(dep => (
      <div
        key={dep.profile.id}
        className={`rounded-xl px-3 py-2 transition-colors ${
          keepSet.has(dep.profile.id) ? 'bg-kumo-tint' : 'bg-kumo-elevated/50 hover:bg-kumo-elevated'
        }`}
      >
        <Checkbox
          label={(
            <span className="flex min-w-0 items-baseline gap-1.5">
              <span className="truncate text-[12px] font-medium text-kumo-default">{dep.profile.name}</span>
              <span className="truncate text-[11px] text-kumo-subtle">{dep.profile.id}</span>
            </span>
          )}
          checked={keepSet.has(dep.profile.id)}
          onCheckedChange={(checked) => {
            const next = new Set(keepSet)
            if (checked) next.add(dep.profile.id)
            else next.delete(dep.profile.id)
            onKeepSetChange(next)
          }}
        />
      </div>
    ))}
  </div>
)

type Props = {
  name: string
  previewing: boolean
  /** Whether removing the direct grant leaves the person with no access at all. */
  losesAccess: boolean
  /** Other people whose access depends on this person's grant. */
  downstream: AffectedCollaborator[]
  keepSet: Set<string>
  onKeepSetChange: (keepSet: Set<string>) => void
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
  cancelRef: Ref<HTMLButtonElement>
}

/** The body and footer of the dialog's "Remove <person>?" view. */
export const RemovalConfirmation = ({
  name,
  previewing,
  losesAccess,
  downstream,
  keepSet,
  onKeepSetChange,
  busy,
  onCancel,
  onConfirm,
  cancelRef,
}: Props) => (
  <>
    <div className="chat-panel min-h-0 flex-1 overflow-y-auto overscroll-none px-4 pb-6 sm:px-6">
      <Dialog.Description className="text-sm text-kumo-subtle">
        {previewing
          ? 'Checking who will be affected…'
          : losesAccess
            ? `This user will lose access to this workspace.`
            : `Your direct grant will be removed. ${name} may still have access through another source.`}
      </Dialog.Description>
      {downstream.length > 0 && (
        <div className="mt-4 space-y-2">
          <p className="text-sm text-kumo-subtle">
            These people will also lose access or have reduced access. Select anyone to keep.
          </p>
          <DependentKeepList dependents={downstream} keepSet={keepSet} onKeepSetChange={onKeepSetChange} />
        </div>
      )}
    </div>
    <div className="flex shrink-0 items-center justify-end gap-2 border-t border-kumo-line px-4 py-4 sm:px-6">
      <WorkshopButton ref={cancelRef} disabled={busy} onClick={onCancel}>
        Cancel
      </WorkshopButton>
      <WorkshopButton tone="danger" disabled={previewing || busy} onClick={onConfirm}>
        {busy ? 'Removing…' : 'Remove'}
      </WorkshopButton>
    </div>
  </>
)
