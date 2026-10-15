import type { ReactNode } from 'react'
import type { PortalContainer } from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import type { AiChatAuthorInfo, AuthenticatedApi, CollaboratorInfo, CollaboratorRole } from '@gadgets/workshop-shared/api'
import { PersonAvatar } from '../../components/PersonAvatar'
import { RoleMenu } from './RoleMenu'

type Props = {
  owner: AiChatAuthorInfo | null
  collaborators: CollaboratorInfo[]
  currentUserId: string | undefined
  authenticatedApi: RpcStub<AuthenticatedApi>
  /** The person whose row briefly highlights after being added. */
  landedPersonId: string | null
  /** Whether access can currently be changed at all. */
  disabled: boolean
  /** Whether the caller may change or remove this person's access. */
  canEdit: (collaborator: CollaboratorInfo) => boolean
  menuContainer: PortalContainer
  onRoleChange: (collaborator: CollaboratorInfo, role: CollaboratorRole) => void
  onRemove: (profileId: string) => void
  /** Reports each access menu's trigger so focus can return to it. */
  onTriggerRef: (profileId: string, element: HTMLButtonElement | null) => void
}

export const CollaboratorList = ({
  owner,
  collaborators,
  currentUserId,
  authenticatedApi,
  landedPersonId,
  disabled,
  canEdit,
  menuContainer,
  onRoleChange,
  onRemove,
  onTriggerRef,
}: Props) => {
  const row = (profile: AiChatAuthorInfo, access: ReactNode) => (
    <div
      key={profile.id}
      className={`flex items-center gap-2 rounded-xl pl-1.5 pr-0 py-2.5 ${profile.id === landedPersonId ? 'share-row-land' : ''}`}
    >
      <PersonAvatar api={authenticatedApi} userId={profile.id} name={profile.name} size={26} />
      <p className="min-w-0 flex-1 truncate text-sm font-medium tracking-[-0.25px] text-kumo-default">
        {profile.name}{profile.id === currentUserId && <>{" "}<span className='text-kumo-subtle'>(You)</span></>}
      </p>
      {access}
    </div>
  )

  return (
    <section aria-label="People with access" className="overflow-hidden mb-0.5">
      {owner && row(owner, <span className="px-2 text-xs font-medium">Owner</span>)}
      {owner && collaborators.length > 0 && (
        <div aria-hidden="true" className="my-1 border-b border-dashed border-kumo-line" />
      )}
      {collaborators.map(info => row(
        info.profile,
        <RoleMenu
          triggerRef={(element) => onTriggerRef(info.profile.id, element)}
          ariaLabel={`Access for ${info.profile.name}`}
          value={info.role ?? 'build'}
          onValueChange={(role) => onRoleChange(info, role)}
          onRemove={() => onRemove(info.profile.id)}
          disabled={disabled || !canEdit(info)}
          container={menuContainer}
        />,
      ))}
    </section>
  )
}
