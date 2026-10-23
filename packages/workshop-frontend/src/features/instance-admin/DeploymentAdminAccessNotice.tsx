import { useState } from 'react'
import { Banner, useKumoToastManager } from '@cloudflare/kumo'
import { ShieldWarning } from '@phosphor-icons/react'
import type { RpcStub } from 'capnweb'
import type { GadgetMetadata, Overseer } from '@gadgets/workshop-shared/api'
import { logRpcFailure, rpcFailureDescription } from '../../rpcErrors'

type DeploymentAdminAccessNoticeProps = {
  overseer: RpcStub<Overseer>
  access: NonNullable<GadgetMetadata['deploymentAdminAccess']>
}

// What a sender of an external message is told is deliberately neutral, so this is where the owner
// learns why the workspace refuses their own external messages too.
const STAYS_PRIVATE = 'This workspace stays yours alone: it can’t be shared and takes no external messages.'

const TURN_OFF_FAILED = 'Couldn’t turn off deployment admin access'

/**
 * The owner's standing account, at the top of the Activity pane, of a workspace that ever had
 * deployment admin access (GadgetMetadata.deploymentAdminAccess): whether its agent can use the
 * Admin API as them, with a way to turn that off, and why the workspace stays theirs alone either way.
 */
export const DeploymentAdminAccessNotice = ({ overseer, access }: DeploymentAdminAccessNoticeProps) => {
  const toasts = useKumoToastManager()
  const [turningOff, setTurningOff] = useState(false)

  const turnOff = async () => {
    setTurningOff(true)
    try {
      await overseer.turnOffDeploymentAdminAccess()
    } catch (err) {
      logRpcFailure(`${TURN_OFF_FAILED}:`, err)
      toasts.add({ title: TURN_OFF_FAILED, description: rpcFailureDescription(err), variant: 'error' })
    } finally {
      setTurningOff(false)
    }
  }

  const description = access === 'on'
    ? 'Deployment admin access is on in this workspace. Your agent can use the Admin API as you; ' +
      'changes wait for your approval.'
    : 'Deployment admin access is off in this workspace. Your agent can ask you to turn it back on.'

  return (
    <div className="flex-shrink-0 p-3">
      <Banner
        variant={access === 'on' ? 'alert' : 'secondary'}
        size="sm"
        icon={<ShieldWarning size={16} />}
        description={`${description} ${STAYS_PRIVATE}`}
        action={access === 'on' ? (
          <Banner.Action variant="secondary" disabled={turningOff} onClick={() => void turnOff()}>
            Turn off
          </Banner.Action>
        ) : undefined}
      />
    </div>
  )
}
