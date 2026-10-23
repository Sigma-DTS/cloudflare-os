// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { INSTANCE_ADMIN_MODE_HINTS, InstanceAdminModeNote } from './InstanceAdminModeNote'

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  if (previousActEnvironment === undefined) delete testGlobal.IS_REACT_ACT_ENVIRONMENT
  else testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

describe('InstanceAdminModeNote', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('describes each mode as off by default and offered to admins only', () => {
    expect(INSTANCE_ADMIN_MODE_HINTS).toEqual({
      disabled: 'Off for everyone (the default)',
      optional: 'Admins can add it themselves',
      enabled: 'Added for every admin automatically',
    })
  })

  it('warns where a prompt injection can leak what the agent reads, and advises a dedicated workspace', async () => {
    await act(async () => root.render(<InstanceAdminModeNote />))

    const text = container.textContent ?? ''
    expect(text).toContain('Lets an admin’s agent use the Admin API as them')
    expect(text).toContain('other connections (web search, MCP, other gatekeepers)')
    expect(text).toContain('its gadgets and published blueprints')
    expect(text).toContain('the chat’s AI model provider')
    expect(text).toContain('the deployment’s AI Gateway logs')
    expect(text).toContain('only in a dedicated workspace with nothing else connected')
  })

  it('says that connections every workspace gets, such as Web Search, stay even in that workspace', async () => {
    await act(async () => root.render(<InstanceAdminModeNote />))

    const text = container.textContent ?? ''
    expect(text).toContain('Connections every workspace gets, such as Web Search, stay even there')
    expect(text).toContain('search queries can carry data out')
  })
})
