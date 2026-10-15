import type { Ref } from 'react'
import { Button, DropdownMenu } from '@cloudflare/kumo'
import type { PortalContainer } from '@cloudflare/kumo'
import { CaretDownIcon } from '@phosphor-icons/react'
import type { CollaboratorRole } from '@gadgets/workshop-shared/api'

const ROLE_LABELS: Record<CollaboratorRole, string> = {
  build: 'Workspace',
  use: 'Gadget only',
}

const ROLE_OPTIONS: CollaboratorRole[] = ['build', 'use']

const roleLabel = (role: CollaboratorRole) => ROLE_LABELS[role]

type Props = {
  value: CollaboratorRole
  onValueChange: (role: CollaboratorRole) => void
  disabled?: boolean
  ariaLabel: string
  container?: PortalContainer
  onRemove?: () => void
  triggerRef?: Ref<HTMLButtonElement>
}

export const RoleMenu = ({
  value,
  onValueChange,
  disabled,
  ariaLabel,
  container,
  onRemove,
  triggerRef,
}: Props) => (
  <DropdownMenu>
    <DropdownMenu.Trigger
      disabled={disabled}
      render={
        <Button
          ref={triggerRef}
          variant='ghost'
          size='sm'
          className="group"
          aria-label={`${ariaLabel}: ${roleLabel(value)}`}
        >
          {roleLabel(value)}
          <CaretDownIcon size={10} weight="bold" className="group-data-[popup-open]:rotate-180" />
        </Button>
      }
    />
    <DropdownMenu.Content
      container={container}
      align="end"
      sideOffset={6}
      className="space-y-0.5"
    >
      {ROLE_OPTIONS.map(role => (
        <DropdownMenu.Item
          key={role}
          selected={value === role}
          onClick={() => onValueChange(role)}
          className={`[&>span:last-child>svg]:size-3 ${value === role ? 'bg-kumo-elevated' : ''}`}
        >
          <span className="min-w-0 flex-1 text-xs mr-4">
            {roleLabel(role)}
          </span>
        </DropdownMenu.Item>
      ))}
      {onRemove && (
        <>
          <DropdownMenu.Separator />
          <DropdownMenu.Item variant="danger" onClick={onRemove} className="text-xs">
            Remove
          </DropdownMenu.Item>
        </>
      )}
    </DropdownMenu.Content>
  </DropdownMenu>
)
