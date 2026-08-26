import type {Component} from 'solid-js'
import {Show, createMemo, createSignal} from 'solid-js'
import {
  IoTrashSharp,
  IoShieldCheckmarkSharp,
  IoBanSharp,
  IoArrowUndoSharp,
  IoPencilSharp,
  IoHardwareChipSharp
} from 'solid-icons/io'

import type {Bearer} from '../storage'
import {useWallet} from '../WalletContext'
import {useDevice} from '../DeviceContext'
import {
  noteK1,
  noteSignature,
  serverOf,
  verifyNoteSignature
} from '../lnurlcash'
import {markDeviceNoteSpent} from '../deviceOrchestration'
import {
  msatToSats,
  formatDate,
  formatRelativeTime,
  notify,
  NotifyKind
} from '../helpers'
import {
  getTrustedMintPubkey,
  getTrustedMintNodeColor,
  isMintUnconfirmed
} from '../trustedMints'

export type BearerCardProps = {
  bearer: Bearer
  selected: boolean
  onSelect: (selected: boolean) => void
}

const BearerCard: Component<BearerCardProps> = props => {
  const {updateBearer, removeBearer, logActivity} = useWallet()
  const {client: deviceClient} = useDevice()
  const [confirmDelete, setConfirmDelete] = createSignal(false)
  const [confirmUnspend, setConfirmUnspend] = createSignal(false)
  const [editingLabel, setEditingLabel] = createSignal(false)
  const [labelInput, setLabelInput] = createSignal('')

  const k1 = () => noteK1(props.bearer.url) || ''
  const isSpent = () => !!props.bearer.spent

  // this note's issuing mint's self-reported node color (cached via the
  // mint-address lookup, see trustedMints.ts) - tints the card's own
  // background gradient (see the .tinted rule in style.scss) instead of
  // the app's default accent, purely cosmetic. Absent whenever no lookup
  // has ever cached one for this server, same fallback story as
  // offlineVerified's mintPubkey below.
  const noteColor = createMemo(() =>
    getTrustedMintNodeColor(serverOf(props.bearer.url))
  )
  const cardStyle = createMemo(() =>
    noteColor() ? {'--note-tint': noteColor()!} : {}
  )
  const toggleSelect = () => {
    if (!isSpent()) props.onSelect(!props.selected)
  }

  // the whole card is the click target for select-to-combine - except any
  // interactive control inside it (label/mark-spent buttons, the label form
  // input), which should do their own thing rather than also flip selection
  const onCardClick = (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest('button, input, textarea, a')) return
    toggleSelect()
  }
  const onCardKeyDown = (e: KeyboardEvent) => {
    if (e.target !== e.currentTarget) return
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      toggleSelect()
    }
  }

  // offline-verifiable iff the note carries a signature AND this wallet
  // already knows the issuing service's mintPubkey - both optional per
  // spec. The trusted-mints registry is the authoritative source (it can
  // hold a newer key than this one bearer's own cached copy, e.g. if a
  // sibling bearer from the same server refreshed more recently); the
  // bearer's own field is only a fallback for the edge case of a restored
  // record whose server isn't in the registry yet - and withheld entirely
  // when the registry's pin is unconfirmed (file-sourced): then the
  // bearer's cached claim is just as uncorroborated
  const offlineVerified = createMemo(() => {
    const sig = noteSignature(props.bearer.url)
    const server = serverOf(props.bearer.url)
    const mintPubkey =
      getTrustedMintPubkey(server) ??
      (isMintUnconfirmed(server) ? null : props.bearer.mintPubkey)
    if (!sig || !mintPubkey) return false
    return verifyNoteSignature(k1(), props.bearer.amount, sig, mintPubkey)
  })

  // a local-only lock (see storage.ts's Bearer.spent) - no network call,
  // just stops this wallet from acting on a note it considers given away.
  // A device-backed note's on-device copy is retired alongside (queued for
  // the next connect if the vault isn't attached right now), so the vault
  // doesn't keep listing as spendable a note this wallet considers gone
  const markSpent = async () => {
    updateBearer(props.bearer.id, {spent: true})
    if (props.bearer.deviceId) {
      await markDeviceNoteSpent(deviceClient(), props.bearer.deviceId)
    }
    logActivity(
      'spent',
      `Marked ${msatToSats(props.bearer.amount)} sats from ${serverOf(props.bearer.url)} as spent.`
    )
    notify(
      'Marked as spent - split and refresh are locked until unspent.',
      NotifyKind.SUCCESS
    )
  }

  const unspend = () => {
    updateBearer(props.bearer.id, {spent: false})
    setConfirmUnspend(false)
    logActivity(
      'unspent',
      `Unspent ${msatToSats(props.bearer.amount)} sats from ${serverOf(props.bearer.url)}.`
    )
    notify('Unspent - actions are available again.', NotifyKind.SUCCESS)
  }

  // purely local, for the holder's own reference - not part of the note
  // itself, never sent anywhere. Available even on a spent note (unlike the
  // protocol actions above), since it's just a memo, not a mutation of it
  const startEditLabel = () => {
    setLabelInput(props.bearer.label ?? '')
    setEditingLabel(true)
  }

  const saveLabel = () => {
    const trimmed = labelInput().trim()
    updateBearer(props.bearer.id, {label: trimmed || undefined})
    setEditingLabel(false)
  }

  return (
    <figure
      class="bearer-card"
      classList={{
        tinted: !!noteColor(),
        selected: props.selected,
        selectable: !isSpent()
      }}
      style={cardStyle()}
      tabIndex={isSpent() ? undefined : 0}
      title={
        isSpent() ? undefined : 'Click to select for combine/split/transfer'
      }
      onClick={onCardClick}
      onKeyDown={onCardKeyDown}
    >
      <div class="bearer-head">
        <div class="bearer-title">
          <span class="bearer-amount">
            {msatToSats(props.bearer.amount)} sats
          </span>
          <Show when={props.bearer.label}>
            <span class="bearer-label">{props.bearer.label}</span>
          </Show>
          <Show when={!props.bearer.verified}>
            <span class="bearer-pending">unverified</span>
          </Show>
          <Show when={offlineVerified()}>
            <span
              class="bearer-signed"
              title="Signature checks out against this mint's published pubkey"
            >
              <IoShieldCheckmarkSharp />
              &nbsp;signed
            </span>
          </Show>
          <Show when={props.bearer.deviceId}>
            <span
              class="bearer-device"
              title="This note's secret lives on your paired vault, not this browser"
            >
              <IoHardwareChipSharp />
              &nbsp;on device
            </span>
          </Show>
          <Show when={isSpent()}>
            <span class="bearer-spent" title="Locally locked - see below">
              <IoBanSharp />
              &nbsp;spent
            </span>
          </Show>
          <span class="bearer-server">{serverOf(props.bearer.url)}</span>
        </div>
      </div>
      <Show when={editingLabel()}>
        <div class="form-item">
          <label>Label (private, for your own reference)</label>
          <input
            type="text"
            placeholder="e.g. rent, gift for Alex"
            value={labelInput()}
            onInput={e => setLabelInput(e.currentTarget.value)}
            onKeyDown={e => e.key === 'Enter' && saveLabel()}
          />
          <div class="btns">
            <button onClick={saveLabel}>Save</button>
            <button onClick={() => setEditingLabel(false)}>Cancel</button>
          </div>
        </div>
      </Show>
      <div class="btns">
        <button
          class="icon-btn"
          title={props.bearer.label ? 'Edit label' : 'Add a label'}
          onClick={startEditLabel}
        >
          <IoPencilSharp />
        </button>
        <div class="bearer-actions">
          <Show
            when={isSpent()}
            fallback={
              <button
                class="icon-btn"
                title="Mark as spent - lock this note without removing it, e.g. if you already handed it out some other way"
                onClick={markSpent}
              >
                <IoBanSharp />
              </button>
            }
          >
            <button
              class="icon-btn"
              title="Unspend - unlock this note again"
              onClick={() => setConfirmUnspend(true)}
            >
              <IoArrowUndoSharp />
            </button>
          </Show>
          <Show when={isSpent()}>
            <button
              class="icon-btn"
              title="Clear spent note from wallet"
              onClick={() => setConfirmDelete(true)}
            >
              <IoTrashSharp />
            </button>
          </Show>
        </div>
      </div>
      <Show when={isSpent() && !confirmUnspend()}>
        <p class="bearer-hint">
          Locked as spent - refresh and split (in the toolbar above) are
          disabled so this copy can't be reused by accident.
        </p>
      </Show>
      <Show when={confirmUnspend()}>
        <p class="warning">
          This note may already be gone for good - if it was melted, or handed
          to someone who's since redeemed it, unspending it here won't bring it
          back (this is a local flag, not a check with the service). And if you
          handed it over and this wallet spends or rotates it again before the
          recipient does, their copy gets invalidated instead of yours. Unspend
          anyway?
        </p>
        <div class="btns">
          <button onClick={unspend}>Unspend anyway</button>
          <button onClick={() => setConfirmUnspend(false)}>Cancel</button>
        </div>
      </Show>
      <Show when={confirmDelete()}>
        <p class="warning">
          Clear this spent note from the wallet? If it turns out it wasn't
          actually spent, the sats are gone unless you saved the note elsewhere.
        </p>
        <div class="btns">
          <button
            onClick={() => {
              removeBearer(props.bearer.id)
              logActivity(
                'deleted',
                `Cleared a spent ${msatToSats(props.bearer.amount)} sat note from ${serverOf(props.bearer.url)}.`
              )
              notify('Spent note cleared.', NotifyKind.SUCCESS)
            }}
          >
            Clear
          </button>
          <button onClick={() => setConfirmDelete(false)}>Cancel</button>
        </div>
      </Show>
      <p class="bearer-dates" title={formatDate(props.bearer.updatedAt)}>
        updated {formatRelativeTime(props.bearer.updatedAt)}
      </p>
    </figure>
  )
}
export default BearerCard
