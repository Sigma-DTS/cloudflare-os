// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { Overseer } from '@gadgets/workshop-shared/api'

const { addToast } = vi.hoisted(() => ({
  addToast: vi.fn<(toast: { title: string; description?: string; variant: string }) => void>(),
}))

vi.mock('@cloudflare/kumo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cloudflare/kumo')>()),
  useKumoToastManager: () => ({ add: addToast }),
}))

import { DeploymentAdminAccessNotice } from './DeploymentAdminAccessNotice'

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  if (previousActEnvironment === undefined) delete testGlobal.IS_REACT_ACT_ENVIRONMENT
  else testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

const STAYS_PRIVATE = 'This workspace stays yours alone: it can’t be shared and takes no external messages.'

const fakeOverseer = () => ({
  turnOffDeploymentAdminAccess: vi.fn<Overseer['turnOffDeploymentAdminAccess']>(async () => {}),
})

describe('DeploymentAdminAccessNotice', () => {
  let container: HTMLDivElement
  let root: Root

  const render = async (access: 'on' | 'off', overseer = fakeOverseer()) => {
    await act(async () => root.render(
      <DeploymentAdminAccessNotice overseer={overseer as unknown as RpcStub<Overseer>} access={access} />))
    return overseer
  }

  const turnOffButton = () =>
    [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Turn off')

  beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    addToast.mockReset()
    vi.restoreAllMocks()
  })

  it('says the agent can use the Admin API while access is on, and that the workspace stays private', async () => {
    await render('on')

    expect(container.textContent).toContain(
      'Deployment admin access is on in this workspace. Your agent can use the Admin API as you; ' +
      'changes wait for your approval.')
    expect(container.textContent).toContain(STAYS_PRIVATE)
    expect(turnOffButton()).toBeDefined()
  })

  it('says access is off, still that the workspace stays private, and offers nothing to turn off', async () => {
    await render('off')

    expect(container.textContent).toContain(
      'Deployment admin access is off in this workspace. Your agent can ask you to turn it back on.')
    expect(container.textContent).toContain(STAYS_PRIVATE)
    expect(turnOffButton()).toBeUndefined()
  })

  it('turns access off through the overseer', async () => {
    const overseer = await render('on')

    await act(async () => turnOffButton()!.click())

    expect(overseer.turnOffDeploymentAdminAccess).toHaveBeenCalledOnce()
    expect(addToast).not.toHaveBeenCalled()
  })

  it('reports a failure to turn access off, and lets the owner try again', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const overseer = fakeOverseer()
    overseer.turnOffDeploymentAdminAccess.mockRejectedValueOnce(new Error('The workspace is busy.'))
    await render('on', overseer)

    await act(async () => turnOffButton()!.click())

    expect(addToast).toHaveBeenCalledWith({
      title: 'Couldn’t turn off deployment admin access',
      description: 'The workspace is busy.',
      variant: 'error',
    })
    expect(turnOffButton()!.disabled).toBe(false)
  })
})
