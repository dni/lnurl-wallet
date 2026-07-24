import type {Component} from 'solid-js'
import {Show, createSignal} from 'solid-js'
import {
  IoCopySharp,
  IoEyeSharp,
  IoEyeOffSharp,
  IoRefreshSharp,
  IoFlameSharp,
  IoGitBranchSharp,
  IoSwapHorizontalSharp,
  IoTrashSharp
} from 'solid-icons/io'

import type {Bearer} from '../storage'
import {useWallet} from '../WalletContext'
import {
  encodeCashToken,
  resolveCashInput,
  serverOf,
  fetchCashStatus,
  meltCash,
  splitCash,
  transferCash
} from '../lnurlcash'
import {
  copyToClipboard,
  msatToSats,
  satsToMsat,
  formatDate,
  notify,
  NotifyKind
} from '../helpers'
import Qr from './Qr'

type Action = 'melt' | 'split' | 'transfer' | null

export type BearerCardProps = {
  bearer: Bearer
  selected: boolean
  onSelect: (selected: boolean) => void
}

const BearerCard: Component<BearerCardProps> = props => {
  const {updateBearer, removeBearer, addBearer} = useWallet()
  // the QR is the bearer secret itself - keep it behind an overlay until
  // deliberately revealed, like lnurl_server's hideable QRs
  const [showQr, setShowQr] = createSignal(false)
  const [action, setAction] = createSignal<Action>(null)
  const [busy, setBusy] = createSignal(false)
  const [meltPr, setMeltPr] = createSignal('')
  const [splitSats, setSplitSats] = createSignal('')
  // set once a transfer rotated the secret - the new token to hand over
  const [handover, setHandover] = createSignal<string | null>(null)
  const [confirmDelete, setConfirmDelete] = createSignal(false)

  const token = () => encodeCashToken(props.bearer.url)

  const refresh = async () => {
    setBusy(true)
    try {
      const status = await fetchCashStatus(props.bearer.url)
      await updateBearer(props.bearer.id, {
        amount: status.amount,
        pending: status.pending === true
      })
      notify('Bearer refreshed.', NotifyKind.SUCCESS)
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
      await meltCash(props.bearer.url, meltPr())
      removeBearer(props.bearer.id)
      notify('Melted - the bearer has been paid out.', NotifyKind.SUCCESS)
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
      notify('Split amount must be below the bearer amount.', NotifyKind.ERROR)
      return
    }
    setBusy(true)
    try {
      const tokens = await splitCash(props.bearer.url, msat)
      // both returned tokens are fresh - the original secret is dead, so
      // replace this bearer with the two new ones
      removeBearer(props.bearer.id)
      for (const newToken of tokens) {
        const url = resolveCashInput(newToken)
        if (url) {
          const status = await fetchCashStatus(url).catch(() => null)
          await addBearer(url, status?.amount ?? 0, status?.pending === true)
        }
      }
      notify('Split into two bearers.', NotifyKind.SUCCESS)
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
      const newToken = await transferCash(props.bearer.url)
      const url = resolveCashInput(newToken)
      if (!url) throw new Error('Server returned an unusable token.')
      // the old secret is invalid the moment the server rotates it - keep
      // the fresh token stored until the holder confirms the handover
      await updateBearer(props.bearer.id, {url})
      setHandover(newToken.toUpperCase())
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
          <Show when={props.bearer.pending}>
            <span class="bearer-pending">pending</span>
          </Show>
          <span class="bearer-server">{serverOf(props.bearer.url)}</span>
        </div>
      </div>
      <div class="qr-wrapper">
        <Qr value={handover() ?? token()} />
        <Show when={!showQr()}>
          <button
            class="qr-overlay"
            title="Show QR code - it IS the bearer, anyone who scans it can spend it"
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
          Secret rotated - this QR is the new bearer. Hand it to the recipient;
          your old copy is already invalid.
        </p>
        <div class="btns">
          <button
            onClick={() => {
              removeBearer(props.bearer.id)
              notify('Bearer handed over and removed.', NotifyKind.SUCCESS)
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
          title="Copy token"
          onClick={() => copyToClipboard(handover() ?? token())}
        >
          <IoCopySharp />
        </button>
        <button
          class="icon-btn"
          title="Refresh amount from server"
          disabled={busy()}
          onClick={refresh}
        >
          <IoRefreshSharp />
        </button>
        <div class="bearer-actions">
          <button
            class="icon-btn"
            title="Melt - pay a bolt11 invoice with this bearer"
            onClick={() => setAction(action() === 'melt' ? null : 'melt')}
          >
            <IoFlameSharp />
          </button>
          <button
            class="icon-btn"
            title="Split into two bearers"
            onClick={() => setAction(action() === 'split' ? null : 'split')}
          >
            <IoGitBranchSharp />
          </button>
          <button
            class="icon-btn"
            title="Transfer - rotate the secret and hand it over"
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
      <Show when={confirmDelete()}>
        <p class="warning">
          Remove this bearer from the wallet? Without a backup (or the token
          itself saved elsewhere) the funds behind it are gone.
        </p>
        <div class="btns">
          <button
            onClick={() => {
              removeBearer(props.bearer.id)
              notify('Bearer removed.', NotifyKind.SUCCESS)
            }}
          >
            Remove
          </button>
          <button onClick={() => setConfirmDelete(false)}>Cancel</button>
        </div>
      </Show>
      <Show when={action() === 'melt'}>
        <div class="form-item">
          <label>Melt into a bolt11 invoice</label>
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
          <label>
            Split off (sats, of {msatToSats(props.bearer.amount)})
          </label>
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
            Transfer rotates the bearer secret on the server: you get a fresh
            token to hand over, and every old copy (including a stolen backup)
            becomes worthless.
          </p>
          <div class="btns">
            <button disabled={busy()} onClick={transfer}>
              Rotate &amp; get handover token
            </button>
          </div>
        </div>
      </Show>
      <p class="bearer-dates">updated {formatDate(props.bearer.updatedAt)}</p>
    </figure>
  )
}
export default BearerCard
