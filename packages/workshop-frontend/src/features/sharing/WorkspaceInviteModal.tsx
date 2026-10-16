import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Button, Dialog, useKumoToastManager } from '@cloudflare/kumo'
import { CaretLeftIcon, Check, Link, LockSimpleIcon, XIcon } from '@phosphor-icons/react'
import type { RpcStub } from 'capnweb'
import type { AiChatAuthorInfo, AuthenticatedApi, CollaboratorInfo, GadgetMetadata, Overseer } from '@gadgets/workshop-shared/api'
import { WorkshopButton, WorkshopIconButton } from '../../components/WorkshopControls'
import { copyToClipboard } from '../../clipboard'
import { useServerConfig } from '../../ServerConfigContext'
import { CollaboratorList } from './CollaboratorList'
import { InviteComposer } from './InviteComposer'
import { OwnerControls } from './OwnerControls'
import { RemoveEveryoneConfirmation } from './RemoveEveryoneConfirmation'
import { RemovalConfirmation } from './RemovalConfirmation'
import { useCollaboratorRemoval } from './useCollaboratorRemoval'
import { usePrototypeOwnerControls } from './usePrototypeOwnerControls'

type Props = {
  open: boolean
  onClose: () => void
  overseer: RpcStub<Overseer>
  metadata: GadgetMetadata
  currentUser: AiChatAuthorInfo | null
  authenticatedApi: RpcStub<AuthenticatedApi>
}

export const WorkspaceInviteModal = ({ open, onClose, overseer, metadata, currentUser, authenticatedApi }: Props) => {
  const toasts = useKumoToastManager()
  const toastsRef = useRef(toasts)
  toastsRef.current = toasts
  const searchEnabled = useServerConfig()?.userSearchEnabled ?? false
  const [collaborators, setCollaborators] = useState<CollaboratorInfo[]>([])
  const [membership, setMembership] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [username, setUsername] = useState('')
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [landedPersonId, setLandedPersonId] = useState<string | null>(null)
  const [ownerView, setOwnerView] = useState<'controls' | 'remove-everyone' | null>(null)
  const ownerControls = usePrototypeOwnerControls(metadata.id)
  const ownerControlsRef = useRef<HTMLButtonElement>(null)
  const ownerBackRef = useRef<HTMLButtonElement>(null)
  const previousOwnerView = useRef<typeof ownerView>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const copyRef = useRef<HTMLButtonElement>(null)
  const triggers = useRef(new Map<string, HTMLButtonElement>())
  const previousRemoval = useRef<string | null>(null)
  const addingRef = useRef(false)
  const requestId = useRef(0)
  const isOwner = !metadata.owner
  const canInvite = !ownerControls.locked && (isOwner || (metadata.ownerInvitesOnly !== true && !ownerControls.workspace.ownerInvitesOnly))
  const owner = isOwner ? currentUser : metadata.owner ?? null
  const visibleCollaborators = collaborators.filter(person => !ownerControls.access.cleared || ownerControls.access.restoredProfileIds.includes(person.profile.id))
  const members = ownerControls.locked ? [] : visibleCollaborators.filter(person => (person.role ?? 'build') === 'build')
  const excludeIds = [...new Set([...(currentUser ? [currentUser.id] : []), ...(owner ? [owner.id] : []), ...members.map(person => person.profile.id)])]
  const inviterNames = new Map(collaborators.map(person => [person.profile.id, person.profile.name]))
  if (owner) inviterNames.set(owner.id, owner.name)

  const loadData = useCallback(async () => {
    const request = ++requestId.current
    try {
      const people = await overseer.listCollaborators()
      if (request !== requestId.current) return
      setCollaborators(people)
      setMembership('ready')
    } catch {
      if (request !== requestId.current) return
      setMembership('failed')
      toastsRef.current.add({ title: 'Failed to load workspace members.', variant: 'error' })
    }
  }, [overseer])
  const removal = useCollaboratorRemoval({ overseer, open, collaborators: visibleCollaborators, onRemoved: loadData })
  const removalId = removal.target?.profileId ?? null

  useEffect(() => {
    if (!open) return
    setMembership('loading')
    setUsername('')
    setError(null)
    setCopied(false)
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
    if (removalId) cancelRef.current?.focus({ preventScroll: true })
    else if (previousRemoval.current) {
      (triggers.current.get(previousRemoval.current) ?? inputRef.current ?? copyRef.current)?.focus({ preventScroll: true })
    }
    previousRemoval.current = removalId
  }, [removalId])

  useLayoutEffect(() => {
    if (ownerView === 'controls') ownerBackRef.current?.focus({ preventScroll: true })
    else if (!ownerView && previousOwnerView.current) ownerControlsRef.current?.focus({ preventScroll: true })
    previousOwnerView.current = ownerView
  }, [ownerView])

  const invite = async (userId: string) => {
    if (!canInvite || addingRef.current) return
    addingRef.current = true
    setAdding(true)
    setError(null)
    try {
      const person = await overseer.addCollaborator(userId, 'build', undefined)
      if (!person) { setError('No account found for that username or email.'); return }
      ownerControls.restoreProfile(person.profile.id)
      setUsername('')
      await loadData()
      setLandedPersonId(person.profile.id)
      toasts.add({ title: `Invited ${person.profile.name} as a member.`, variant: 'success' })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to invite member.')
    } finally {
      addingRef.current = false
      setAdding(false)
      inputRef.current?.focus({ preventScroll: true })
    }
  }

  const copyLink = async () => {
    if (await copyToClipboard(`${window.location.origin}/workspace/${metadata.id}`)) setCopied(true)
    else toasts.add({ title: 'Could not copy the workspace link.', variant: 'error' })
  }

  return (
    <Dialog.Root open={open} onOpenChange={nextOpen => {
      if (nextOpen) return
      if (removal.busy || adding) return
      if (removal.target) { if (!removal.busy) removal.cancel() }
      else if (ownerView) setOwnerView(ownerView === 'remove-everyone' ? 'controls' : null)
      else onClose()
    }}>
      <Dialog size="lg" className="flex max-h-[calc(100dvh-4rem)] flex-col sm:max-h-[calc(100dvh-8rem)] rounded-2xl!">
        <div className="flex shrink-0 items-start justify-between gap-4 overflow-hidden px-4 pb-1 pt-5 sm:px-6 sm:pt-6">
          <div className="flex min-w-0 items-start gap-1">
            {ownerView && <WorkshopIconButton ref={ownerBackRef} className="!h-6 !w-6" aria-label={ownerView === 'remove-everyone' ? 'Back to owner controls' : 'Back to invitations'} onClick={() => setOwnerView(ownerView === 'remove-everyone' ? 'controls' : null)}><CaretLeftIcon size={13} weight="bold" /></WorkshopIconButton>}
            <Dialog.Title className="min-w-0 truncate font-medium text-kumo-default">
              {removal.target ? `Remove ${removal.target.name}?` : ownerView === 'remove-everyone' ? 'Remove everyone?' : ownerView ? 'Owner controls' : 'Invite to Workspace'}
            </Dialog.Title>
          </div>
          <Dialog.Close render={props => <WorkshopIconButton {...props} aria-label="Close" disabled={removal.busy}><XIcon size={16} /></WorkshopIconButton>} />
        </div>
        {removal.target ? (
          <RemovalConfirmation {...removal.target} authenticatedApi={authenticatedApi} resource="workspace" inviterNames={inviterNames} busy={removal.busy} onKeepSetChange={removal.setKeepSet} onCancel={removal.cancel} onConfirm={() => void removal.confirm()} cancelRef={cancelRef} />
        ) : ownerView === 'remove-everyone' && isOwner ? (
          <RemoveEveryoneConfirmation resource="workspace" onCancel={() => setOwnerView('controls')} onConfirm={() => {
            ownerControls.removeEveryone()
            setOwnerView('controls')
            toasts.add({ title: 'Everyone else’s access was removed.', variant: 'success' })
          }} />
        ) : ownerView && isOwner ? (
          <OwnerControls resource="workspace" locked={ownerControls.locked} inheritedLock={false}
            onLockedChange={ownerControls.setLocked}
            invitations={{ ownerOnly: metadata.ownerInvitesOnly === true || ownerControls.workspace.ownerInvitesOnly,
              requiredBy: metadata.ownerInvitesOnly === true ? 'resources' : null, onOwnerOnlyChange: ownerControls.setOwnerInvitesOnly }}
            onRemoveEveryone={() => setOwnerView('remove-everyone')} onBack={() => setOwnerView(null)} />
        ) : (
          <>
            <div className="chat-panel min-h-0 flex-1 overflow-y-auto overscroll-none px-4 pb-2 sm:px-6">
              {ownerControls.locked ? <p className="mb-3 flex items-start gap-2 rounded-xl bg-kumo-banner-info px-3 py-2.5 text-xs text-kumo-info">
                <LockSimpleIcon size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
                Access locked. Only the owner can access this workspace and its gadgets.
              </p> : !canInvite && <p className="mb-3 text-sm text-kumo-subtle">Only the owner can invite people to this workspace.</p>}
              {canInvite && <InviteComposer
                authenticatedApi={authenticatedApi} searchEnabled={searchEnabled} membership={membership} excludeIds={excludeIds}
                value={username} onValueChange={value => { setUsername(value); setError(null) }} action="Invite"
                adding={adding} error={error} onInvite={userId => void invite(userId)} inputRef={inputRef}
              />}
              <CollaboratorList owner={owner} collaborators={members} currentUser={currentUser} authenticatedApi={authenticatedApi}
                landedPersonId={landedPersonId} disabled={removal.busy} accessLabel="Member" menuContainer={null}
                canEdit={person => !ownerControls.locked && (isOwner || (canInvite && person.addedBy.some(edge => edge.type === 'user' && edge.sharer === currentUser?.id)))}
                onRemove={profileId => void removal.start(profileId)} onTriggerRef={(profileId, element) => {
                  if (element) triggers.current.set(profileId, element)
                  else triggers.current.delete(profileId)
                }}
              />
            </div>
            <div className="flex shrink-0 items-center justify-end gap-2 border-t border-kumo-line px-4 py-4 sm:px-6">
              {isOwner && <Button ref={ownerControlsRef} variant="secondary" size="sm" disabled={adding} onClick={() => setOwnerView('controls')} className="h-8 rounded-lg text-[13px] leading-[18px] font-medium tracking-[-0.25px]">Owner controls</Button>}
              <WorkshopButton ref={copyRef} tone="primary" onClick={() => void copyLink()} className="min-w-0 shrink-0 gap-2 h-8!">
                {copied ? <Check size={15} weight="bold" /> : <Link size={15} />}{copied ? 'Copied' : 'Copy link'}
              </WorkshopButton>
            </div>
          </>
        )}
      </Dialog>
    </Dialog.Root>
  )
}
