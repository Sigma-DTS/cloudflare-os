import { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef } from 'react'
import { Button, Dialog, useKumoToastManager } from '@cloudflare/kumo'
import { CaretLeftIcon, CaretRightIcon, Check, Link, LockSimpleIcon, XIcon } from '@phosphor-icons/react'
import { RpcStub } from 'capnweb'
import {
  Overseer,
  AuthenticatedApi,
  CollaboratorInfo,
  GadgetMetadata,
  AiChatAuthorInfo,
  CollaboratorRole,
} from '@gadgets/workshop-shared/api'
import { WorkshopButton, WorkshopIconButton } from './components/WorkshopControls'
import { copyToClipboard } from './clipboard'
import { useServerConfig } from './ServerConfigContext'
import { CollaboratorList } from './features/sharing/CollaboratorList'
import { InviteComposer } from './features/sharing/InviteComposer'
import { ProtectedResourcesList } from './features/sharing/ProtectedResourcesList'
import { RemovalConfirmation } from './features/sharing/RemovalConfirmation'
import { useCollaboratorRemoval } from './features/sharing/useCollaboratorRemoval'
import { useObserverRequirements } from './features/sharing/useObserverRequirements'

type Props = {
  open: boolean
  onClose: () => void
  overseer: RpcStub<Overseer>
  metadata: GadgetMetadata
  currentUser: AiChatAuthorInfo | null
  authenticatedApi: RpcStub<AuthenticatedApi>
}

export default function ShareModal({ open, onClose, overseer, metadata, currentUser, authenticatedApi }: Props) {
  const toasts = useKumoToastManager()
  const userSearchEnabled = useServerConfig()?.userSearchEnabled ?? false
  const [collaborators, setCollaborators] = useState<CollaboratorInfo[]>([])
  const [membershipStatus, setMembershipStatus] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [showProtectedResources, setShowProtectedResources] = useState(false)
  const [addUsername, setAddUsername] = useState('')
  const [addRole, setAddRole] = useState<CollaboratorRole>('use')
  const [adding, setAdding] = useState(false)
  const [inviteError, setInviteError] = useState<string | null>(null)
  const [updatingAccess, setUpdatingAccess] = useState(false)
  const [landedPersonId, setLandedPersonId] = useState<string | null>(null)
  const [linkCopied, setLinkCopied] = useState(false)
  const [menuContainer, setMenuContainer] = useState<HTMLDivElement | null>(null)
  const addingRef = useRef(false)
  // The latest `open`, for async work that may outlive the dialog.
  const openRef = useRef(open)
  const peopleInputRef = useRef<HTMLInputElement>(null)
  const protectedResourcesButtonRef = useRef<HTMLButtonElement>(null)
  const copyButtonRef = useRef<HTMLButtonElement>(null)
  const backButtonRef = useRef<HTMLButtonElement>(null)
  const cancelRemovalButtonRef = useRef<HTMLButtonElement>(null)
  const roleMenuTriggerRefs = useRef(new Map<string, HTMLButtonElement>())
  const restoreResourcesFocusRef = useRef(false)
  const previousRemovalProfileIdRef = useRef<string | null>(null)

  const isOwner = !metadata.owner
  // The server refuses non-owner invites once this is set; hide the invite controls.
  const canInvite = metadata.ownerInvitesOnly !== true || isOwner
  const ownerProfile = isOwner ? currentUser : (metadata.owner ?? null)
  // The server only lets non-owners change or remove access they granted themselves.
  const canEditAccess = (collaborator: CollaboratorInfo) => isOwner || (canInvite &&
    collaborator.addedBy.some(edge => edge.type === 'user' && edge.sharer === currentUser?.id))
  // Everyone already on the workspace: the caller, the owner (absent from listCollaborators()
  // when the caller is a collaborator), and every collaborator.
  const directoryExcludeIds = useMemo(() => [
    ...(currentUser ? [currentUser.id] : []),
    ...(metadata.owner ? [metadata.owner.id] : []),
    ...collaborators.map(({ profile }) => profile.id),
  ], [collaborators, currentUser, metadata.owner])

  const loadData = useCallback(async () => {
    try {
      setCollaborators(await overseer.listCollaborators())
      setMembershipStatus('ready')
    } catch (err) {
      console.error('Failed to load share data:', err)
      toasts.add({ title: 'Failed to load sharing info', variant: 'error' })
      setMembershipStatus(current => current === 'ready' ? current : 'failed')
    }
  }, [overseer])

  const removal = useCollaboratorRemoval({ overseer, open, collaborators, onRemoved: loadData })
  const { requirements, failed: requirementsFailed } = useObserverRequirements(overseer, open)
  const protectedRequirements = requirements?.[canInvite ? addRole : metadata.role ?? 'use'] ?? null
  const removalProfileId = removal.target?.profileId ?? null

  useEffect(() => {
    openRef.current = open
    setMembershipStatus('loading')
    if (open) void loadData()
  }, [open, loadData])

  useEffect(() => {
    if (!open) return
    setAddUsername('')
    setInviteError(null)
    setLinkCopied(false)
    setShowProtectedResources(false)
    restoreResourcesFocusRef.current = false
  }, [open])

  useEffect(() => {
    const element = document.createElement('div')
    element.style.position = 'relative'
    element.style.zIndex = '1100'
    document.body.appendChild(element)
    setMenuContainer(element)
    return () => {
      setMenuContainer(null)
      element.remove()
    }
  }, [])

  useEffect(() => {
    if (!landedPersonId) return
    const timer = window.setTimeout(() => setLandedPersonId(null), 2200)
    return () => window.clearTimeout(timer)
  }, [landedPersonId])

  useLayoutEffect(() => {
    if (showProtectedResources) backButtonRef.current?.focus({ preventScroll: true })
    else if (restoreResourcesFocusRef.current) {
      const target = protectedResourcesButtonRef.current ?? copyButtonRef.current
      target?.focus({ preventScroll: true })
      restoreResourcesFocusRef.current = false
    }
  }, [showProtectedResources])

  useLayoutEffect(() => {
    if (!open) {
      previousRemovalProfileIdRef.current = null
      return
    }
    if (removalProfileId) {
      cancelRemovalButtonRef.current?.focus({ preventScroll: true })
    } else if (previousRemovalProfileIdRef.current) {
      const target = roleMenuTriggerRefs.current.get(previousRemovalProfileIdRef.current)
        ?? peopleInputRef.current ?? copyButtonRef.current
      target?.focus({ preventScroll: true })
    }
    previousRemovalProfileIdRef.current = removalProfileId
  }, [removalProfileId, open])

  // Adding someone already granted them access, so the link carries no secret and is safe to show
  // and re-show — unlike a share link, whose URL embeds a key.
  const copyWorkspaceUrl = async () => {
    if (await copyToClipboard(`${window.location.origin}/workspace/${metadata.id}`)) {
      setLinkCopied(true)
    } else {
      toasts.add({ title: 'Could not copy the workspace link.', variant: 'error' })
    }
  }

  const handleInvite = async (userId: string) => {
    if (!canInvite || addingRef.current) return
    addingRef.current = true
    setAdding(true)
    setInviteError(null)
    setAddUsername(userId)
    try {
      const collaborator = await overseer.addCollaborator(userId, addRole, undefined)
      if (!collaborator) {
        setInviteError('No account found for that username or email.')
        return
      }
      setAddUsername('')
      setLinkCopied(false)
      await loadData()
      setLandedPersonId(collaborator.profile.id)
      toasts.add({ title: `Added ${collaborator.profile.name} as a collaborator.`, variant: 'success' })
    } catch (err) {
      setInviteError(err instanceof Error ? err.message : 'Failed to add collaborator.')
    } finally {
      addingRef.current = false
      setAdding(false)
      if (openRef.current) peopleInputRef.current?.focus({ preventScroll: true })
    }
  }

  const handleChangeCollaboratorRole = async (collaborator: CollaboratorInfo, role: CollaboratorRole) => {
    if (role === (collaborator.role ?? 'build') || updatingAccess) return
    setUpdatingAccess(true)
    try {
      await overseer.setCollaboratorRole(collaborator.profile.id, role)
      await loadData()
      toasts.add({ title: 'Access updated.', variant: 'success' })
    } catch (err) {
      toasts.add({ title: err instanceof Error ? err.message : 'Failed to update access.', variant: 'error' })
    } finally {
      setUpdatingAccess(false)
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={(o) => {
      if (o) return
      // Closing the removal view returns to sharing rather than dismissing the dialog.
      if (removal.target) {
        if (!removal.busy) removal.cancel()
      } else onClose()
    }}>
      <Dialog size="lg" className="flex max-h-[calc(100dvh-4rem)] flex-col sm:max-h-[calc(100dvh-8rem)] rounded-2xl!">
        <div className="flex shrink-0 items-start justify-between gap-4 overflow-hidden px-4 pb-1 pt-5 sm:px-6 sm:pt-6">
          <div className="flex min-w-0 items-start gap-1">
            {showProtectedResources && (
              <WorkshopIconButton
                ref={backButtonRef}
                className="!h-6 !w-6"
                aria-label="Back to sharing"
                onClick={() => {
                  restoreResourcesFocusRef.current = true
                  setShowProtectedResources(false)
                }}
              >
                <CaretLeftIcon size={13} weight='bold' />
              </WorkshopIconButton>
            )}
            <Dialog.Title className="min-w-0 truncate font-medium text-kumo-default">
              {removal.target
                ? `Remove ${removal.target.name}?`
                : showProtectedResources
                  ? 'Protected resources'
                  : <>Share <span className='text-kumo-subtle'>“{metadata.title}”</span></>}
            </Dialog.Title>
          </div>
          <Dialog.Close
            render={(props) => (
              <WorkshopIconButton {...props} aria-label="Close" disabled={removal.busy}>
                <XIcon size={16} />
              </WorkshopIconButton>
            )}
          />
        </div>

        {removal.target ? (
          <RemovalConfirmation
            {...removal.target}
            onKeepSetChange={removal.setKeepSet}
            busy={removal.busy}
            onCancel={removal.cancel}
            onConfirm={() => void removal.confirm()}
            cancelRef={cancelRemovalButtonRef}
          />
        ) : showProtectedResources ? (
          <div className="flex min-h-0 flex-1 flex-col px-4 pb-6 sm:px-6">
            <Dialog.Description className="mb-3 shrink-0 text-sm text-kumo-subtle">
              Connected systems a viewer must have their own access to before seeing or interacting with this gadget or workspace.
            </Dialog.Description>
            <ProtectedResourcesList
              requirements={protectedRequirements}
              failed={requirementsFailed}
              authenticatedApi={authenticatedApi}
            />
          </div>
        ) : (
          <>
            <div className="chat-panel min-h-0 flex-1 overflow-y-auto overscroll-none px-4 pb-2 sm:px-6">
              {canInvite && (
                <InviteComposer
                  authenticatedApi={authenticatedApi}
                  searchEnabled={userSearchEnabled}
                  membership={membershipStatus}
                  excludeIds={directoryExcludeIds}
                  value={addUsername}
                  onValueChange={(value) => {
                    setAddUsername(value)
                    setInviteError(null)
                  }}
                  role={addRole}
                  onRoleChange={setAddRole}
                  adding={adding}
                  error={inviteError}
                  onInvite={(userId) => void handleInvite(userId)}
                  inputRef={peopleInputRef}
                  menuContainer={menuContainer}
                />
              )}
              <CollaboratorList
                owner={ownerProfile}
                collaborators={collaborators}
                currentUserId={currentUser?.id}
                authenticatedApi={authenticatedApi}
                landedPersonId={landedPersonId}
                disabled={updatingAccess}
                canEdit={canEditAccess}
                menuContainer={menuContainer}
                onRoleChange={(collaborator, role) => void handleChangeCollaboratorRole(collaborator, role)}
                onRemove={(profileId) => void removal.start(profileId)}
                onTriggerRef={(profileId, element) => {
                  if (element) roleMenuTriggerRefs.current.set(profileId, element)
                  else roleMenuTriggerRefs.current.delete(profileId)
                }}
              />
            </div>
            <div className="flex shrink-0 flex-col gap-3 border-t sm:flex-row sm:items-center sm:justify-between border-kumo-line px-4 py-4 sm:px-6">
              {(requirementsFailed || (protectedRequirements !== null && protectedRequirements.length > 0)) && (
                <Button
                  ref={protectedResourcesButtonRef}
                  size='sm'
                  variant='ghost'
                  className="w-auto min-w-0 shrink gap-1.5 self-center sm:self-auto px-2.5 h-auto py-1.5 !rounded-full bg-kumo-banner-info hover:bg-kumo-info-tint text-kumo-info!"
                  aria-label="Protected resources"
                  onClick={() => setShowProtectedResources(true)}
                >
                  <LockSimpleIcon size={12} weight='bold' className="shrink-0" />
                  <span className="min-w-0 truncate">Protected resources</span>
                  {protectedRequirements !== null && !requirementsFailed && <span className='shrink-0 opacity-70 -m-0.5'>({protectedRequirements.length})</span>}
                  <CaretRightIcon size={10} weight='bold' className="shrink-0" />
                </Button>
              )}
              <WorkshopButton ref={copyButtonRef} tone="primary" onClick={copyWorkspaceUrl} className="w-full shrink-0 gap-2 h-8! rounded- sm:ml-auto sm:w-auto">
                {linkCopied ? <Check size={15} weight="bold" /> : <Link size={15} />}
                {linkCopied ? 'Copied' : 'Copy link'}
              </WorkshopButton>
            </div>
          </>
        )}
      </Dialog>
    </Dialog.Root>
  )
}
