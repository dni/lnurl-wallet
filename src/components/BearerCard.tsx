import type {Component} from 'solid-js'
import {Show, createMemo, createSignal} from 'solid-js'
import {
  IoTrashSharp,
  IoShieldCheckmarkSharp,
  IoBanSharp,
  IoArrowUndoSharp,
  IoHardwareChipSharp,
  IoEyeSharp,
  IoCopySharp,
  IoRefreshSharp
} from 'solid-icons/io'

import type {Bearer} from '../storage'
import {useWallet} from '../WalletContext'
import {useDevice} from '../DeviceContext'
import {
  noteK1,
  noteSignature,
  serverOf,
  toBech32Lnurl,
  verifyNoteSignature,
  verifyNoteSignatureHash
} from '../lnurlcash'
import {
  deviceExportForHandoff,
  markDeviceNoteSpent,
  requireDeviceClient
} from '../deviceOrchestration'
import {
  msatToSats,
  formatDate,
  formatRelativeTime,
  copyToClipboard,
  notify,
  NotifyKind
} from '../helpers'
import {
  getTrustedMintPubkey,
  getTrustedMintNodeColor,
  isMintUnconfirmed
} from '../trustedMints'
import Qr from './Qr'
import FiatValue from './FiatValue'

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
  // whether the "hand this note over" panel is open at all - separate from
  // revealedUrl below, since a device-backed note opens the panel before
  // its secret is actually known (see revealDeviceNote)
  const [unveiling, setUnveiling] = createSignal(false)
  // this note's real, secret-bearing url - null until revealed. For a
  // browser-only note this is available the instant the panel opens (see
  // startUnveil); a device-backed one needs an explicit export (physical
  // button press) first - see revealDeviceNote. Never persisted, only ever
  // held here in memory.
  const [revealedUrl, setRevealedUrl] = createSignal<string | null>(null)
  const [revealing, setRevealing] = createSignal(false)
  // tap-to-reveal on the QR itself - a shoulder-surfing guard, so the note's
  // actual secret never sits bare on screen just because the panel is open
  const [qrRevealed, setQrRevealed] = createSignal(false)

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
  // interactive control inside it (a spent note's own Unspend/Clear
  // buttons), which should do their own thing rather than also flip
  // selection - and except while the hand-over panel is open, where a
  // stray click on the revealed QR itself (not a button) shouldn't also
  // toggle selection underneath it
  const onCardClick = (e: MouseEvent) => {
    if (unveiling()) return
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
    return props.bearer.deviceHash
      ? verifyNoteSignatureHash(
          props.bearer.deviceHash,
          props.bearer.amount,
          sig,
          mintPubkey
        )
      : verifyNoteSignature(k1(), props.bearer.amount, sig, mintPubkey)
  })

  // single-note version of Wallet.tsx's markSpentSelected - a quick, direct
  // lock right from the card, for when handing a note over some other way
  // (in person, a different app) doesn't go through Unveil's own Done step
  const markSpent = async () => {
    updateBearer(props.bearer.id, {spent: true})
    if (props.bearer.deviceId) {
      await markDeviceNoteSpent(deviceClient(), props.bearer.deviceId)
    }
    logActivity(
      'spent',
      `Marked ${msatToSats(props.bearer.amount)} sats from ${serverOf(props.bearer.url)} as spent.`,
      props.bearer.label
    )
    notify('Marked as spent.', NotifyKind.SUCCESS)
  }

  const unspend = () => {
    updateBearer(props.bearer.id, {spent: false})
    setConfirmUnspend(false)
    logActivity(
      'unspent',
      `Unspent ${msatToSats(props.bearer.amount)} sats from ${serverOf(props.bearer.url)}.`,
      props.bearer.label
    )
    notify('Unspent - actions are available again.', NotifyKind.SUCCESS)
  }

  // opens the hand-over panel - browser-only notes reveal immediately
  // (their url already carries the real secret); device-backed ones wait
  // for an explicit reveal action (see revealDeviceNote)
  const startUnveil = () => {
    setUnveiling(true)
    setRevealedUrl(props.bearer.deviceId ? null : props.bearer.url)
    setQrRevealed(false)
  }

  const cancelUnveil = () => {
    setUnveiling(false)
    setRevealedUrl(null)
    setQrRevealed(false)
  }

  const revealDeviceNote = async () => {
    if (!props.bearer.deviceId) return
    setRevealing(true)
    try {
      const client = requireDeviceClient(deviceClient())
      const {url} = await deviceExportForHandoff(
        client,
        props.bearer.deviceId,
        props.bearer.url,
        props.bearer.amount
      )
      setRevealedUrl(url)
    } catch (err) {
      notify((err as Error).message, NotifyKind.ERROR)
    } finally {
      setRevealing(false)
    }
  }

  const markHandedOver = async () => {
    updateBearer(props.bearer.id, {spent: true})
    if (props.bearer.deviceId) {
      await markDeviceNoteSpent(deviceClient(), props.bearer.deviceId)
    }
    cancelUnveil()
    logActivity(
      'transfer',
      `Handed over ${msatToSats(props.bearer.amount)} sats from ${serverOf(props.bearer.url)}.`,
      props.bearer.label
    )
    notify('Marked as handed over and spent.', NotifyKind.SUCCESS)
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
            <FiatValue msat={props.bearer.amount} />
          </span>
          <Show when={props.bearer.label && !isSpent()}>
            <span class="bearer-label">{props.bearer.label}</span>
          </Show>
          <div class="bearer-badges">
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
              <span
                class="bearer-spent"
                title="Locked as spent - refresh and split (in the toolbar above) are disabled so this copy can't be reused by accident."
              >
                <IoBanSharp />
                &nbsp;spent
              </span>
            </Show>
          </div>
          <span class="bearer-server">{serverOf(props.bearer.url)}</span>
        </div>
      </div>
      <Show when={isSpent()}>
        <div class="btns">
          <div class="bearer-actions">
            <button
              class="icon-btn"
              title="Unspend - unlock this note again"
              onClick={() => setConfirmUnspend(true)}
            >
              <IoArrowUndoSharp />
            </button>
            <button
              class="icon-btn"
              title="Clear spent note from wallet"
              onClick={() => setConfirmDelete(true)}
            >
              <IoTrashSharp />
            </button>
          </div>
        </div>
      </Show>
      <Show when={!isSpent()}>
        <Show
          when={unveiling()}
          fallback={
            <div class="btns">
              <div class="bearer-actions">
                <button
                  class="icon-btn"
                  title="Unveil to hand over"
                  onClick={startUnveil}
                >
                  <IoEyeSharp />
                </button>
                <button
                  class="icon-btn"
                  title="Copy this note to clipboard"
                  onClick={() =>
                    copyToClipboard(toBech32Lnurl(props.bearer.url))
                  }
                >
                  <IoCopySharp />
                </button>
                <button
                  class="icon-btn bearer-action-right"
                  title="Mark as spent - locks this note without removing it, e.g. if you already handed it out some other way"
                  onClick={markSpent}
                >
                  <IoRefreshSharp />
                </button>
              </div>
            </div>
          }
        >
          <Show
            when={revealedUrl()}
            fallback={
              <div class="btns">
                <button disabled={revealing()} onClick={revealDeviceNote}>
                  <Show when={revealing()}>
                    <IoRefreshSharp class="spin" />
                    &nbsp;
                  </Show>
                  {revealing()
                    ? 'Waiting for the vault...'
                    : 'Reveal to hand over'}
                </button>
                <button onClick={cancelUnveil}>Cancel</button>
              </div>
            }
          >
            {url => (
              <>
                <div class="qr-wrapper">
                  <Qr value={toBech32Lnurl(url())} />
                  <Show when={!qrRevealed()}>
                    <button
                      class="qr-overlay"
                      title="Show QR code - it IS the bearer note, anyone who scans it can spend it"
                      onClick={() => setQrRevealed(true)}
                    >
                      <IoEyeSharp />
                    </button>
                  </Show>
                </div>
                <div class="btns">
                  <button onClick={() => copyToClipboard(toBech32Lnurl(url()))}>
                    <IoCopySharp />
                    &nbsp;Copy note
                  </button>
                  <button onClick={markHandedOver}>Done</button>
                  <button onClick={cancelUnveil}>Cancel</button>
                </div>
              </>
            )}
          </Show>
        </Show>
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
                `Cleared a spent ${msatToSats(props.bearer.amount)} sat note from ${serverOf(props.bearer.url)}.`,
                props.bearer.label
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
