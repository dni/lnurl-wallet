import type {Component} from 'solid-js'
import {Show, For, createSignal} from 'solid-js'
import {Dynamic} from 'solid-js/web'
import {
  IoCashSharp,
  IoGitBranchSharp,
  IoGitMergeSharp,
  IoFlameSharp,
  IoSwapHorizontalSharp,
  IoArrowDownCircleSharp,
  IoRefreshSharp,
  IoBanSharp,
  IoArrowUndoSharp,
  IoTrashSharp,
  IoReceiptSharp
} from 'solid-icons/io'

import {useWallet} from '../WalletContext'
import type {ActivityKind} from '../storage'
import {formatDate, formatRelativeTime} from '../helpers'
import RequireWallet from '../components/RequireWallet'

// one icon per ActivityKind, reusing the same icon each action already
// shows elsewhere in the app (Mint's cash, BearerCard's split/refresh/
// spent/unspent, MintGroupCard's combine, Melt's flame, Transfer's swap/
// receive) so a log entry reads as the same action, not a new vocabulary
const KIND_ICON: Record<ActivityKind, Component> = {
  mint: IoCashSharp,
  split: IoGitBranchSharp,
  combine: IoGitMergeSharp,
  melt: IoFlameSharp,
  transfer: IoSwapHorizontalSharp,
  receive: IoArrowDownCircleSharp,
  refresh: IoRefreshSharp,
  spent: IoBanSharp,
  unspent: IoArrowUndoSharp,
  deleted: IoTrashSharp
}

const Activity: Component = () => {
  const {activity, clearActivity} = useWallet()
  const [confirmClear, setConfirmClear] = createSignal(false)

  const clear = () => {
    clearActivity()
    setConfirmClear(false)
  }

  return (
    <RequireWallet>
      <div id="activity" class="page">
        <div class="wallet-hero-header">
          <h2>Activity log</h2>
          <Show when={activity().length > 0}>
            <button
              class="icon-btn"
              title="Clear the activity log"
              onClick={() => setConfirmClear(true)}
            >
              <IoTrashSharp />
            </button>
          </Show>
        </div>
        <Show when={confirmClear()}>
          <p class="warning">
            Clear the whole activity log? This only removes the log itself -
            your notes and their history with each mint are unaffected.
          </p>
          <div class="btns">
            <button onClick={clear}>Clear log</button>
            <button onClick={() => setConfirmClear(false)}>Cancel</button>
          </div>
        </Show>
        <Show
          when={activity().length > 0}
          fallback={
            <p class="bearer-hint">
              Nothing logged yet - minting, splitting, combining, melting, and
              transferring notes all show up here.
            </p>
          }
        >
          <ul class="activity-list">
            <For each={activity()}>
              {event => (
                <li class="activity-item">
                  <span class="activity-icon">
                    <Dynamic
                      component={KIND_ICON[event.kind] ?? IoReceiptSharp}
                    />
                  </span>
                  <span class="activity-message">{event.message}</span>
                  <span
                    class="activity-time"
                    title={formatDate(event.createdAt)}
                  >
                    {formatRelativeTime(event.createdAt)}
                  </span>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </div>
    </RequireWallet>
  )
}
export default Activity
