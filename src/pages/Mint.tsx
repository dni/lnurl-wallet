import type {Component} from 'solid-js'
import {
  Show,
  For,
  createSignal,
  createMemo,
  createEffect,
  onCleanup
} from 'solid-js'
import {useNavigate} from '@solidjs/router'
import {
  IoRefreshSharp,
  IoClipboardSharp,
  IoCloseSharp,
  IoReturnDownForwardSharp,
  IoOpenSharp,
  IoGlobeSharp,
  IoTrashSharp
} from 'solid-icons/io'

import {useWallet} from '../WalletContext'
import {useDevice} from '../DeviceContext'
import type {PayRequestInfo, MintAddressInfo} from '../lnurlcash'
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
  isPreimage,
  applyMintFee,
  grossUpForMintFee,
  describeMintFee,
  mintAddressUrl,
  fetchMintAddress,
  lightningAddressUsername
} from '../lnurlcash'
import {deviceMint} from '../deviceOrchestration'
import {
  notify,
  NotifyKind,
  msatToSats,
  satsToMsat,
  ceilMsatToSat,
  floorMsatToSat,
  copyToClipboard,
  pasteFromClipboard,
  mempoolNodeUrl
} from '../helpers'
import {
  isMintTrusted,
  addTrustedMint,
  cacheTrustedMintNodeInfo,
  getTrustedMintAddress,
  mintAddressCacheInfo,
  trustedMints,
  PUBLIC_MINTS
} from '../trustedMints'
import {
  storeableMints,
  addStoreableMint,
  removeStoreableMint
} from '../storeableLinks'
import {offlineMode} from '../offlineMode'
import Qr from '../components/Qr'
import ScanToggle from '../components/ScanToggle'
import RequireWallet from '../components/RequireWallet'

type Mode = 'invoice' | 'preimage'

// LUD-21 auto-poll interval, in seconds - both the countdown shown on the
// button and the cadence of the automatic check
const VERIFY_POLL_SECONDS = 5

// fallback for a trusted mint with no cached username (see
// trustedMints.ts's TrustedMint.username - e.g. one only ever looked up as
// a bech32 LNURL, or trusted before this wallet learned to remember one) -
// guesses the same mint@<host> Lightning Address convention this wallet's
// own reference mint (lnurl-mint) defaults to. A reasonable quick-fill, not
// a guarantee: if a given mint uses a different username, the lookup below
// just fails normally and the holder can type the real address by hand.
const guessMintAddress = (server: string): string => `mint@${server}`

// the exact address a trusted mint was last reached at when one's cached,
// else the same best-effort guess selectMint has always fallen back to
const mintAddressFor = (server: string): string =>
  getTrustedMintAddress(server) || guessMintAddress(server)

// LUD-25 minting: pay a payRequest that advertises `withdrawLink` - the
// payment preimage IS the bearer secret. This wallet has no node of its
// own, so the invoice is paid externally and the preimage (which every
// Lightning wallet reveals after a successful payment) is claimed here -
// either freshly requested from this page, or already in hand from a
// payment made some other way (the mint's own site, a different wallet).
const Mint: Component = () => {
  const {addBearer, logActivity} = useWallet()
  const {client: deviceClient} = useDevice()
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
  // net note value the holder asked for, and the (possibly grossed-up, see
  // amountBreakdown) gross msat actually invoiced for it - both needed at
  // claim time: the former to catch the service crediting something other
  // than what was expected, the latter to work out the fee actually paid
  const [invoicedMsat, setInvoicedMsat] = createSignal(0)
  const [invoicedGrossMsat, setInvoicedGrossMsat] = createSignal(0)
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
    nodeInfo: MintAddressInfo | null
    username: string | null
  } | null>(null)

  // LUD-25 mint address (experimental, see lnurlcash.ts's mintAddressUrl):
  // best-effort node identity/capacity + mint limits, discovered alongside
  // the payRequest lookup below - purely informational, so a mint without
  // this endpoint just leaves it null and lookup() proceeds unaffected
  const [mintNodeInfo, setMintNodeInfo] = createSignal<MintAddressInfo | null>(
    null
  )

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
          await claim(result.preimage, invoicedMsat(), invoicedGrossMsat())
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
  // automatic tick isn't immediately on its heels. checkVerify's own guard
  // stops a second concurrent verify, but on its own that still lets a
  // rapid double-click (or a click landing right as the automatic tick was
  // about to fire) restart the interval twice in a row - guard here too so
  // the whole "check + restart" action only happens once per click
  const manualCheck = () => {
    if (verifying()) return
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
    setMintNodeInfo(null)
    setBusy(true)
    try {
      // best-effort mint-address discovery (see mintAddressUrl) - derived
      // straight from `url`'s own .well-known/lnurlp/{name} path, not
      // guessed from the raw input text, so it works the same whether
      // mintInput() was typed as a Lightning Address or arrived as a bech32
      // LNURL/scanned URL that resolved to the same convention. Most mints
      // won't have this experimental endpoint at all, so a failure here
      // just falls back to this wallet's own guessed payRequest URL (`url`
      // above); when it does succeed, its own payLink is the authoritative
      // place to fetch the payRequest from instead.
      const addressUrl = mintAddressUrl(url)
      let nodeInfo: MintAddressInfo | null = null
      let payUrl = url
      if (addressUrl) {
        try {
          nodeInfo = await fetchMintAddress(addressUrl)
          setMintNodeInfo(nodeInfo)
          payUrl = nodeInfo.payLink
        } catch {
          // no mint-address support here - proceed with just the guess
        }
      }
      // same .well-known/lnurlp/{name} convention mintAddressUrl looked
      // for, read off whichever payRequest URL is actually about to be
      // fetched (the mint's own payLink when mint-address discovery
      // succeeded, this wallet's own guess otherwise)
      const username = lightningAddressUsername(payUrl)

      const info = await fetchPayRequest(payUrl)
      if (!info.withdrawLink) {
        notify(
          'This payRequest does not advertise lnurlcash minting (no withdrawLink).',
          NotifyKind.ERROR
        )
        return
      }
      const server = serverOf(payUrl)

      // first time seeing this server's signing key - pause for a decision
      // instead of trusting it silently (a mint with no signing key at all
      // just isn't offline-verifiable, nothing to trust or ask about).
      // Prefer the mint-address endpoint's nodePubkey when present - it's
      // available up front, before paying anything, unlike payRequest's own
      // mintPubkey (rarely present in practice - see PayRequestInfo)
      const mintPubkey = nodeInfo?.nodePubkey || info.mintPubkey
      if (mintPubkey && !isMintTrusted(server)) {
        setPendingTrust({server, mintPubkey, info, nodeInfo, username})
        return
      }
      // already trusted - still worth refreshing the cached display info
      // (Mints.tsx) with whatever this lookup just (re)discovered
      const cached = mintAddressCacheInfo(nodeInfo, username)
      if (cached) cacheTrustedMintNodeInfo(server, cached)
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
    addTrustedMint(
      pending.server,
      pending.mintPubkey,
      mintAddressCacheInfo(pending.nodeInfo, pending.username)
    )
    setPendingTrust(null)
    proceedWithPayRequest(pending.info)
  }

  const cancelTrust = () => {
    setPendingTrust(null)
    notify('Mint not trusted - lookup cancelled.', NotifyKind.ERROR)
  }

  // what amountSats() is typed as is the note value the holder wants to end
  // up with, not the invoice amount - if the mint advertises a fee (LUD-25,
  // see mintFee on PayRequestInfo) those diverge, so the actual invoice
  // requested is grossed up to net exactly the typed amount once the fee
  // comes out. Bounds are checked against the grossed-up amount, since
  // that's what's actually invoiced. A fee's percentage cut can land the
  // gross-up on a sub-sat msat value - not reliably payable, so the invoice
  // is always requested for a whole sat, rounded up (never down, so the
  // note still nets at least what was asked for).
  const amountBreakdown = createMemo(() => {
    const info = payRequest()
    const netMsat = satsToMsat(amountSats())
    if (!info || !amountSats() || !Number.isFinite(netMsat) || netMsat <= 0) {
      return null
    }
    const grossMsat = ceilMsatToSat(
      info.mintFee ? grossUpForMintFee(netMsat, info.mintFee) : netMsat
    )
    return {netMsat, grossMsat, feeMsat: grossMsat - netMsat}
  })

  // re-derives amountBreakdown() and bounds-checks it against payRequest,
  // notifying on the way out instead of silently returning null - the
  // memo itself stays notification-free so it's also safe to read for the
  // live preview below
  const parseAmount = (
    info: PayRequestInfo
  ): {netMsat: number; grossMsat: number} | null => {
    const amount = amountBreakdown()
    if (!amount) {
      notify('Enter an amount in sats.', NotifyKind.ERROR)
      return null
    }
    if (
      amount.grossMsat < info.minSendable ||
      amount.grossMsat > info.maxSendable
    ) {
      // the low end is left as minSendable itself, not its (slightly
      // smaller) fee-adjusted equivalent - simpler, and still a safe floor
      // to type. The high end does need the fee-adjusted figure - typing
      // maxSendable itself as a *net* target would gross up past it - and
      // is rounded down to a whole sat so it never advertises a value that
      // isn't actually reachable
      const maxNet = info.mintFee
        ? floorMsatToSat(applyMintFee(info.maxSendable, info.mintFee))
        : info.maxSendable
      notify(
        `Amount must be between ${msatToSats(info.minSendable)} and ${msatToSats(maxNet)} sats.`,
        NotifyKind.ERROR
      )
      return null
    }
    return amount
  }

  const getInvoice = async () => {
    const info = payRequest()
    if (!info) return
    const amount = parseAmount(info)
    if (amount === null) return
    setBusy(true)
    try {
      const result = await requestInvoice(info.callback, amount.grossMsat)
      setInvoice(result.pr)
      setInvoicedMsat(amount.netMsat)
      setInvoicedGrossMsat(amount.grossMsat)
      // LUD-11: this mint says its own payRequest link (what's typed into
      // mintInput, not this one-shot invoice) is meant to be reused -
      // save it for a one-click return trip next time
      if (!result.disposable) addStoreableMint(mintInput())
      if (result.verify) startPolling(result.verify)
    } catch (err) {
      notify((err as Error).message, NotifyKind.ERROR)
    } finally {
      setBusy(false)
    }
  }

  // shared by the manual "Claim note" buttons and checkVerify's automatic
  // claim once LUD-21 verify returns a preimage - rotates unconditionally
  // right after verifying, in both cases, no separate confirmation step.
  // expectedNetMsat/grossPaidMsat are only known coming from this page's own
  // "Create new invoice" flow (see getInvoice) - the direct-preimage path
  // (claimDirect) has no invoice of its own to compare against, so both are
  // left undefined there and the checks below are skipped entirely
  const claim = async (
    preimageValue: string,
    expectedNetMsat?: number,
    grossPaidMsat?: number
  ) => {
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
        expectedNetMsat
      )
      // verify with the service - this settles a freshly paid invoice on
      // exactly this k1, and its maxWithdrawable is the authoritative value.
      // Always cross-check it against whatever was expected: SERVICE's own
      // fee math might not match this wallet's estimate (or diverge from
      // what it advertised in the first place), and the note being minted
      // is worth exactly maxWithdrawable regardless - better to say so
      // plainly than let a silent mismatch pass
      const noteInfo = await fetchNoteInfo(declaredUrl)
      if (
        expectedNetMsat !== undefined &&
        noteInfo.maxWithdrawable !== expectedNetMsat
      ) {
        notify(
          `Amount changed: expected a ${msatToSats(expectedNetMsat)} sat note, the service reports ${msatToSats(noteInfo.maxWithdrawable)} sats.`,
          NotifyKind.ERROR
        )
      }
      if (grossPaidMsat !== undefined) {
        const feePaidMsat = grossPaidMsat - noteInfo.maxWithdrawable
        if (feePaidMsat > 0) {
          notify(
            `Mint fee paid: ${msatToSats(feePaidMsat)} sats (paid ${msatToSats(grossPaidMsat)}, note is worth ${msatToSats(noteInfo.maxWithdrawable)}).`,
            NotifyKind.SUCCESS
          )
        }
      }
      const mintPubkey = noteInfo.mintPubkey

      // if a vault is connected, this note's secret is generated and held
      // there instead of in this browser - import the preimage, then
      // immediately rotate it (deviceMint), same reasoning as the
      // browser-only rotate below
      const client = deviceClient()
      if (client) {
        const result = await deviceMint(
          client,
          info.withdrawLink,
          noteInfo.callback,
          serverOf(noteInfo.callback),
          preimageValue,
          noteInfo.maxWithdrawable
        )
        await addBearer({
          url: result.url,
          callback: result.callback,
          amount: result.amountMsat,
          verified: true,
          mintPubkey,
          deviceId: result.deviceId
        })
        logActivity(
          'mint',
          `Minted ${msatToSats(result.amountMsat)} sats from ${serverOf(result.url)} (on device).`
        )
        notify(
          `Minted a bearer note of ${msatToSats(result.amountMsat)} sats.`,
          NotifyKind.SUCCESS
        )
        navigate('/wallet')
        return
      }

      let url = withNewK1(declaredUrl, noteInfo.k1, noteInfo.maxWithdrawable)
      // that informational GET just put the preimage on the wire (server
      // logs, proxies, browser history) - per spec, a WALLET intending to
      // keep holding the note SHOULD rotate any k1 it has transmitted but
      // not burned. This also opportunistically obtains the note's first
      // offline-verifiable signature, same as the minting diagram's "obtain
      // signed note" step.
      let rotationError: string | null = null
      try {
        const rotated = await rotateNote(noteInfo.callback, noteInfo.k1)
        url = withNewK1(
          declaredUrl,
          rotated.k1,
          noteInfo.maxWithdrawable,
          rotated.signature
        )
      } catch (err) {
        rotationError = (err as Error).message
      }
      await addBearer({
        url,
        callback: noteInfo.callback,
        amount: noteInfo.maxWithdrawable,
        verified: true,
        mintPubkey
      })
      logActivity(
        'mint',
        `Minted ${msatToSats(noteInfo.maxWithdrawable)} sats from ${serverOf(url)}.`
      )
      // one toast, not two - the note was minted either way (it's in the
      // wallet now), so a failed rotate is folded into the same message
      // rather than shown as a separate, easy-to-miss-the-relation error
      if (rotationError) {
        notify(
          `Minted ${msatToSats(noteInfo.maxWithdrawable)} sats, but could not rotate (${rotationError}) - the preimage was just transmitted, treat this note as exposed.`,
          NotifyKind.ERROR
        )
      } else {
        notify(
          `Minted a bearer note of ${msatToSats(noteInfo.maxWithdrawable)} sats.`,
          NotifyKind.SUCCESS
        )
      }
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
        <div class="two-columns">
          <div class="two-col">
            <figure class="paste-widget">
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
            <Show when={mintNodeInfo()}>
              {node => (
                <figure class="setup-card">
                  <h4>
                    <Show when={node().nodeColor}>
                      <span
                        class="mint-color-dot"
                        style={{'background-color': node().nodeColor!}}
                      />
                    </Show>
                    {node().nodeAlias || 'Mint node'}
                  </h4>
                  <Show when={node().nodeCapacityMsat !== undefined}>
                    <p>
                      Channel capacity: {msatToSats(node().nodeCapacityMsat!)}{' '}
                      sats
                    </p>
                  </Show>
                  <Show
                    when={
                      node().nodeNumChannels !== undefined ||
                      node().nodeNumPeers !== undefined
                    }
                  >
                    <p>
                      <Show when={node().nodeNumChannels !== undefined}>
                        {node().nodeNumChannels} channels
                      </Show>
                      <Show
                        when={
                          node().nodeNumChannels !== undefined &&
                          node().nodeNumPeers !== undefined
                        }
                      >
                        &nbsp;·&nbsp;
                      </Show>
                      <Show when={node().nodeNumPeers !== undefined}>
                        {node().nodeNumPeers} peers
                      </Show>
                    </p>
                  </Show>
                  <p>
                    Mint limits: {msatToSats(node().minWithdrawable)} -{' '}
                    {msatToSats(node().maxWithdrawable)} sats
                  </p>
                  <Show when={node().nodeUri}>
                    <p class="mint-pubkey">{node().nodeUri}</p>
                  </Show>
                </figure>
              )}
            </Show>
            <Show when={pendingTrust()}>
              {pending => (
                <figure class="setup-card">
                  <h4>Trust this mint?</h4>
                  <p>
                    First time seeing a signing key from{' '}
                    <strong>{pending().server}</strong>. Trusting it lets its
                    notes show as offline-verified against this key - you can
                    remove the trust later, unless you end up holding a note
                    from it.
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
                      class="icon-btn icon-btn-gap"
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
                  <Show when={info().mintFee}>
                    {fee => (
                      <p class="warning">
                        This mint withholds a fee on minting:{' '}
                        {describeMintFee(fee())}. The note you end up holding is
                        worth less than what you pay - amounts below are already
                        adjusted for it. Melts won't have any additional fees -
                        this is only charged once, on minting.
                      </p>
                    )}
                  </Show>
                  <Show
                    when={mode() === 'preimage'}
                    fallback={
                      <>
                        <label>
                          Note value (sats, {msatToSats(info().minSendable)} -{' '}
                          {msatToSats(
                            info().mintFee
                              ? floorMsatToSat(
                                  applyMintFee(
                                    info().maxSendable,
                                    info().mintFee!
                                  )
                                )
                              : info().maxSendable
                          )}
                          )
                        </label>
                        <input
                          type="number"
                          min="1"
                          placeholder="amount in sats"
                          value={amountSats()}
                          onInput={e => setAmountSats(e.currentTarget.value)}
                        />
                        <Show when={amountBreakdown()}>
                          {amount => (
                            <Show when={amount().feeMsat > 0}>
                              <p class="bearer-hint">
                                Invoice: {msatToSats(amount().grossMsat)} sats
                                (includes a {msatToSats(amount().feeMsat)} sat
                                mint fee) - note: {msatToSats(amount().netMsat)}{' '}
                                sats
                              </p>
                            </Show>
                          )}
                        </Show>
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
                      Payment preimage - from paying this mint's invoice some
                      other way (its own site, a different wallet); its value
                      comes straight from the mint, no need to enter an amount
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
                          busy() ||
                          !isPreimage(directPreimage()) ||
                          offlineMode()
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
                  2. Paste the payment preimage your wallet reveals after paying
                  - it IS the bearer secret
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
                    disabled={
                      busy() || !isPreimage(preimage()) || offlineMode()
                    }
                    onClick={() =>
                      claim(preimage(), invoicedMsat(), invoicedGrossMsat())
                    }
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
          <div class="two-col">
            <Show when={storeableMints().length > 0}>
              <figure class="setup-card">
                <h4>Your storeable mints</h4>
                <p>
                  These mints said their own address is meant to be reused, not
                  a one-time link (LUD-11) - saved here for a one-click return
                  trip.
                </p>
                <div class="mint-picker">
                  <For each={storeableMints()}>
                    {link => (
                      <span class="mint-picker-entry">
                        <button
                          disabled={busy() || offlineMode()}
                          onClick={() => selectMint(link.address)}
                        >
                          {link.address}
                        </button>
                        <button
                          class="icon-btn"
                          title="Forget this mint"
                          onClick={() => removeStoreableMint(link.address)}
                        >
                          <IoTrashSharp />
                        </button>
                      </span>
                    )}
                  </For>
                </div>
              </figure>
            </Show>
            <Show when={trustedMints().length > 0}>
              <figure class="setup-card">
                <h4>Your trusted mints</h4>
                <div class="mint-picker">
                  <For each={trustedMints()}>
                    {mint => (
                      <button
                        disabled={busy() || offlineMode()}
                        onClick={() => selectMint(mintAddressFor(mint.server))}
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
          </div>
        </div>
      </div>
    </RequireWallet>
  )
}
export default Mint
