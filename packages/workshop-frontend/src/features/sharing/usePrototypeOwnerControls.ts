import { useSyncExternalStore } from 'react'

type AccessState = {
  locked: boolean
  ownerInvitesOnly: boolean
  cleared: boolean
  restoredProfileIds: string[]
  allUsersCanView?: boolean
}

type WorkspaceState = AccessState & {
  allGadgetsCleared: boolean
  gadgets: Record<number, AccessState>
}

const DEFAULT_ACCESS: AccessState = { locked: false, ownerInvitesOnly: false, cleared: false, restoredProfileIds: [] }
const CLEARED_ACCESS: AccessState = { ...DEFAULT_ACCESS, cleared: true, allUsersCanView: false }
const DEFAULT_WORKSPACE: WorkspaceState = {
  ...DEFAULT_ACCESS,
  allGadgetsCleared: false,
  gadgets: {},
}

const clearAccess = (state: AccessState): AccessState => ({
  ...state,
  cleared: true,
  restoredProfileIds: [],
  allUsersCanView: false,
})

// Prototype-only state shared by the workspace and gadget entry points. No permission RPCs are
// issued: real gadget isolation also requires restricting workspace builders' agent capabilities.
const workspaces = new Map<string, WorkspaceState>()
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export const usePrototypeOwnerControls = (workspaceId: string, gadgetId?: number) => {
  const workspace = useSyncExternalStore(subscribe, () => workspaces.get(workspaceId) ?? DEFAULT_WORKSPACE)
  const gadgetAccess = (state: WorkspaceState) => gadgetId === undefined
    ? state
    : state.gadgets[gadgetId] ?? (state.allGadgetsCleared ? CLEARED_ACCESS : DEFAULT_ACCESS)
  const access = gadgetAccess(workspace)

  const updateWorkspace = (change: (state: WorkspaceState) => WorkspaceState) => {
    workspaces.set(workspaceId, change(workspaces.get(workspaceId) ?? DEFAULT_WORKSPACE))
    listeners.forEach(listener => listener())
  }
  const updateAccess = (change: (state: AccessState) => AccessState) => updateWorkspace(state =>
    gadgetId === undefined
      ? { ...state, ...change(state) }
      : { ...state, gadgets: { ...state.gadgets, [gadgetId]: change(gadgetAccess(state)) } })

  return {
    access,
    workspace,
    locked: workspace.locked || access.locked,
    inheritedLock: gadgetId !== undefined && workspace.locked,
    setLocked: (locked: boolean) => updateAccess(state => ({ ...state, locked })),
    setOwnerInvitesOnly: (ownerInvitesOnly: boolean) => updateAccess(state => ({ ...state, ownerInvitesOnly })),
    restoreProfile: (profileId: string) => updateAccess(state => ({
      ...state,
      restoredProfileIds: [...new Set([...state.restoredProfileIds, profileId])],
    })),
    setAllUsersCanView: (allUsersCanView: boolean) => updateAccess(state => ({ ...state, allUsersCanView })),
    removeEveryone: () => {
      if (gadgetId !== undefined) {
        updateAccess(clearAccess)
      } else {
        updateWorkspace(state => ({
          ...state,
          ...clearAccess(state),
          allGadgetsCleared: true,
          gadgets: Object.fromEntries(Object.entries(state.gadgets).map(([id, gadget]) =>
            [id, clearAccess(gadget)])),
        }))
      }
    },
  }
}
