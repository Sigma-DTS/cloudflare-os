import { useLayoutEffect, useRef } from 'react'
import { Dialog } from '@cloudflare/kumo'
import { WorkshopButton } from '../../components/WorkshopControls'

type Props = {
  resource: 'workspace' | 'gadget'
  onCancel: () => void
  onConfirm: () => void
}

export const RemoveEveryoneConfirmation = ({ resource, onCancel, onConfirm }: Props) => {
  const cancelRef = useRef<HTMLButtonElement>(null)
  useLayoutEffect(() => { cancelRef.current?.focus({ preventScroll: true }) }, [])

  return (
    <>
      <div className="px-4 pb-6 sm:px-6">
        <Dialog.Description className="text-sm leading-relaxed text-kumo-subtle">
          {resource === 'workspace'
            ? 'Everyone else will lose access to this workspace and all gadgets inside it. Existing invitations and shared links will stop working.'
            : 'Individual shares and organization-wide viewing will be removed from this gadget. Workspace members will keep their edit access.'}
          {' '}You can grant access again later. Unlocking won’t restore these permissions.
        </Dialog.Description>
      </div>
      <div className="flex shrink-0 justify-end gap-2 border-t border-kumo-line px-4 py-4 sm:px-6">
        <WorkshopButton ref={cancelRef} onClick={onCancel}>Cancel</WorkshopButton>
        <WorkshopButton tone="danger" onClick={onConfirm}>Remove everyone</WorkshopButton>
      </div>
    </>
  )
}
