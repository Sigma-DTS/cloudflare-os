import { useId, useState, type MouseEvent, type Ref } from 'react'
import { Autocomplete, InputGroup } from '@cloudflare/kumo'
import { Autocomplete as AutocompletePrimitive } from '@cloudflare/kumo/primitives/autocomplete'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi, UserDirectoryRecord } from '@gadgets/workshop-shared/api'
import { PersonAvatar } from '../../components/PersonAvatar'
import { WorkshopButton } from '../../components/WorkshopControls'
import { isImeComposing } from '../../keyboardEvent'
import { useUserDirectorySearch } from './useUserDirectorySearch'

type Props = {
  authenticatedApi: RpcStub<AuthenticatedApi>
  /** Whether the deployment's user directory can be searched. */
  searchEnabled: boolean
  /** Whether the current members have loaded; 'failed' falls back to direct invites. */
  membership: 'loading' | 'ready' | 'failed'
  /** People who are already on the workspace and so cannot be invited. */
  excludeIds: string[]
  value: string
  onValueChange: (value: string) => void
  action: 'Invite' | 'Share'
  adding: boolean
  error: string | null
  onInvite: (userId: string) => void
  inputRef: Ref<HTMLInputElement>
}

/** Invites one person at a time: Enter, choosing a result, or Invite submits immediately. */
export const InviteComposer = ({
  authenticatedApi,
  searchEnabled,
  membership,
  excludeIds,
  value,
  onValueChange,
  action,
  adding,
  error,
  onInvite,
  inputRef,
}: Props) => {
  const errorId = useId()
  // The result popover is dismissed when focus leaves the combobox or on Escape; typing or
  // refocusing brings it back. The query and its search survive a dismissal.
  const [dismissed, setDismissed] = useState(true)
  const [highlightedUser, setHighlightedUser] = useState<UserDirectoryRecord | null>(null)
  const query = value.trim()
  const searching = searchEnabled && membership === 'ready' && !adding && query !== ''
  const search = useUserDirectorySearch({ api: authenticatedApi, query, enabled: searching, excludeIds })
  const open = searching && !dismissed && !search.noMatches
  // Once the search has settled, the typed text can always be submitted as a canonical id: the
  // directory is a lazily backfilled convenience, so a valid id may be missing from it (or
  // shadowed by unrelated substring matches), and a directory outage must not block invites.
  // A membership-load failure also falls back to the authoritative direct-invite path.
  const canSubmit = query !== '' && (!searchEnabled ||
    (membership !== 'loading' && (membership === 'failed' || search.settled)))
  // Results from an earlier query stay visible while the next search runs, but only settled
  // results can be confirmed with the keyboard or the Invite button.
  const highlightedId = open && search.settled && highlightedUser &&
    search.results.some(user => user.id === highlightedUser.id)
    ? highlightedUser.id
    : null

  const invite = (userId: string) => {
    setDismissed(true)
    onInvite(userId)
  }

  // Confirming a highlighted result only fills the field, so what will be invited is visible;
  // confirming again, with nothing highlighted, sends it.
  const submit = () => {
    if (highlightedId) {
      onValueChange(highlightedId)
      setDismissed(true)
    } else if (canSubmit) {
      invite(query)
    }
  }

  const inviteLabel = adding ? (action === 'Invite' ? 'Inviting…' : 'Sharing…') : action
  // Keep the visible result highlighted until the click handler chooses it.
  const keepResultHighlighted = (event: MouseEvent) => {
    if (open) event.preventDefault()
  }

  return (
    <div className="sticky top-0 z-10 bg-kumo-base pt-1 pb-3">
      <Autocomplete<UserDirectoryRecord>
        items={search.results}
        filter={null}
        autoHighlight="always"
        openOnInputClick
        open={open}
        onOpenChange={(nextOpen) => setDismissed(!nextOpen)}
        value={value}
        readOnly={adding}
        itemToStringValue={(user) => user.id}
        onItemHighlighted={(user) => setHighlightedUser(user ?? null)}
        onValueChange={(next, { reason }) => {
          if (reason === 'escape-key') return
          if (reason === 'item-press') {
            invite(next)
            return
          }
          onValueChange(next)
          setDismissed(false)
        }}
      >
        <AutocompletePrimitive.InputGroup render={<InputGroup
          data-testid="people-composer"
          className="gap-2 py-2 pr-1 h-auto bg-kumo-elevated rounded-xl"
          data-keeper-ignore="true"
          data-1p-ignore="true"
          data-lpignore="true"
          data-bwignore="true"
        />}>
          <AutocompletePrimitive.Input
            ref={inputRef}
            render={<InputGroup.Input />}
            type="search"
            placeholder={searchEnabled ? 'Search by name or email' : 'Username or email'}
            aria-label={searchEnabled ? 'Search people' : 'Username or email'}
            aria-invalid={error !== null}
            aria-describedby={error ? errorId : undefined}
            onFocus={() => setDismissed(false)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !isImeComposing(event)) {
                event.preventDefault()
                event.preventBaseUIHandler()
                submit()
              }
            }}
            name="gadget-share-people-search"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            data-keeper-ignore="true"
            data-1p-ignore="true"
            data-lpignore="true"
            data-bwignore="true"
            data-form-type="other"
            className="text-sm [&::-webkit-search-cancel-button]:hidden"
          />
          <InputGroup.Addon align="end">
            <InputGroup.Button
              className='hidden rounded-lg sm:flex'
              variant="secondary"
              onMouseDown={keepResultHighlighted}
              onClick={submit}
              disabled={!canSubmit || adding}
            >
              {inviteLabel}
            </InputGroup.Button>
          </InputGroup.Addon>
        </AutocompletePrimitive.InputGroup>
        {/* Keep loading and error feedback visible while there are no suggestion items. */}
        <Autocomplete.Content className="flex">
          <Autocomplete.Empty>
            <p role="status" className={`px-3 py-2 text-[12px] ${search.failed ? 'text-kumo-danger' : 'text-kumo-subtle'}`}>
              {search.failed ? 'User search is temporarily unavailable.' : 'Searching…'}
            </p>
          </Autocomplete.Empty>
          <Autocomplete.List aria-label="Matching people" aria-busy={search.loading}>
            {(user: UserDirectoryRecord) => (
              <Autocomplete.Item key={user.id} value={user}>
                <div className="flex min-w-0 items-center gap-2">
                  <PersonAvatar api={authenticatedApi} userId={user.id} name={user.name} size={26} />
                  <span className="min-w-0 text-sm text-kumo-default">
                    <span className="block truncate font-medium">{user.name}</span>
                    <span className="block truncate text-xs text-kumo-subtle">{user.id}</span>
                  </span>
                </div>
              </Autocomplete.Item>
            )}
          </Autocomplete.List>
        </Autocomplete.Content>
      </Autocomplete>
      {error && (
        <p id={errorId} role="alert" className="mt-1.5 break-words px-1 text-[12px] leading-4 text-kumo-danger">
          {error}
        </p>
      )}
      {/* On narrow screens the input has no room for the button, so it sits beneath it. */}
      <WorkshopButton
        tone="primary"
        className="mt-2 w-full sm:hidden"
        onMouseDown={keepResultHighlighted}
        onClick={submit}
        disabled={!canSubmit || adding}
      >
        {inviteLabel}
      </WorkshopButton>
    </div>
  )
}
