import { Button, Dialog, Switch } from '@cloudflare/kumo'
import { CaretRightIcon, LockSimpleIcon } from '@phosphor-icons/react'
import { WorkshopButton } from '../../components/WorkshopControls'

type Props = {
  resource: 'workspace' | 'gadget'
  locked: boolean
  inheritedLock: boolean
  onLockedChange: (locked: boolean) => void
  invitations?: {
    ownerOnly: boolean
    requiredBy: 'resources' | 'workspace' | null
    onOwnerOnlyChange: (ownerOnly: boolean) => void
  }
  onRemoveEveryone: () => void
  onBack: () => void
}

export const OwnerControls = ({ resource, locked, inheritedLock, onLockedChange, invitations, onRemoveEveryone, onBack }: Props) => (
  <>
    <div className="chat-panel min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-none px-4 pb-6 sm:px-6">
      <Dialog.Description className="text-sm text-kumo-subtle">
        Manage sharing restrictions for this {resource}{resource === 'workspace' ? ' and all gadgets inside it' : ''}.
      </Dialog.Description>
      {inheritedLock && (
        <p className="flex items-start gap-2 rounded-xl bg-kumo-banner-info px-3 py-2.5 text-xs text-kumo-info">
          <LockSimpleIcon size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
          Access is locked by the workspace. Unlock the workspace to restore gadget access.
        </p>
      )}
      <div className="divide-y divide-kumo-line overflow-hidden rounded-xl border border-kumo-line">
        <div className="flex items-start justify-between gap-4 p-3">
          <div className="space-y-1">
            <p className="text-sm font-medium text-kumo-default">Lock access</p>
            <p className="text-xs leading-relaxed text-kumo-subtle">
              Only you can access this {resource}{resource === 'workspace' ? ' and its gadgets' : ''} while locked. Unlocking restores saved permissions.
            </p>
          </div>
          <Switch size="sm" aria-label="Lock access" checked={locked} disabled={inheritedLock} onCheckedChange={onLockedChange} className="mt-0.5 shrink-0" />
        </div>
        {invitations && (
          <div className="flex items-start justify-between gap-4 p-3">
            <div className="space-y-1">
              <p className="text-sm font-medium text-kumo-default">{resource === 'workspace' ? 'Only owners can invite' : 'Only owners can share'}</p>
              <p className="text-xs leading-relaxed text-kumo-subtle">
                {invitations.requiredBy === 'resources'
                  ? 'Required by this workspace’s protected resources.'
                  : invitations.requiredBy === 'workspace'
                    ? 'Required by the workspace’s owner controls.'
                    : resource === 'workspace'
                      ? 'Members can edit, but only you can invite people or share gadgets.'
                      : 'Workspace members can edit, but only you can share this gadget.'}
              </p>
            </div>
            <Switch size="sm" aria-label={resource === 'workspace' ? 'Only owners can invite' : 'Only owners can share'} checked={invitations.ownerOnly} disabled={invitations.requiredBy !== null} onCheckedChange={invitations.onOwnerOnlyChange} className="mt-0.5 shrink-0" />
          </div>
        )}
        <Button variant="ghost" aria-label="Remove everyone" className="h-auto w-full justify-between gap-4 rounded-none p-3 text-left" onClick={onRemoveEveryone}>
          <span className="min-w-0 space-y-1">
            <span className="block text-sm font-medium text-kumo-danger">Remove everyone</span>
            <span className="block text-xs font-normal leading-relaxed text-kumo-subtle">
              {resource === 'workspace'
                ? 'Clear all permissions. People will need to be invited again.'
                : 'Clear individual shares and organization access. Workspace members keep edit access.'}
            </span>
          </span>
          <CaretRightIcon size={14} className="shrink-0 text-kumo-subtle" aria-hidden="true" />
        </Button>
      </div>
    </div>
    <div className="flex shrink-0 justify-end border-t border-kumo-line px-4 py-4 sm:px-6">
      <WorkshopButton onClick={onBack}>Done</WorkshopButton>
    </div>
  </>
)
