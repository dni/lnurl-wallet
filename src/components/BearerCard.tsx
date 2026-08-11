import type {Component} from 'solid-js'
import {Show, createMemo, createSignal} from 'solid-js'
import {
  IoCopySharp,
  IoEyeSharp,
  IoEyeOffSharp,
  IoQrCodeSharp,
  IoRefreshSharp,
  IoFlameSharp,
  IoGitBranchSharp,
  IoTrashSharp,
  IoShieldCheckmarkSharp,
  IoBanSharp,
  IoArrowUndoSharp,
  IoReorderThreeSharp
} from 'solid-icons/io'

import type {Bearer} from '../storage'
import {useWallet} from '../WalletContext'
import {
  toBech32Lnurl,
  noteK1,
  noteSignature,
  serverOf,
  withNewK1,
  fetchNoteInfo,
  verifyNoteSignature,
  meltNote,
  splitNote,
  rotateNote
} from '../lnurlcash'
import {
  copyToClipboard,
  msatToSats,
  satsToMsat,
  formatDate,
  formatRelativeTime,
  notify,
  NotifyKind
} from '../helpers'
import {getTrustedMintPubkey} from '../trustedMints'
import {offlineMode} from '../offlineMode'
import Qr from './Qr'

type Action = 'melt' | 'split' | null

export type BearerCardProps = {
  bearer: Bearer
  selected: boolean
  onSelect: (selected: boolean) => void
  // drag-to-reorder (see MintGroupCard) - the handle only renders when a
  // handler is given, which MintGroupCard withholds for a spent note
  dragging?: boolean
  onDragHandleDown?: (e: PointerEvent) => void
  setRef?: (el: HTMLElement) => void
}

const BearerCard: Component<BearerCardProps> = props => {
  const {updateBearer, removeBearer, addBearer} = useWallet()
  // the QR is the bearer note itself, so revealing it is two deliberate
  // steps: the corner toggle brings back the space for it at all (mostly to
  // avoid every card in a long list reserving a square of space it won't
  // need, especially on mobile), then it still sits behind its own overlay
  // until tapped, so it can't be flashed on screen by one careless tap.
  // revealed always resets on the way back out, so showing it again later
  // starts covered too, not wherever it was left off
  const [showQr, setShowQr] = createSignal(false)
  const [revealed, setRevealed] = createSignal(false)
  const toggleShowQr = () => {
    setShowQr(v => !v)
    setRevealed(false)
  }
  const [action, setAction] = createSignal<Action>(null)
  const [busy, setBusy] = createSignal(false)
  const [meltPr, setMeltPr] = createSignal('')
  const [splitSats, setSplitSats] = createSignal('')
  const [confirmDelete, setConfirmDelete] = createSignal(false)
  const [confirmUnspend, setConfirmUnspend] = createSignal(false)

  const token = () => toBech32Lnurl(props.bearer.url)
  const k1 = () => noteK1(props.bearer.url) || ''
  const hasCallback = () => props.bearer.callback !== ''
  const isSpent = () => !!props.bearer.spent
  // the amount and server text are also click targets for select-to-combine
  // - a bigger, more obvious target than the small checkbox alone, which
  // stays as the visible indicator of the current state either way
  const toggleSelect = () => {
    if (!isSpent()) props.onSelect(!props.selected)
  }

  // offline-verifiable iff the note carries a signature AND this wallet
  // already knows the issuing service's mintPubkey - both optional per
  // spec. The trusted-mints registry is the authoritative source (it can
  // hold a newer key than this one bearer's own cached copy, e.g. if a
  // sibling bearer from the same server refreshed more recently); the
  // bearer's own field is only a fallback for the edge case of a restored
  // record whose server isn't in the registry yet.
  const offlineVerified = createMemo(() => {
    const sig = noteSignature(props.bearer.url)
    const mintPubkey =
      getTrustedMintPubkey(serverOf(props.bearer.url)) ??
      props.bearer.mintPubkey
    if (!sig || !mintPubkey) return false
    return verifyNoteSignature(k1(), props.bearer.amount, sig, mintPubkey)
  })

  // the informational GET always puts k1 on the wire now (the spec dropped
  // the optional hash-based lookup), so every refresh is followed by a
  // rotate - per "WALLET SHOULD ... rotate ... after an informational GET
  // on a note it intends to keep holding"
  const refresh = async () => {
    setBusy(true)
    try {
      const info = await fetchNoteInfo(props.bearer.url)
      let url = props.bearer.url
      try {
        const rotated = await rotateNote(info.callback, k1())
        url = withNewK1(
          props.bearer.url,
          rotated.k1,
          info.maxWithdrawable,
          rotated.signature
        )
      } catch {
        notify(
          'Service does not support rotation - your secret was just transmitted, treat old copies of this note as exposed.',
          NotifyKind.ERROR
        )
      }
      await updateBearer(props.bearer.id, {
        url,
        callback: info.callback,
        amount: info.maxWithdrawable,
        verified: true,
        mintPubkey: info.mintPubkey ?? props.bearer.mintPubkey
      })
      notify('Note refreshed.', NotifyKind.SUCCESS)
    } catch (err) {
      notify((err as Error).message, NotifyKind.ERROR)
    } finally {
      setBusy(false)
    }
  }

  const melt = async () => {
    if (!meltPr().trim()) {
      notify('Paste a bolt11 invoice to melt into.', NotifyKind.ERROR)
      return
    }
    setBusy(true)
    try {
      await meltNote(props.bearer.callback, k1(), meltPr())
      // {"status":"OK"} only means the payment is now in flight - SERVICE
      // finalizes the burn once it settles, or restores the note if it
      // fails, so this isn't confirmation the note is actually spent yet.
      // Leave it in the wallet rather than remove it outright, but lock it
      // so it can't be acted on again out from under the in-flight payment;
      // unspend it (see the warning there) if the payment turns out to
      // have failed and the note is still good
      await updateBearer(props.bearer.id, {spent: true})
      setAction(null)
      setMeltPr('')
      notify(
        'Melt requested and the note is now locked as spent - the payment is on its way.',
        NotifyKind.SUCCESS
      )
    } catch (err) {
      notify((err as Error).message, NotifyKind.ERROR)
    } finally {
      setBusy(false)
    }
  }

  const split = async () => {
    const msat = satsToMsat(splitSats())
    if (!splitSats() || !Number.isFinite(msat) || msat <= 0) {
      notify('Enter an amount in sats.', NotifyKind.ERROR)
      return
    }
    if (msat >= props.bearer.amount) {
      notify('Split amount must be below the note value.', NotifyKind.ERROR)
      return
    }
    setBusy(true)
    try {
      const parts = await splitNote(props.bearer.callback, k1(), msat)
      // the old secret is burned - replace this note with the two fresh
      // ones; their values are derived from the operation, per the spec
      removeBearer(props.bearer.id)
      await addBearer({
        url: withNewK1(props.bearer.url, parts.k1, msat, parts.signature),
        callback: props.bearer.callback,
        amount: msat,
        verified: true,
        mintPubkey: props.bearer.mintPubkey
      })
      await addBearer({
        url: withNewK1(
          props.bearer.url,
          parts.change,
          props.bearer.amount - msat,
          parts.changeSignature
        ),
        callback: props.bearer.callback,
        amount: props.bearer.amount - msat,
        verified: true,
        mintPubkey: props.bearer.mintPubkey
      })
      notify('Split into two notes.', NotifyKind.SUCCESS)
      setAction(null)
    } catch (err) {
      notify((err as Error).message, NotifyKind.ERROR)
    } finally {
      setBusy(false)
    }
  }

  // a local-only lock (see storage.ts's Bearer.spent) - no network call,
  // just stops this wallet from acting on a note it considers given away
  const markSpent = () => {
    updateBearer(props.bearer.id, {spent: true})
    notify(
      'Marked as spent - melt, split and refresh are locked until unspent.',
      NotifyKind.SUCCESS
    )
  }

  const unspend = () => {
    updateBearer(props.bearer.id, {spent: false})
    setConfirmUnspend(false)
    notify('Unspent - actions are available again.', NotifyKind.SUCCESS)
  }

  return (
    <figure
      class="bearer-card"
      classList={{dragging: props.dragging}}
      ref={props.setRef}
    >
      <div class="bearer-head">
        <Show when={props.onDragHandleDown}>
          {onDragHandleDown => (
            <button
              class="icon-btn drag-handle"
              title="Drag to reorder"
              onPointerDown={onDragHandleDown()}
            >
              <IoReorderThreeSharp />
            </button>
          )}
        </Show>
        <label class="bearer-select" title="Select for combine">
          <input
            type="checkbox"
            checked={props.selected}
            disabled={isSpent()}
            onChange={e => props.onSelect(e.currentTarget.checked)}
          />
        </label>
        <div class="bearer-title">
          <span
            class="bearer-amount"
            classList={{clickable: !isSpent()}}
            onClick={toggleSelect}
          >
            {msatToSats(props.bearer.amount)} sats
          </span>
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
          <Show when={isSpent()}>
            <span class="bearer-spent" title="Locally locked - see below">
              <IoBanSharp />
              &nbsp;spent
            </span>
          </Show>
          <span
            class="bearer-server"
            classList={{clickable: !isSpent()}}
            onClick={toggleSelect}
          >
            {serverOf(props.bearer.url)}
          </span>
        </div>
        <button
          class="icon-btn qr-toggle"
          title={showQr() ? 'Hide QR code' : 'Show QR code'}
          onClick={toggleShowQr}
        >
          <Show when={showQr()} fallback={<IoQrCodeSharp />}>
            <IoEyeOffSharp />
          </Show>
        </button>
      </div>
      <Show when={showQr()}>
        <div class="qr-wrapper">
          <Qr value={token()} />
          <Show when={!revealed()}>
            <button
              class="qr-overlay"
              title="Show QR code - it IS the bearer note, anyone who scans it can spend it"
              onClick={() => setRevealed(true)}
            >
              <IoEyeSharp />
            </button>
          </Show>
        </div>
      </Show>
      <div class="btns">
        <button
          class="icon-btn"
          title="Copy note (bech32 LNURL)"
          onClick={() => copyToClipboard(token())}
        >
          <IoCopySharp />
        </button>
        <button
          class="icon-btn"
          title={
            offlineMode()
              ? 'Offline mode is on'
              : 'Refresh value from the service, then rotate (the GET necessarily exposes k1)'
          }
          disabled={busy() || isSpent() || offlineMode()}
          onClick={refresh}
        >
          <IoRefreshSharp classList={{spin: busy()}} />
        </button>
        <div class="bearer-actions">
          <button
            class="icon-btn"
            title={
              offlineMode()
                ? 'Offline mode is on'
                : "Melt - have the service pay a bolt11 invoice of exactly this note's value"
            }
            disabled={!hasCallback() || isSpent() || offlineMode()}
            onClick={() => setAction(action() === 'melt' ? null : 'melt')}
          >
            <IoFlameSharp />
          </button>
          <button
            class="icon-btn"
            title={
              offlineMode() ? 'Offline mode is on' : 'Split into two notes'
            }
            disabled={!hasCallback() || isSpent() || offlineMode()}
            onClick={() => setAction(action() === 'split' ? null : 'split')}
          >
            <IoGitBranchSharp />
          </button>
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
      <Show when={!hasCallback() && !isSpent()}>
        <p class="bearer-hint">
          Not verified with its service yet - refresh to enable melt and split.
        </p>
      </Show>
      <Show when={isSpent() && !confirmUnspend()}>
        <p class="bearer-hint">
          Locked as spent - refresh, melt and split are disabled so this copy
          can't be reused by accident.
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
              notify('Spent note cleared.', NotifyKind.SUCCESS)
            }}
          >
            Clear
          </button>
          <button onClick={() => setConfirmDelete(false)}>Cancel</button>
        </div>
      </Show>
      <Show when={action() === 'melt'}>
        <div class="form-item">
          <label>
            Melt into a bolt11 invoice of exactly{' '}
            {msatToSats(props.bearer.amount)} sats (merge first to melt several
            notes)
          </label>
          <input
            type="text"
            placeholder="lnbc..."
            value={meltPr()}
            onInput={e => setMeltPr(e.currentTarget.value)}
          />
          <div class="btns">
            <button disabled={busy() || offlineMode()} onClick={melt}>
              <Show when={busy()}>
                <IoRefreshSharp class="spin" />
                &nbsp;
              </Show>
              Melt
            </button>
          </div>
        </div>
      </Show>
      <Show when={action() === 'split'}>
        <div class="form-item">
          <label>Split off (sats, of {msatToSats(props.bearer.amount)})</label>
          <input
            type="number"
            min="1"
            placeholder="amount in sats"
            value={splitSats()}
            onInput={e => setSplitSats(e.currentTarget.value)}
          />
          <div class="btns">
            <button disabled={busy() || offlineMode()} onClick={split}>
              <Show when={busy()}>
                <IoRefreshSharp class="spin" />
                &nbsp;
              </Show>
              Split
            </button>
          </div>
        </div>
      </Show>
      <p class="bearer-dates" title={formatDate(props.bearer.updatedAt)}>
        updated {formatRelativeTime(props.bearer.updatedAt)}
      </p>
    </figure>
  )
}
export default BearerCard
