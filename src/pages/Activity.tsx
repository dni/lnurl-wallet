import type {Component} from 'solid-js'
import {Show, For, createSignal} from 'solid-js'
import {Dynamic} from 'solid-js/web'
import {A} from '@solidjs/router'
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
  IoReceiptSharp,
  IoArrowBackSharp,
  IoOpenSharp
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

// mint/melt messages end with a raw " Verify: <url>." (see Mint.tsx and
// MeltDialog.tsx's own logActivity calls) - pulled back out here rather
// than adding a structured field to ActivityEvent, so the message itself
// stays the simple opaque sentence storage.ts's own comment describes.
// Non-greedy up to the final literal '.' so it captures the full url, not
// the sentence-ending period after it
const VERIFY_SUFFIX = / Verify: (\S+?)\.$/

const splitVerifyUrl = (
  message: string
): {text: string; verifyUrl: string | null} => {
  const match = message.match(VERIFY_SUFFIX)
  if (!match) return {text: message, verifyUrl: null}
  return {text: message.slice(0, match.index), verifyUrl: match[1]}
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
        <div class="activity-header">
          <A href="/wallet" class="icon-btn" title="Back to wallet">
            <IoArrowBackSharp />
          </A>
          <h2>Activity log</h2>
          <Show when={activity().length > 0}>
            <button
              class="icon-btn activity-clear-btn"
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
              {event => {
                const {text, verifyUrl} = splitVerifyUrl(event.message)
                return (
                  <li class="activity-item">
                    <span class="activity-icon">
                      <Dynamic
                        component={KIND_ICON[event.kind] ?? IoReceiptSharp}
                      />
                    </span>
                    <span class="activity-message-group">
                      <span class="activity-message">
                        {text}
                        <Show when={verifyUrl}>
                          {url => (
                            <a
                              class="activity-verify-link"
                              href={url()}
                              target="_blank"
                              rel="noreferrer"
                              title="Open the payment verification link"
                            >
                              <IoOpenSharp />
                              &nbsp;Verify
                            </a>
                          )}
                        </Show>
                      </span>
                      <Show when={event.label}>
                        <span class="activity-label">{event.label}</span>
                      </Show>
                    </span>
                    <span
                      class="activity-time"
                      title={formatDate(event.createdAt)}
                    >
                      {formatRelativeTime(event.createdAt)}
                    </span>
                  </li>
                )
              }}
            </For>
          </ul>
        </Show>
      </div>
    </RequireWallet>
  )
}
export default Activity
