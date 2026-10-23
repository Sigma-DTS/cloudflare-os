import { Banner } from '@cloudflare/kumo'
import { ShieldWarning } from '@phosphor-icons/react'
import type { AmbientGatekeeperMode } from '@gadgets/workshop-shared/api'

/**
 * What each mode of the instance admin Gatekeeper means, for the admin panel's mode control. Only
 * deployment admins are ever offered it, so its modes speak of admins rather than users.
 */
export const INSTANCE_ADMIN_MODE_HINTS: Record<AmbientGatekeeperMode, string> = {
  disabled: 'Off for everyone (the default)',
  optional: 'Admins can add it themselves',
  enabled: 'Added for every admin automatically',
}

const NOTE =
  'Lets an admin’s agent use the Admin API as them, in a workspace they turn it on in, which then ' +
  'stays theirs alone. Reads are recorded there; changes, gateway tests and content reads wait for ' +
  'their approval. A prompt injection can leak what the agent reads through that workspace’s other ' +
  'connections (web search, MCP, other gatekeepers), its gadgets and published blueprints, and the ' +
  'chat’s AI model provider, and it all lands in the deployment’s AI Gateway logs: admins should ' +
  'turn it on only in a dedicated workspace with nothing else connected. Connections every ' +
  'workspace gets, such as Web Search, stay even there unless that admin removes an optional one ' +
  'from Connectors (which removes it from all their workspaces) or it is set to Disabled on this ' +
  'page, and search queries can carry data out.'

/**
 * The admin panel's warning beside the instance admin Gatekeeper's mode control: what turning it on
 * lends an admin's agent, and how a prompt injection could carry what that agent reads out of the
 * deployment.
 */
export const InstanceAdminModeNote = () => (
  <Banner variant="alert" size="sm" icon={<ShieldWarning size={16} />} description={NOTE} />
)
