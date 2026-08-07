import type {Component} from 'solid-js'
import {Show, createMemo, createSignal} from 'solid-js'
import {
  IoCopySharp,
  IoEyeSharp,
  IoEyeOffSharp,
  IoRefreshSharp,
  IoFlameSharp,
  IoGitBranchSharp,
  IoSwapHorizontalSharp,
  IoTrashSharp,
  IoShieldCheckmarkSharp,
  IoBanSharp,
  IoArrowUndoSharp
} from 'solid-icons/io'

import type {Bearer} from '../storage'
import {useWallet} from '../WalletContext'
import {
  toBech32Lnurl,
  toLud17w,
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
  notify,
  NotifyKind
} from '../helpers'
import {getTrustedMintPubkey} from '../trustedMints'
import Qr from './Qr'

type Action = 'melt' | 'split' | 'transfer' | null

export type BearerCardProps = {
  bearer: Bearer
  selected: boolean
  onSelect: (selected: boolean) => void
}

const BearerCard: Component<BearerCardProps> = props => {
  const {updateBearer, removeBearer, addBearer} = useWallet()
  // the QR is the bearer note itself - keep it behind an overlay until
  // deliberately revealed, like lnurl_server's hideable QRs
  const [showQr, setShowQr] = createSignal(false)
  const [action, setAction] = createSignal<Action>(null)
  const [busy, setBusy] = createSignal(false)
  const [meltPr, setMeltPr] = createSignal('')
  const [splitSats, setSplitSats] = createSignal('')
  // set once a transfer rotated the secret - the fresh note to hand over
  const [handover, setHandover] = createSignal<string | null>(null)
  const [confirmDelete, setConfirmDelete] = createSignal(false)
  const [confirmUnspend, setConfirmUnspend] = createSignal(false)

  const token = () => toBech32Lnurl(props.bearer.url)
  const k1 = () => noteK1(props.bearer.url) || ''
  const hasCallback = () => props.bearer.callback !== ''
  const isSpent = () => !!props.bearer.spent

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

  const transfer = async () => {
    setBusy(true)
    try {
      const rotated = await rotateNote(props.bearer.callback, k1())
      // the old secret is dead the moment the service rotates it - keep the
      // fresh note stored until the holder confirms the handover
      const url = withNewK1(
        props.bearer.url,
        rotated.k1,
        props.bearer.amount,
        rotated.signature
      )
      await updateBearer(props.bearer.id, {url})
      setHandover(toBech32Lnurl(url))
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
      'Marked as spent - melt, split, transfer and refresh are locked until unspent.',
      NotifyKind.SUCCESS
    )
  }

  const unspend = () => {
    updateBearer(props.bearer.id, {spent: false})
    setConfirmUnspend(false)
    notify('Unspent - actions are available again.', NotifyKind.SUCCESS)
  }

  return (
    <figure class="bearer-card">
      <div class="bearer-head">
        <label class="bearer-select" title="Select for combine">
          <input
            type="checkbox"
            checked={props.selected}
            disabled={isSpent()}
            onChange={e => props.onSelect(e.currentTarget.checked)}
          />
        </label>
        <div class="bearer-title">
          <span class="bearer-amount">
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
          <span class="bearer-server">{serverOf(props.bearer.url)}</span>
        </div>
      </div>
      <div class="qr-wrapper">
        <Qr value={handover() ?? token()} />
        <Show when={!showQr()}>
          <button
            class="qr-overlay"
            title="Show QR code - it IS the bearer note, anyone who scans it can spend it"
            onClick={() => setShowQr(true)}
          >
            <IoEyeSharp />
          </button>
        </Show>
        <Show when={showQr()}>
          <button
            class="icon-btn qr-visibility-toggle"
            title="Hide QR code"
            onClick={() => setShowQr(false)}
          >
            <IoEyeOffSharp />
          </button>
        </Show>
      </div>
      <Show when={handover()}>
        <p class="warning">
          Secret rotated - this QR is the fresh note. Hand it to the recipient;
          your old copy is already burned.
        </p>
        <div class="btns">
          <button
            onClick={() => {
              updateBearer(props.bearer.id, {spent: true})
              setHandover(null)
              notify('Marked as handed over and spent.', NotifyKind.SUCCESS)
            }}
          >
            Handed over
          </button>
          <button onClick={() => setHandover(null)}>Keep it myself</button>
        </div>
      </Show>
      <div class="btns">
        <button
          class="icon-btn"
          title="Copy note (bech32 LNURL)"
          onClick={() => copyToClipboard(handover() ?? token())}
        >
          <IoCopySharp />
        </button>
        <button
          class="icon-btn"
          title="Refresh value from the service, then rotate (the GET necessarily exposes k1)"
          disabled={busy() || isSpent()}
          onClick={refresh}
        >
          <IoRefreshSharp classList={{spin: busy()}} />
        </button>
        <div class="bearer-actions">
          <button
            class="icon-btn"
            title="Melt - have the service pay a bolt11 invoice of exactly this note's value"
            disabled={!hasCallback() || isSpent()}
            onClick={() => setAction(action() === 'melt' ? null : 'melt')}
          >
            <IoFlameSharp />
          </button>
          <button
            class="icon-btn"
            title="Split into two notes"
            disabled={!hasCallback() || isSpent()}
            onClick={() => setAction(action() === 'split' ? null : 'split')}
          >
            <IoGitBranchSharp />
          </button>
          <button
            class="icon-btn"
            title="Transfer - rotate the secret and hand the fresh note over"
            disabled={!hasCallback() || isSpent()}
            onClick={() =>
              setAction(action() === 'transfer' ? null : 'transfer')
            }
          >
            <IoSwapHorizontalSharp />
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
          <button
            class="icon-btn"
            title={
              isSpent() ? 'Clear spent note from wallet' : 'Remove from wallet'
            }
            onClick={() => setConfirmDelete(true)}
          >
            <IoTrashSharp />
          </button>
        </div>
      </div>
      <Show when={!hasCallback() && !isSpent()}>
        <p class="bearer-hint">
          Not verified with its service yet - refresh to enable melt, split and
          transfer.
        </p>
      </Show>
      <Show when={isSpent() && !confirmUnspend()}>
        <p class="bearer-hint">
          Locked as spent - refresh, melt, split and transfer are disabled so
          this copy can't be reused by accident.
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
          {isSpent()
            ? "Clear this spent note from the wallet? If it turns out it wasn't actually spent, the sats are gone unless you saved the note elsewhere."
            : 'Remove this note from the wallet? Without a backup (or the note saved elsewhere) the sats behind it are gone.'}
        </p>
        <div class="btns">
          <button
            onClick={() => {
              removeBearer(props.bearer.id)
              notify(
                isSpent() ? 'Spent note cleared.' : 'Note removed.',
                NotifyKind.SUCCESS
              )
            }}
          >
            {isSpent() ? 'Clear' : 'Remove'}
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
            <button disabled={busy()} onClick={melt}>
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
            <button disabled={busy()} onClick={split}>
              <Show when={busy()}>
                <IoRefreshSharp class="spin" />
                &nbsp;
              </Show>
              Split
            </button>
          </div>
        </div>
      </Show>
      <Show when={action() === 'transfer'}>
        <div class="form-item">
          <p class="bearer-hint">
            Transfer rotates the bearer secret on the service: you get a fresh
            note to hand over, and every old copy (including a stolen backup) is
            burned.
          </p>
          <div class="btns">
            <button disabled={busy()} onClick={transfer}>
              <Show when={busy()}>
                <IoRefreshSharp class="spin" />
                &nbsp;
              </Show>
              Rotate &amp; get handover note
            </button>
          </div>
        </div>
      </Show>
      <p class="bearer-dates">
        {toLud17w(props.bearer.url).split('?')[0]}
        <br />
        updated {formatDate(props.bearer.updatedAt)}
      </p>
    </figure>
  )
}
export default BearerCard
