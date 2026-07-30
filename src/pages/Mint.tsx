import type {Component} from 'solid-js'
import {Show, createSignal} from 'solid-js'
import {useNavigate} from '@solidjs/router'

import {useWallet} from '../WalletContext'
import type {PayRequestInfo} from '../lnurlcash'
import {
  resolveMintInput,
  fetchPayRequest,
  requestInvoice,
  buildNoteUrl,
  withNewK1,
  fetchNoteInfo,
  rotateNote,
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

type Mode = 'invoice' | 'preimage'

// LUD-XX minting: pay a payRequest that advertises `withdrawLink` - the
// payment preimage IS the bearer secret. This wallet has no node of its
// own, so the invoice is paid externally and the preimage (which every
// Lightning wallet reveals after a successful payment) is claimed here -
// either freshly requested from this page, or already in hand from a
// payment made some other way (the mint's own site, a different wallet).
const Mint: Component = () => {
  const {addBearer} = useWallet()
  const navigate = useNavigate()
  const [mintInput, setMintInput] = createSignal('')
  const [payRequest, setPayRequest] = createSignal<PayRequestInfo | null>(null)
  const [mode, setMode] = createSignal<Mode>('invoice')
  const [amountSats, setAmountSats] = createSignal('')
  const [invoice, setInvoice] = createSignal<string | null>(null)
  const [invoicedMsat, setInvoicedMsat] = createSignal(0)
  const [preimage, setPreimage] = createSignal('')
  const [directPreimage, setDirectPreimage] = createSignal('')
  const [busy, setBusy] = createSignal(false)

  const lookup = async () => {
    const url = resolveMintInput(mintInput())
    if (!url) {
      notify('Enter a mint LNURL or Lightning Address.', NotifyKind.ERROR)
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
      setMode('invoice')
      setInvoice(null)
      setPreimage('')
      setDirectPreimage('')
    } catch (err) {
      notify((err as Error).message, NotifyKind.ERROR)
    } finally {
      setBusy(false)
    }
  }

  // validates amountSats() against payRequest's bounds, shared by both the
  // "request an invoice" and "I already paid" paths
  const parseAmount = (info: PayRequestInfo): number | null => {
    const msat = satsToMsat(amountSats())
    if (!amountSats() || !Number.isFinite(msat) || msat <= 0) {
      notify('Enter an amount in sats.', NotifyKind.ERROR)
      return null
    }
    if (msat < info.minSendable || msat > info.maxSendable) {
      notify(
        `Amount must be between ${msatToSats(info.minSendable)} and ${msatToSats(info.maxSendable)} sats.`,
        NotifyKind.ERROR
      )
      return null
    }
    return msat
  }

  const getInvoice = async () => {
    const info = payRequest()
    if (!info) return
    const msat = parseAmount(info)
    if (msat === null) return
    setBusy(true)
    try {
      setInvoice(await requestInvoice(info.callback, msat))
      setInvoicedMsat(msat)
    } catch (err) {
      notify((err as Error).message, NotifyKind.ERROR)
    } finally {
      setBusy(false)
    }
  }

  const claim = async (preimageValue: string, amountMsat: number) => {
    const info = payRequest()
    if (!info?.withdrawLink) return
    if (!isPreimage(preimageValue)) {
      notify('The preimage is 64 hex characters.', NotifyKind.ERROR)
      return
    }
    setBusy(true)
    try {
      // declare the invoiced amount (a claim - not yet confirmed) so the
      // note is self-describing even before the verifying GET below
      const declaredUrl = buildNoteUrl(
        info.withdrawLink,
        preimageValue,
        amountMsat
      )
      // verify with the service - this settles a freshly paid invoice on
      // exactly this k1, and its maxWithdrawable is the authoritative value
      const noteInfo = await fetchNoteInfo(declaredUrl)
      const mintPubkey = noteInfo.mintPubkey
      let url = withNewK1(declaredUrl, noteInfo.k1, noteInfo.maxWithdrawable)
      // that informational GET just put the preimage on the wire (server
      // logs, proxies, browser history) - per spec, a WALLET intending to
      // keep holding the note SHOULD rotate any k1 it has transmitted but
      // not burned. This also opportunistically obtains the note's first
      // offline-verifiable signature, same as the minting diagram's "obtain
      // signed note" step.
      try {
        const rotated = await rotateNote(noteInfo.callback, noteInfo.k1)
        url = withNewK1(
          declaredUrl,
          rotated.k1,
          noteInfo.maxWithdrawable,
          rotated.signature
        )
      } catch {
        notify(
          'Service does not support rotation - the preimage was just transmitted, treat this note as exposed.',
          NotifyKind.ERROR
        )
      }
      await addBearer({
        url,
        callback: noteInfo.callback,
        amount: noteInfo.maxWithdrawable,
        verified: true,
        mintPubkey
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

  // no amount needed here - unlike requesting a fresh invoice, the note's
  // real value comes from the service's own verification inside claim(),
  // which always overwrites this placeholder with the authoritative
  // maxWithdrawable before the bearer is ever stored
  const claimDirect = () => claim(directPreimage(), 0)

  return (
    <RequireWallet>
      <div id="mint" class="page">
        <h2>Mint a bearer note</h2>
        <figure class="setup-card">
          <label>Mint (LNURL or Lightning Address)</label>
          <input
            type="text"
            placeholder="lnurl1... or mint@example.com"
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
              <div class="tabs">
                <button
                  classList={{active: mode() === 'invoice'}}
                  onClick={() => {
                    setMode('invoice')
                    setDirectPreimage('')
                  }}
                >
                  Create new invoice
                </button>
                <button
                  classList={{active: mode() === 'preimage'}}
                  onClick={() => {
                    setMode('preimage')
                    setInvoice(null)
                    setPreimage('')
                  }}
                >
                  I already have a preimage
                </button>
              </div>
              <Show
                when={mode() === 'preimage'}
                fallback={
                  <>
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
                  </>
                }
              >
                <label>
                  Payment preimage - from paying this mint's invoice some other
                  way (its own site, a different wallet); its value comes
                  straight from the mint, no need to enter an amount
                </label>
                <input
                  type="text"
                  placeholder="payment preimage (64 hex characters)"
                  value={directPreimage()}
                  onInput={e => setDirectPreimage(e.currentTarget.value)}
                />
                <div class="btns">
                  <button
                    disabled={busy() || !isPreimage(directPreimage())}
                    onClick={claimDirect}
                  >
                    Claim note
                  </button>
                </div>
              </Show>
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
                onClick={() => claim(preimage(), invoicedMsat())}
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
