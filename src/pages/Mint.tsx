import type {Component} from 'solid-js'
import {Show, For, createSignal, createEffect, onCleanup} from 'solid-js'
import {useNavigate} from '@solidjs/router'
import {
  IoRefreshSharp,
  IoClipboardSharp,
  IoCloseSharp,
  IoReturnDownForwardSharp,
  IoOpenSharp,
  IoGlobeSharp
} from 'solid-icons/io'

import {useWallet} from '../WalletContext'
import type {PayRequestInfo} from '../lnurlcash'
import {
  resolveMintInput,
  fetchPayRequest,
  requestInvoice,
  fetchInvoiceVerification,
  buildNoteUrl,
  withNewK1,
  fetchNoteInfo,
  rotateNote,
  serverOf,
  isPreimage
} from '../lnurlcash'
import {
  notify,
  NotifyKind,
  msatToSats,
  satsToMsat,
  copyToClipboard,
  pasteFromClipboard,
  mempoolNodeUrl
} from '../helpers'
import {
  isMintTrusted,
  addTrustedMint,
  trustedMints,
  PUBLIC_MINTS
} from '../trustedMints'
import {offlineMode} from '../offlineMode'
import Qr from '../components/Qr'
import ScanToggle from '../components/ScanToggle'
import RequireWallet from '../components/RequireWallet'

type Mode = 'invoice' | 'preimage'

// LUD-21 auto-poll interval, in seconds - both the countdown shown on the
// button and the cadence of the automatic check
const VERIFY_POLL_SECONDS = 10

// trustedMints only stores a bare hostname (see trustedMints.ts) - there's
// no record of *how* it was originally reached, so re-selecting one guesses
// the same mint@<host> Lightning Address convention this wallet's own
// reference mint (lnurl-mint) defaults to. A reasonable quick-fill, not a
// guarantee: if a given mint uses a different username, the lookup below
// just fails normally and the holder can type the real address by hand.
const guessMintAddress = (server: string): string => `mint@${server}`

// LUD-XX minting: pay a payRequest that advertises `withdrawLink` - the
// payment preimage IS the bearer secret. This wallet has no node of its
// own, so the invoice is paid externally and the preimage (which every
// Lightning wallet reveals after a successful payment) is claimed here -
// either freshly requested from this page, or already in hand from a
// payment made some other way (the mint's own site, a different wallet).
const Mint: Component = () => {
  const {addBearer} = useWallet()
  const navigate = useNavigate()

  // minting is nothing but service calls end to end (look up, get invoice,
  // verify, claim) - there's no useful offline state for this page to sit
  // in, so it's hidden from the nav (see Nav.tsx) and bounced straight back
  // if reached anyway (a stale link, or the toggle flipped on while here)
  createEffect(() => {
    if (offlineMode()) navigate('/wallet')
  })

  const [mintInput, setMintInput] = createSignal('')
  const [payRequest, setPayRequest] = createSignal<PayRequestInfo | null>(null)
  const [mode, setMode] = createSignal<Mode>('invoice')
  const [amountSats, setAmountSats] = createSignal('')
  const [invoice, setInvoice] = createSignal<string | null>(null)
  const [invoicedMsat, setInvoicedMsat] = createSignal(0)
  const [preimage, setPreimage] = createSignal('')
  const [directPreimage, setDirectPreimage] = createSignal('')
  const [busy, setBusy] = createSignal(false)

  // set when a lookup discovers a mintPubkey for a server this wallet has
  // never seen before - the lookup pauses here until the holder trusts it
  // or cancels (see trustedMints.ts: this is the one path that asks -
  // everywhere else, holding a bearer from a mint trusts it automatically)
  const [pendingTrust, setPendingTrust] = createSignal<{
    server: string
    mintPubkey: string
    info: PayRequestInfo
  } | null>(null)

  // LUD-21: only present when the invoice's own callback response
  // advertised a verify URL - the whole check-automatically UI is optional
  // on that, per-mint
  const [verifyUrl, setVerifyUrl] = createSignal<string | null>(null)
  const [secondsLeft, setSecondsLeft] = createSignal(VERIFY_POLL_SECONDS)
  const [verifying, setVerifying] = createSignal(false)
  let pollTimer: ReturnType<typeof setInterval> | null = null

  const stopPolling = () => {
    if (pollTimer) clearInterval(pollTimer)
    pollTimer = null
  }

  const checkVerify = async () => {
    const url = verifyUrl()
    if (!url || verifying()) return
    setVerifying(true)
    try {
      const result = await fetchInvoiceVerification(url)
      if (result.settled) {
        stopPolling()
        if (result.preimage && isPreimage(result.preimage)) {
          // pre-fill the manual input too, so a failed auto-claim still
          // leaves the holder one click away from retrying by hand
          setPreimage(result.preimage)
          notify(
            'Payment settled - claiming automatically...',
            NotifyKind.LOADING
          )
          await claim(result.preimage, invoicedMsat())
        } else {
          notify(
            'Payment settled - paste the preimage your wallet revealed to claim the note.',
            NotifyKind.SUCCESS
          )
        }
      }
    } catch {
      // a single failed check isn't fatal - the next tick tries again
    } finally {
      setVerifying(false)
    }
  }

  const startPolling = (url: string) => {
    stopPolling()
    setVerifyUrl(url)
    setSecondsLeft(VERIFY_POLL_SECONDS)
    pollTimer = setInterval(() => {
      setSecondsLeft(s => {
        if (s <= 1) {
          checkVerify()
          return VERIFY_POLL_SECONDS
        }
        return s - 1
      })
    }, 1000)
  }

  // manual click: check right away, then restart the countdown so the next
  // automatic tick isn't immediately on its heels
  const manualCheck = () => {
    checkVerify()
    const url = verifyUrl()
    if (url) startPolling(url)
  }

  onCleanup(stopPolling)

  const proceedWithPayRequest = (info: PayRequestInfo) => {
    setPayRequest(info)
    setMode('invoice')
    setInvoice(null)
    setPreimage('')
    setDirectPreimage('')
    stopPolling()
    setVerifyUrl(null)
  }

  const lookup = async () => {
    const url = resolveMintInput(mintInput())
    if (!url) {
      notify('Enter a mint LNURL or Lightning Address.', NotifyKind.ERROR)
      return
    }
    setPendingTrust(null)
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
      const server = serverOf(url)
      // first time seeing this server's signing key - pause for a decision
      // instead of trusting it silently (a mint with no mintPubkey at all
      // just isn't offline-verifiable, nothing to trust or ask about)
      if (info.mintPubkey && !isMintTrusted(server)) {
        setPendingTrust({server, mintPubkey: info.mintPubkey, info})
        return
      }
      proceedWithPayRequest(info)
    } catch (err) {
      notify((err as Error).message, NotifyKind.ERROR)
    } finally {
      setBusy(false)
    }
  }

  // click-to-select from either list below: fills the input and looks it
  // up immediately, same as typing it in and pressing enter - also what a
  // scanned or pasted mint address goes through
  const selectMint = (address: string) => {
    setMintInput(address)
    lookup()
  }

  const pasteMint = async () => {
    const text = await pasteFromClipboard()
    if (text !== null) selectMint(text)
  }

  const confirmTrust = () => {
    const pending = pendingTrust()
    if (!pending) return
    addTrustedMint(pending.server, pending.mintPubkey)
    setPendingTrust(null)
    proceedWithPayRequest(pending.info)
  }

  const cancelTrust = () => {
    setPendingTrust(null)
    notify('Mint not trusted - lookup cancelled.', NotifyKind.ERROR)
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
      const result = await requestInvoice(info.callback, msat)
      setInvoice(result.pr)
      setInvoicedMsat(msat)
      if (result.verify) startPolling(result.verify)
    } catch (err) {
      notify((err as Error).message, NotifyKind.ERROR)
    } finally {
      setBusy(false)
    }
  }

  // shared by the manual "Claim note" buttons and checkVerify's automatic
  // claim once LUD-21 verify returns a preimage - rotates unconditionally
  // right after verifying, in both cases, no separate confirmation step
  const claim = async (preimageValue: string, amountMsat?: number) => {
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
      navigate('/wallet')
    } catch (err) {
      notify((err as Error).message, NotifyKind.ERROR)
    } finally {
      setBusy(false)
    }
  }

  // no amount needed here - unlike requesting a fresh invoice, the note's
  // real value comes from the service's own verification inside claim(),
  // which always sets the authoritative maxWithdrawable before the bearer
  // is ever stored
  const claimDirect = () => claim(directPreimage())

  return (
    <RequireWallet>
      <div id="mint" class="page">
        <h2>Mint a bearer note</h2>
        <figure class="paste-widget">
          <label>Mint (LNURL or Lightning Address)</label>
          <div class="paste-input-row">
            <ScanToggle
              onScan={selectMint}
              accept={v => resolveMintInput(v) !== null}
            />
            <button
              type="button"
              class="icon-btn paste-icon-btn"
              title="Paste from clipboard"
              onClick={pasteMint}
            >
              <IoClipboardSharp />
            </button>
            <div class="paste-input-wrapper">
              <input
                type="text"
                class="paste-input"
                placeholder="lnurl1... or mint@example.com"
                value={mintInput()}
                onInput={e => setMintInput(e.currentTarget.value)}
                onKeyDown={e => e.key === 'Enter' && lookup()}
              />
              <Show when={mintInput() !== ''}>
                <button
                  type="button"
                  class="icon-btn paste-clear-btn"
                  title="Clear"
                  onClick={() => setMintInput('')}
                >
                  <IoCloseSharp />
                </button>
              </Show>
            </div>
            <button
              type="button"
              class="icon-btn paste-confirm-btn"
              title={offlineMode() ? 'Offline mode is on' : 'Look up mint'}
              disabled={busy() || mintInput() === '' || offlineMode()}
              onClick={lookup}
            >
              <Show when={busy()} fallback={<IoReturnDownForwardSharp />}>
                <IoRefreshSharp class="spin" />
              </Show>
            </button>
          </div>
        </figure>
        <Show when={trustedMints().length > 0}>
          <figure class="setup-card">
            <h4>Your trusted mints</h4>
            <div class="mint-picker">
              <For each={trustedMints()}>
                {mint => (
                  <button
                    disabled={busy() || offlineMode()}
                    onClick={() => selectMint(guessMintAddress(mint.server))}
                  >
                    {mint.server}
                  </button>
                )}
              </For>
            </div>
          </figure>
        </Show>
        <figure class="setup-card">
          <h4>Public mints</h4>
          <div class="mint-picker">
            <For each={PUBLIC_MINTS}>
              {address => (
                <button
                  disabled={busy() || offlineMode()}
                  onClick={() => selectMint(address)}
                >
                  {address}
                </button>
              )}
            </For>
          </div>
        </figure>
        <Show when={pendingTrust()}>
          {pending => (
            <figure class="setup-card">
              <h4>Trust this mint?</h4>
              <p>
                First time seeing a signing key from{' '}
                <strong>{pending().server}</strong>. Trusting it lets its notes
                show as offline-verified against this key - you can remove the
                trust later, unless you end up holding a note from it.
              </p>
              <pre>{pending().mintPubkey}</pre>
              <div class="btns">
                <button onClick={confirmTrust}>Trust this mint</button>
                <button onClick={cancelTrust}>Cancel</button>
                <a
                  class="icon-btn"
                  title="Open this mint"
                  href={`https://${pending().server}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  <IoGlobeSharp />
                </a>
                <a
                  class="icon-btn"
                  title="Look up this Lightning node on mempool.space"
                  href={mempoolNodeUrl(pending().mintPubkey)}
                  target="_blank"
                  rel="noreferrer"
                >
                  <IoOpenSharp />
                </a>
              </div>
            </figure>
          )}
        </Show>
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
                      <button
                        disabled={busy() || offlineMode()}
                        onClick={getInvoice}
                      >
                        <Show when={busy()}>
                          <IoRefreshSharp class="spin" />
                          &nbsp;
                        </Show>
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
                    disabled={
                      busy() || !isPreimage(directPreimage()) || offlineMode()
                    }
                    onClick={claimDirect}
                  >
                    <Show when={busy()}>
                      <IoRefreshSharp class="spin" />
                      &nbsp;
                    </Show>
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
            <Qr
              value={invoice()!.toUpperCase()}
              href={`lightning:${invoice()!.toUpperCase()}`}
            />
            <div class="btns">
              <button onClick={() => copyToClipboard(invoice()!)}>
                Copy invoice
              </button>
              <Show when={verifyUrl()}>
                <button
                  disabled={verifying() || offlineMode()}
                  onClick={manualCheck}
                >
                  <Show when={verifying()}>
                    <IoRefreshSharp class="spin" />
                    &nbsp;
                  </Show>
                  {verifying()
                    ? 'Checking...'
                    : `Check payment (${secondsLeft()}s)`}
                </button>
              </Show>
            </div>
            <label>
              2. Paste the payment preimage your wallet reveals after paying -
              it IS the bearer secret
              <Show when={verifyUrl()}>
                {' '}
                (or wait - this mint supports checking automatically)
              </Show>
            </label>
            <input
              type="text"
              placeholder="payment preimage (64 hex characters)"
              value={preimage()}
              onInput={e => setPreimage(e.currentTarget.value)}
            />
            <div class="btns">
              <button
                disabled={busy() || !isPreimage(preimage()) || offlineMode()}
                onClick={() => claim(preimage(), invoicedMsat())}
              >
                <Show when={busy()}>
                  <IoRefreshSharp class="spin" />
                  &nbsp;
                </Show>
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
