import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Button, Dialog, DropdownMenu, useKumoToastManager } from '@cloudflare/kumo'
import { BuildingsIcon, CaretDownIcon, CaretLeftIcon, CaretRightIcon, Check, Link, LockSimpleIcon, UsersThreeIcon, XIcon } from '@phosphor-icons/react'
import type { RpcStub } from 'capnweb'
import type { AiChatAuthorInfo, AuthenticatedApi, CollaboratorInfo, GadgetMetadata, GadgetSharingInfo, Overseer, WorkpieceId } from '@gadgets/workshop-shared/api'
import { WorkshopButton, WorkshopIconButton } from '../../components/WorkshopControls'
import { copyToClipboard } from '../../clipboard'
import { useServerConfig } from '../../ServerConfigContext'
import { CollaboratorList } from './CollaboratorList'
import { InviteComposer } from './InviteComposer'
import { OwnerControls } from './OwnerControls'
import { ProtectedResourcesList } from './ProtectedResourcesList'
import { RemovalConfirmation } from './RemovalConfirmation'
import { RemoveEveryoneConfirmation } from './RemoveEveryoneConfirmation'
import { useObserverRequirements } from './useObserverRequirements'
import { usePrototypeOwnerControls } from './usePrototypeOwnerControls'

type Props = {
  open: boolean
  onClose: () => void
  overseer: RpcStub<Overseer>
  metadata: GadgetMetadata
  gadget: { id: WorkpieceId; title: string }
  currentUser: AiChatAuthorInfo | null
  authenticatedApi: RpcStub<AuthenticatedApi>
}

export const GadgetShareModal = ({ open, onClose, overseer, metadata, gadget, currentUser, authenticatedApi }: Props) => {
  const toasts = useKumoToastManager()
  const toastsRef = useRef(toasts)
  toastsRef.current = toasts
  const searchEnabled = useServerConfig()?.userSearchEnabled ?? false
  const [sharing, setSharing] = useState<GadgetSharingInfo | null>(null)
  const [members, setMembers] = useState<CollaboratorInfo[]>([])
  const [membership, setMembership] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [username, setUsername] = useState('')
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [showResources, setShowResources] = useState(false)
  const [removeTarget, setRemoveTarget] = useState<CollaboratorInfo | null>(null)
  const [landedPersonId, setLandedPersonId] = useState<string | null>(null)
  const [ownerView, setOwnerView] = useState<'controls' | 'remove-everyone' | null>(null)
  const ownerControls = usePrototypeOwnerControls(metadata.id, gadget.id)
  const ownerControlsRef = useRef<HTMLButtonElement>(null)
  const ownerBackRef = useRef<HTMLButtonElement>(null)
  const previousOwnerView = useRef<typeof ownerView>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const backRef = useRef<HTMLButtonElement>(null)
  const resourcesRef = useRef<HTMLButtonElement>(null)
  const cancelRemovalRef = useRef<HTMLButtonElement>(null)
  const copyRef = useRef<HTMLButtonElement>(null)
  const triggerRefs = useRef(new Map<string, HTMLButtonElement>())
  const previousRemoval = useRef<string | null>(null)
  const restoreResourcesFocus = useRef(false)
  const mutationRef = useRef(false)
  const requestId = useRef(0)
  const isOwner = !metadata.owner
  const canShare = !ownerControls.locked && metadata.role !== 'use' && (isOwner ||
    (metadata.ownerInvitesOnly !== true && !ownerControls.workspace.ownerInvitesOnly && !ownerControls.access.ownerInvitesOnly))
  const owner = isOwner ? currentUser : metadata.owner ?? null
  const viewers = ownerControls.locked ? [] : (sharing?.viewers ?? []).filter(person =>
    !ownerControls.access.cleared || ownerControls.access.restoredProfileIds.includes(person.profile.id))
  const workspaceMembers = members.filter(person => !ownerControls.workspace.cleared || ownerControls.workspace.restoredProfileIds.includes(person.profile.id))
  const workspaceAccess = !ownerControls.locked
  const allUsersCanView = !ownerControls.locked && (ownerControls.access.allUsersCanView ?? sharing?.allUsersCanView ?? false)
  const excludeIds = [...new Set([...(currentUser ? [currentUser.id] : []), ...(owner ? [owner.id] : []),
    ...(workspaceAccess ? workspaceMembers.map(person => person.profile.id) : []), ...viewers.map(person => person.profile.id)])]
  const { requirements, failed: requirementsFailed } = useObserverRequirements(overseer, open, gadget.id)
  const removalId = removeTarget?.profile.id ?? null

  const loadData = useCallback(async () => {
    const request = ++requestId.current
    try {
      const [access, people] = await Promise.all([overseer.getGadgetSharing(gadget.id), overseer.listCollaborators()])
      if (request !== requestId.current) return
      setSharing(access)
      setMembers(people.filter(person => (person.role ?? 'build') === 'build'))
      setMembership('ready')
    } catch {
      if (request !== requestId.current) return
      setMembership('failed')
      toastsRef.current.add({ title: 'Failed to load gadget sharing.', variant: 'error' })
    }
  }, [overseer, gadget.id])

  useEffect(() => {
    if (!open) return
    setMembership('loading')
    setUsername('')
    setError(null)
    setCopied(false)
    setShowResources(false)
    setRemoveTarget(null)
    setOwnerView(null)
    void loadData()
    return () => { requestId.current++ }
  }, [open, loadData])

  useEffect(() => {
    if (!landedPersonId) return
    const timer = window.setTimeout(() => setLandedPersonId(null), 2200)
    return () => window.clearTimeout(timer)
  }, [landedPersonId])

  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 2000)
    return () => window.clearTimeout(timer)
  }, [copied])

  useLayoutEffect(() => {
    if (showResources) backRef.current?.focus({ preventScroll: true })
    else if (restoreResourcesFocus.current) {
      resourcesRef.current?.focus({ preventScroll: true })
      restoreResourcesFocus.current = false
    }
  }, [showResources])

  useLayoutEffect(() => {
    if (removalId) cancelRemovalRef.current?.focus({ preventScroll: true })
    else if (previousRemoval.current) {
      (triggerRefs.current.get(previousRemoval.current) ?? inputRef.current ?? copyRef.current)?.focus({ preventScroll: true })
    }
    previousRemoval.current = removalId
  }, [removalId])

  useLayoutEffect(() => {
    if (ownerView === 'controls') ownerBackRef.current?.focus({ preventScroll: true })
    else if (!ownerView && previousOwnerView.current) ownerControlsRef.current?.focus({ preventScroll: true })
    previousOwnerView.current = ownerView
  }, [ownerView])

  const share = async (userId: string) => {
    if (!canShare || mutationRef.current) return
    mutationRef.current = true
    setAdding(true)
    setError(null)
    try {
      const person = await overseer.addGadgetViewer(gadget.id, userId)
      if (!person) { setError('No account found for that username or email.'); return }
      ownerControls.restoreProfile(person.profile.id)
      setUsername('')
      await loadData()
      setLandedPersonId(person.profile.id)
      toasts.add({ title: `Shared with ${person.profile.name}.`, variant: 'success' })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to share gadget.')
    } finally {
      mutationRef.current = false
      setAdding(false)
      inputRef.current?.focus({ preventScroll: true })
    }
  }

  const updateAccess = async (action: () => Promise<void>) => {
    if (!canShare || mutationRef.current) return
    mutationRef.current = true
    setBusy(true)
    try {
      await action()
      await loadData()
      setRemoveTarget(null)
    } catch (err) {
      toasts.add({ title: err instanceof Error ? err.message : 'Failed to update gadget access.', variant: 'error' })
    } finally {
      mutationRef.current = false
      setBusy(false)
    }
  }

  const copyLink = async () => {
    if (await copyToClipboard(`${window.location.origin}/workspace/${metadata.id}?w=${gadget.id}`)) setCopied(true)
    else toasts.add({ title: 'Could not copy the gadget link.', variant: 'error' })
  }

  const setOrganizationAccess = (canView: boolean) => updateAccess(async () => {
    if (ownerControls.access.cleared) ownerControls.setAllUsersCanView(canView)
    else await overseer.setGadgetAllUsersAccess(gadget.id, canView)
  })

  return (
      <Dialog.Root open={open} onOpenChange={nextOpen => {
        if (nextOpen) return
        if (busy || adding) return
        if (removeTarget) { if (!busy) setRemoveTarget(null) }
        else if (ownerView) setOwnerView(ownerView === 'remove-everyone' ? 'controls' : null)
        else onClose()
      }}>
        <Dialog size="lg" className="flex max-h-[calc(100dvh-4rem)] flex-col sm:max-h-[calc(100dvh-8rem)] rounded-2xl!">
          <div className="flex shrink-0 items-start justify-between gap-4 overflow-hidden px-4 pb-1 pt-5 sm:px-6 sm:pt-6">
            <div className="flex min-w-0 items-start gap-1">
              {ownerView && <WorkshopIconButton ref={ownerBackRef} className="!h-6 !w-6" aria-label={ownerView === 'remove-everyone' ? 'Back to owner controls' : 'Back to sharing'} onClick={() => setOwnerView(ownerView === 'remove-everyone' ? 'controls' : null)}><CaretLeftIcon size={13} weight="bold" /></WorkshopIconButton>}
              {showResources && <WorkshopIconButton ref={backRef} className="!h-6 !w-6" aria-label="Back to sharing" onClick={() => {
                restoreResourcesFocus.current = true
                setShowResources(false)
              }}><CaretLeftIcon size={13} weight="bold" /></WorkshopIconButton>}
              <Dialog.Title className="min-w-0 truncate font-medium text-kumo-default">
                {removeTarget ? `Remove ${removeTarget.profile.name}?` : ownerView === 'remove-everyone' ? 'Remove everyone?' : ownerView ? 'Owner controls' : showResources ? 'Protected resources' : <>Share <span className="text-kumo-subtle">“{gadget.title}”</span></>}
              </Dialog.Title>
            </div>
            <Dialog.Close render={props => <WorkshopIconButton {...props} aria-label="Close" disabled={busy}><XIcon size={16} /></WorkshopIconButton>} />
          </div>
          {removeTarget ? (
            <RemovalConfirmation authenticatedApi={authenticatedApi} name={removeTarget.profile.name} previewing={false}
              losesAccess={!allUsersCanView && !(workspaceAccess && workspaceMembers.some(person => person.profile.id === removeTarget.profile.id)) &&
                (isOwner || removeTarget.addedBy.every(edge => edge.type === 'user' && edge.sharer === currentUser?.id))}
              downstream={[]} keepSet={new Set()} onKeepSetChange={() => {}} inviterNames={new Map()}
              resource="gadget" busy={busy} onCancel={() => setRemoveTarget(null)} cancelRef={cancelRemovalRef}
              onConfirm={() => void updateAccess(() => overseer.removeGadgetViewer(gadget.id, removeTarget.profile.id))} />
          ) : ownerView === 'remove-everyone' && isOwner ? (
            <RemoveEveryoneConfirmation resource="gadget" onCancel={() => setOwnerView('controls')} onConfirm={() => {
              ownerControls.removeEveryone()
              setOwnerView('controls')
              toasts.add({ title: 'Gadget shares were removed. Workspace members keep edit access.', variant: 'success' })
            }} />
          ) : ownerView && isOwner ? (
            <OwnerControls resource="gadget" locked={ownerControls.locked} inheritedLock={ownerControls.inheritedLock}
              onLockedChange={ownerControls.setLocked}
              invitations={{ ownerOnly: metadata.ownerInvitesOnly === true || ownerControls.workspace.ownerInvitesOnly || ownerControls.access.ownerInvitesOnly,
                requiredBy: metadata.ownerInvitesOnly === true ? 'resources' : ownerControls.workspace.ownerInvitesOnly ? 'workspace' : null,
                onOwnerOnlyChange: ownerControls.setOwnerInvitesOnly }}
              onRemoveEveryone={() => setOwnerView('remove-everyone')} onBack={() => setOwnerView(null)} />
          ) : showResources ? (
            <div className="flex min-h-0 flex-1 flex-col px-4 pb-6 sm:px-6">
              <Dialog.Description className="mb-4 text-sm text-kumo-subtle">
                A viewer must have their own access to these resources before they can open this gadget.
              </Dialog.Description>
              <ProtectedResourcesList requirements={requirements} failed={requirementsFailed} authenticatedApi={authenticatedApi} />
            </div>
          ) : (
            <>
              <div className="chat-panel min-h-0 flex-1 overflow-y-auto overscroll-none px-4 pb-2 sm:px-6">
                {ownerControls.locked && <p className="mb-3 flex items-start gap-2 rounded-xl bg-kumo-banner-info px-3 py-2.5 text-xs text-kumo-info">
                  <LockSimpleIcon size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
                  {ownerControls.inheritedLock ? 'Access locked by workspace.' : 'Access locked. Only the owner can access this gadget.'}
                </p>}
                {!canShare && !ownerControls.locked && metadata.role !== 'use' && <p className="mb-3 text-sm text-kumo-subtle">Only the owner can share this gadget.</p>}
                {canShare && <InviteComposer
                  authenticatedApi={authenticatedApi} searchEnabled={searchEnabled} membership={membership} excludeIds={excludeIds}
                  value={username} onValueChange={value => { setUsername(value); setError(null) }} action="Share"
                  adding={adding || busy} error={error} onInvite={userId => void share(userId)} inputRef={inputRef}
                />}
                <CollaboratorList owner={owner} collaborators={viewers} currentUser={currentUser} authenticatedApi={authenticatedApi}
                  landedPersonId={landedPersonId} disabled={busy || adding} accessLabel="Can view" menuContainer={null}
                  canEdit={person => canShare && (isOwner || person.addedBy.some(edge => edge.type === 'user' && edge.sharer === currentUser?.id))}
                  onRemove={profileId => setRemoveTarget(viewers.find(person => person.profile.id === profileId) ?? null)} onTriggerRef={(profileId, element) => {
                    if (element) triggerRefs.current.set(profileId, element)
                    else triggerRefs.current.delete(profileId)
                  }}
                >
                  <div className="flex items-center gap-2 py-3 pl-1.5">
                    <span className="grid size-[26px] shrink-0 place-items-center rounded-full bg-kumo-tint"><UsersThreeIcon size={16} /></span>
                    <span className="min-w-0 flex-1 text-sm font-normal text-kumo-default">People in this workspace</span>
                    <span className="px-2 text-xs font-medium">{workspaceAccess ? 'Can edit' : 'No access'}</span>
                  </div>
                  <div className="flex items-center gap-2 py-3 pl-1.5">
                    <span className="grid size-[26px] shrink-0 place-items-center rounded-full bg-kumo-tint"><BuildingsIcon size={16} /></span>
                    <span className="min-w-0 flex-1 text-sm font-normal text-kumo-default">Anyone in Organization</span>
                    {canShare ? <DropdownMenu>
                      <DropdownMenu.Trigger disabled={!sharing || busy || adding} render={
                        <Button variant="ghost" size="sm" className="group" aria-label={`Anyone in Organization: ${allUsersCanView ? 'Can view' : 'No access'}`}>
                          {allUsersCanView ? 'Can view' : 'No access'}<CaretDownIcon size={10} weight="bold" className="group-data-[popup-open]:rotate-180" />
                        </Button>
                      } />
                      <DropdownMenu.Content align="end" sideOffset={6} className="space-y-0.5">
                        <DropdownMenu.Item selected={!allUsersCanView} className={`[&>span:last-child>svg]:size-3 ${!allUsersCanView ? 'bg-kumo-elevated' : ''}`} onClick={() => void setOrganizationAccess(false)}>
                          <span className="min-w-0 flex-1 text-xs mr-4">No access</span>
                        </DropdownMenu.Item>
                        <DropdownMenu.Item selected={allUsersCanView} className={`[&>span:last-child>svg]:size-3 ${allUsersCanView ? 'bg-kumo-elevated' : ''}`} disabled={metadata.ownerInvitesOnly === true} onClick={() => void setOrganizationAccess(true)}>
                          <span className="min-w-0 flex-1 text-xs mr-4">Can view</span>
                        </DropdownMenu.Item>
                      </DropdownMenu.Content>
                    </DropdownMenu> : <span className="px-2 text-xs font-medium">{allUsersCanView ? 'Can view' : 'No access'}</span>}
                  </div>
                </CollaboratorList>
              </div>
              <div className="flex shrink-0 flex-col gap-3 border-t sm:flex-row sm:items-center sm:justify-between border-kumo-line px-4 py-4 sm:px-6">
                {(requirementsFailed || (requirements !== null && requirements.length > 0)) && <Button ref={resourcesRef} size="sm" variant="ghost"
                  className="w-auto min-w-0 shrink gap-1.5 self-center sm:self-auto px-2.5 h-auto py-1.5 rounded-full! bg-kumo-banner-info hover:bg-kumo-info-tint text-kumo-info!" aria-label="Protected resources" onClick={() => setShowResources(true)}>
                  <LockSimpleIcon size={12} weight="bold" /><span className="truncate">Protected resources</span>
                  {requirements && !requirementsFailed && <span>({requirements.length})</span>}<CaretRightIcon size={10} weight="bold" />
                </Button>}
                <div className="flex w-full items-center justify-end gap-2 sm:ml-auto sm:w-auto">
                  {isOwner && <Button ref={ownerControlsRef} variant="secondary" size="sm" disabled={busy || adding} onClick={() => setOwnerView('controls')} className="h-8 rounded-lg text-[13px] leading-[18px] font-medium tracking-[-0.25px]">Owner controls</Button>}
                  <WorkshopButton ref={copyRef} tone="primary" onClick={() => void copyLink()} className="min-w-0 shrink-0 gap-2 h-8!">
                    {copied ? <Check size={15} weight="bold" /> : <Link size={15} />}{copied ? 'Copied' : 'Copy link'}
                  </WorkshopButton>
                </div>
              </div>
            </>
          )}
        </Dialog>
      </Dialog.Root>
  )

}
