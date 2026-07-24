import type {Component} from 'solid-js'
import {Show, createSignal} from 'solid-js'
import {useNavigate} from '@solidjs/router'

import {useWallet} from '../WalletContext'
import type {PayRequestInfo} from '../lnurlcash'
import {
  resolveLnurlInput,
  fetchPayRequest,
  requestInvoice,
  buildNoteUrl,
  noteIdUrl,
  fetchNoteInfo,
  isPreimage
} from '../lnurlcash'
import {
  notify,
  NotifyKind,
  msatToSats,
  satsToMsat,
  copyToClipboard
} from '../helpers'
import Qr from '../components/Qr'
import RequireWallet from '../components/RequireWallet'

// LUD-XX minting: pay a payRequest that advertises `withdrawLink` - the
// payment preimage IS the bearer secret. This wallet has no node of its
// own, so the invoice is paid externally and the preimage (which every
// Lightning wallet reveals after a successful payment) is pasted back in.
const Mint: Component = () => {
  const {addBearer} = useWallet()
  const navigate = useNavigate()
  const [mintInput, setMintInput] = createSignal('')
  const [payRequest, setPayRequest] = createSignal<PayRequestInfo | null>(null)
  const [amountSats, setAmountSats] = createSignal('')
  const [invoice, setInvoice] = createSignal<string | null>(null)
  const [preimage, setPreimage] = createSignal('')
  const [busy, setBusy] = createSignal(false)

  // bech32 LNURL, Lightning Address, lnurlp:// or plain URL - a bare host
  // is completed to https://<host>/pay, the lnurl-mint layout
  const resolveMint = (): string | null => {
    const trimmed = mintInput().trim()
    if (!trimmed) return null
    const resolved = resolveLnurlInput(trimmed)
    if (resolved) return resolved
    if (/^[a-z0-9.-]+(:\d+)?$/i.test(trimmed)) {
      return `https://${trimmed}/pay`
    }
    return null
  }

  const lookup = async () => {
    const url = resolveMint()
    if (!url) {
      notify('Enter a mint LNURL, address or host.', NotifyKind.ERROR)
      return
    }
    setBusy(true)
    try {
      const info = await fetchPayRequest(url)
      if (!info.withdrawLink) {
        notify(
          'This payRequest does not advertise lnurlcash minting (no withdrawLink).',
          NotifyKind.ERROR
        )
        return
      }
      setPayRequest(info)
      setInvoice(null)
      setPreimage('')
    } catch (err) {
      notify((err as Error).message, NotifyKind.ERROR)
    } finally {
      setBusy(false)
    }
  }

  const getInvoice = async () => {
    const info = payRequest()
    if (!info) return
    const msat = satsToMsat(amountSats())
    if (!amountSats() || !Number.isFinite(msat) || msat <= 0) {
      notify('Enter an amount in sats.', NotifyKind.ERROR)
      return
    }
    if (msat < info.minSendable || msat > info.maxSendable) {
      notify(
        `Amount must be between ${msatToSats(info.minSendable)} and ${msatToSats(info.maxSendable)} sats.`,
        NotifyKind.ERROR
      )
      return
    }
    setBusy(true)
    try {
      setInvoice(await requestInvoice(info.callback, msat))
    } catch (err) {
      notify((err as Error).message, NotifyKind.ERROR)
    } finally {
      setBusy(false)
    }
  }

  const claim = async () => {
    const info = payRequest()
    if (!info?.withdrawLink) return
    if (!isPreimage(preimage())) {
      notify('The preimage is 64 hex characters.', NotifyKind.ERROR)
      return
    }
    setBusy(true)
    try {
      const url = buildNoteUrl(info.withdrawLink, preimage())
      // verify via the hash lookup - the secret never goes on the wire, and
      // the mint settles a freshly paid invoice on exactly this request
      const idUrl = noteIdUrl(url)
      const noteInfo = await fetchNoteInfo(idUrl!)
      await addBearer({
        url,
        callback: noteInfo.callback,
        amount: noteInfo.maxWithdrawable,
        verified: true
      })
      notify(
        `Minted a bearer note of ${msatToSats(noteInfo.maxWithdrawable)} sats.`,
        NotifyKind.SUCCESS
      )
      navigate('/')
    } catch (err) {
      notify((err as Error).message, NotifyKind.ERROR)
    } finally {
      setBusy(false)
    }
  }

  return (
    <RequireWallet>
      <div id="mint" class="page">
        <h2>Mint a bearer note</h2>
        <figure class="setup-card">
          <label>Mint (LNURL, Lightning Address or host)</label>
          <input
            type="text"
            placeholder="lnurl1... / mint@example.com / mint.example.com"
            value={mintInput()}
            onInput={e => setMintInput(e.currentTarget.value)}
            onKeyDown={e => e.key === 'Enter' && lookup()}
          />
          <div class="btns">
            <button disabled={busy()} onClick={lookup}>
              Look up mint
            </button>
          </div>
        </figure>
        <Show when={payRequest()}>
          {info => (
            <figure class="setup-card">
              <label>
                Amount (sats, {msatToSats(info().minSendable)} -{' '}
                {msatToSats(info().maxSendable)})
              </label>
              <input
                type="number"
                min="1"
                placeholder="amount in sats"
                value={amountSats()}
                onInput={e => setAmountSats(e.currentTarget.value)}
              />
              <div class="btns">
                <button disabled={busy()} onClick={getInvoice}>
                  Get invoice
                </button>
              </div>
            </figure>
          )}
        </Show>
        <Show when={invoice()}>
          <figure class="setup-card">
            <figcaption>
              1. Pay this invoice with any Lightning wallet
            </figcaption>
            <Qr value={invoice()!.toUpperCase()} />
            <div class="btns">
              <button onClick={() => copyToClipboard(invoice()!)}>
                Copy invoice
              </button>
            </div>
            <label>
              2. Paste the payment preimage your wallet reveals after paying -
              it IS the bearer secret
            </label>
            <input
              type="text"
              placeholder="payment preimage (64 hex characters)"
              value={preimage()}
              onInput={e => setPreimage(e.currentTarget.value)}
            />
            <div class="btns">
              <button
                disabled={busy() || !isPreimage(preimage())}
                onClick={claim}
              >
                Claim note
              </button>
            </div>
          </figure>
        </Show>
      </div>
    </RequireWallet>
  )
}
export default Mint
