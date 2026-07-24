import type {Component} from 'solid-js'
import {Show, createSignal} from 'solid-js'

import {useWallet} from '../WalletContext'
import {
  mintCash,
  resolveCashInput,
  fetchCashStatus
} from '../lnurlcash'
import {
  notify,
  NotifyKind,
  satsToMsat,
  copyToClipboard
} from '../helpers'
import Qr from '../components/Qr'
import RequireWallet from '../components/RequireWallet'

const Mint: Component = () => {
  const {addBearer, updateBearer} = useWallet()
  const [server, setServer] = createSignal('')
  const [amountSats, setAmountSats] = createSignal('')
  const [busy, setBusy] = createSignal(false)
  const [invoice, setInvoice] = createSignal<string | null>(null)
  const [mintedId, setMintedId] = createSignal<string | null>(null)
  const [mintedUrl, setMintedUrl] = createSignal<string | null>(null)
  const [settled, setSettled] = createSignal(false)

  const mint = async () => {
    const msat = satsToMsat(amountSats())
    if (!server().trim()) {
      notify('Enter an LNURLcash server.', NotifyKind.ERROR)
      return
    }
    if (!amountSats() || !Number.isFinite(msat) || msat <= 0) {
      notify('Enter an amount in sats.', NotifyKind.ERROR)
      return
    }
    setBusy(true)
    try {
      const {token, pr} = await mintCash(server().trim(), msat)
      const url = resolveCashInput(token)
      if (!url) throw new Error('Server returned an unusable token.')
      // stored right away (pending) so the token can't get lost even if this
      // tab closes before the invoice is paid
      const bearer = await addBearer(url, msat, true)
      setMintedId(bearer.id)
      setMintedUrl(url)
      setInvoice(pr)
      setSettled(false)
      notify(
        'Token minted and stored (pending) - pay the invoice to activate it.',
        NotifyKind.SUCCESS
      )
    } catch (err) {
      notify((err as Error).message, NotifyKind.ERROR)
    } finally {
      setBusy(false)
    }
  }

  const checkPaid = async () => {
    const url = mintedUrl()
    const id = mintedId()
    if (!url || !id) return
    setBusy(true)
    try {
      const status = await fetchCashStatus(url)
      await updateBearer(id, {
        amount: status.amount,
        pending: status.pending === true
      })
      if (status.pending) {
        notify('Still pending - invoice not paid yet.', NotifyKind.LOADING)
      } else {
        setSettled(true)
        notify('Invoice paid - your LNURLcash is active!', NotifyKind.SUCCESS)
      }
    } catch (err) {
      notify((err as Error).message, NotifyKind.ERROR)
    } finally {
      setBusy(false)
    }
  }

  return (
    <RequireWallet>
      <div id="mint" class="page">
        <h2>Mint LNURLcash</h2>
        <figure class="setup-card">
          <label>LNURLcash server</label>
          <input
            type="text"
            placeholder="cash.example.com"
            value={server()}
            onInput={e => setServer(e.currentTarget.value)}
          />
          <label>Amount (sats)</label>
          <input
            type="number"
            min="1"
            placeholder="amount in sats"
            value={amountSats()}
            onInput={e => setAmountSats(e.currentTarget.value)}
          />
          <div class="btns">
            <button disabled={busy()} onClick={mint}>
              Mint
            </button>
          </div>
        </figure>
        <Show when={invoice()}>
          <figure class="setup-card">
            <Show
              when={!settled()}
              fallback={
                <p>
                  Paid! The bearer is active and waiting in your wallet.
                </p>
              }
            >
              <figcaption>
                Pay this invoice to activate your new bearer
              </figcaption>
              <Qr value={invoice()!.toUpperCase()} />
              <div class="btns">
                <button onClick={() => copyToClipboard(invoice()!)}>
                  Copy invoice
                </button>
                <button disabled={busy()} onClick={checkPaid}>
                  Check payment
                </button>
              </div>
            </Show>
          </figure>
        </Show>
      </div>
    </RequireWallet>
  )
}
export default Mint
