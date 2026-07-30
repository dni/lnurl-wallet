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
  IoShieldCheckmarkSharp
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

  const token = () => toBech32Lnurl(props.bearer.url)
  const k1 = () => noteK1(props.bearer.url) || ''
  const hasCallback = () => props.bearer.callback !== ''

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
      removeBearer(props.bearer.id)
      notify('Melted - the note has been paid out.', NotifyKind.SUCCESS)
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

  return (
    <figure class="bearer-card">
      <div class="bearer-head">
        <label class="bearer-select" title="Select for combine">
          <input
            type="checkbox"
            checked={props.selected}
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
              removeBearer(props.bearer.id)
              notify('Note handed over and removed.', NotifyKind.SUCCESS)
            }}
          >
            Handed over - remove
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
          disabled={busy()}
          onClick={refresh}
        >
          <IoRefreshSharp />
        </button>
        <div class="bearer-actions">
          <button
            class="icon-btn"
            title="Melt - have the service pay a bolt11 invoice of exactly this note's value"
            disabled={!hasCallback()}
            onClick={() => setAction(action() === 'melt' ? null : 'melt')}
          >
            <IoFlameSharp />
          </button>
          <button
            class="icon-btn"
            title="Split into two notes"
            disabled={!hasCallback()}
            onClick={() => setAction(action() === 'split' ? null : 'split')}
          >
            <IoGitBranchSharp />
          </button>
          <button
            class="icon-btn"
            title="Transfer - rotate the secret and hand the fresh note over"
            disabled={!hasCallback()}
            onClick={() =>
              setAction(action() === 'transfer' ? null : 'transfer')
            }
          >
            <IoSwapHorizontalSharp />
          </button>
          <button
            class="icon-btn"
            title="Remove from wallet"
            onClick={() => setConfirmDelete(true)}
          >
            <IoTrashSharp />
          </button>
        </div>
      </div>
      <Show when={!hasCallback()}>
        <p class="bearer-hint">
          Not verified with its service yet - refresh to enable melt, split and
          transfer.
        </p>
      </Show>
      <Show when={confirmDelete()}>
        <p class="warning">
          Remove this note from the wallet? Without a backup (or the note saved
          elsewhere) the sats behind it are gone.
        </p>
        <div class="btns">
          <button
            onClick={() => {
              removeBearer(props.bearer.id)
              notify('Note removed.', NotifyKind.SUCCESS)
            }}
          >
            Remove
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
