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
import type {
  PayRequestInfo,
  MintAddressInfo,
  VerifyResult,
  InvoiceResult
} from '../lnurlcash'
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
  noteEndpointOf,
  isPreimage,
  applyMintFee,
  grossUpForMintFee,
  describeMintFee,
  mintAddressUrl,
  fetchMintAddress,
  lightningAddressUsername,
  probeBurnedNote,
  sameInvoice,
  generateMintSecret,
  hashK1,
  requireMintComment,
  requireBoundMintQuote,
  validateBoundMintReceipt,
  AmbiguousMutationError
} from '../lnurlcash'
import {
  deviceMint,
  DeviceImportLeftBehindError,
  stageDeviceBoundMint,
  discardDeviceBoundMint,
  confirmDeviceBoundMint
} from '../deviceOrchestration'
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
  getTrustedMintPubkey,
  addTrustedMint,
  cacheTrustedMintNodeInfo,
  getTrustedMintAddress,
  mintAddressCacheInfo,
  trustedMints,
  PUBLIC_MINTS
} from '../trustedMints'
import {
  clearPendingDeviceMint,
  readPendingDeviceMint,
  savePendingDeviceMint,
  type PendingDeviceMint
} from '../pendingDeviceMint'
import {
  storeableMints,
  addStoreableMint,
  removeStoreableMint
} from '../storeableLinks'
import {offlineMode} from '../offlineMode'
import Qr from '../components/Qr'
import ScanToggle from '../components/ScanToggle'
import NfcToggle from '../components/NfcToggle'
import RequireWallet from '../components/RequireWallet'
import Dialog from '../components/Dialog'

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

// LUD-25 minting: pay a payRequest that advertises `withdrawLink` and enough
// comment capacity to bind the output to a wallet-chosen secret. This wallet
// has no Lightning node of its own, so the invoice is paid externally; its
// preimage proves settlement but never becomes the new bearer secret.
const Mint: Component = () => {
  const {bearers, addBearer, logActivity} = useWallet()
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
  // The wallet-chosen k1 for the current invoice. It is null before an
  // invoice exists; current mint creation refuses rather than creating an
  // unnamed, payment-preimage-backed note.
  const [mintSecret, setMintSecret] = createSignal<string | null>(null)
  // Present only for the preferred sealed flow. Everything here is public
  // recovery metadata; the corresponding k1 never leaves the vault.
  const [deviceMintAttempt, setDeviceMintAttempt] =
    createSignal<PendingDeviceMint | null>(null)
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
      // a settled report only means this wallet's invoice was paid if it's
      // for the invoice this wallet actually requested
      const requested = invoice()
      if (result.settled && requested && !sameInvoice(result.pr, requested)) {
        stopPolling()
        notify(
          "The service's verify response is for a different invoice than requested - don't pay the shown invoice until this is checked.",
          NotifyKind.ERROR
        )
        return
      }
      if (result.settled) {
        stopPolling()
        const deviceAttempt = deviceMintAttempt()
        if (deviceAttempt) {
          notify(
            'Payment settled - authenticating the vault receipt...',
            NotifyKind.LOADING
          )
          await claimDeviceMint(deviceAttempt, result)
          return
        }
        // The note's real k1 is the wallet-held secret, not whatever
        // settlement preimage the service discloses here.
        const secret = mintSecret()
        if (secret) {
          notify(
            'Payment settled - claiming automatically...',
            NotifyKind.LOADING
          )
          await claim(secret, invoicedMsat(), invoicedGrossMsat())
        } else {
          notify(
            'Payment settled, but the wallet-held note secret is missing. Do not pay or retry this invoice.',
            NotifyKind.ERROR
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

  const restoreDeviceMint = (pending: PendingDeviceMint) => {
    setDeviceMintAttempt(pending)
    setMintInput(pending.mintInput)
    setPayRequest(pending.payRequest)
    setMode('invoice')
    setInvoice(pending.invoice.pr)
    setInvoicedMsat(pending.amountMsat)
    setInvoicedGrossMsat(pending.grossMsat)
    setMintSecret(null)
    startPolling(pending.invoice.verify)
  }

  // A direct device-bound invoice is recoverable after a reload because its
  // public quote state was persisted before the QR was rendered. The device
  // still holds the only k1 in PENDING state.
  let restoredPendingMint = false
  createEffect(() => {
    if (restoredPendingMint) return
    restoredPendingMint = true
    const pending = readPendingDeviceMint()
    if (pending) restoreDeviceMint(pending)
  })

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
    setDirectPreimage('')
    setMintSecret(null)
    setDeviceMintAttempt(null)
    stopPolling()
    setVerifyUrl(null)
  }

  // closes the combined lookup/trust/invoice dialog and drops this mint
  // attempt entirely - back to the lookup step, same as
  // proceedWithPayRequest's reset but in reverse, plus the node info/trust
  // gate that can precede it. A half-paid invoice is not lost by this: its
  // bound secret came from the persisted seed ladder and a recovery scan can
  // find the note later. The invoice-specific controls are not persisted, so
  // the holder should still keep this dialog open while paying.
  const closeMintDialog = () => {
    setMintNodeInfo(null)
    setPendingTrust(null)
    stopPolling()
    setVerifyUrl(null)
    setPayRequest(null)
    setInvoice(null)
    setMode('invoice')
    setDirectPreimage('')
    setMintSecret(null)
  }

  const lookup = async () => {
    const pendingMint = deviceMintAttempt() ?? readPendingDeviceMint()
    if (pendingMint) {
      restoreDeviceMint(pendingMint)
      notify(
        'Resumed the invoice already bound to your vault. Finish or verify it before starting another device mint.',
        NotifyKind.SUCCESS
      )
      return
    }
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
      if (mintPubkey) {
        const trust = addTrustedMint(server, mintPubkey, cached)
        if (trust === 'rekey-pending') {
          notify(
            `${server} advertises a different signing key than the one pinned. Review it on the Mints page before minting a receipt-backed note.`,
            NotifyKind.ERROR
          )
          return
        }
      } else if (cached) {
        cacheTrustedMintNodeInfo(server, cached)
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
    const existing = deviceMintAttempt() ?? readPendingDeviceMint()
    if (existing) {
      restoreDeviceMint(existing)
      notify(
        'Finish the invoice already bound to your vault before creating another one.',
        NotifyKind.ERROR
      )
      return
    }
    const amount = parseAmount(info)
    if (amount === null) return
    setBusy(true)
    try {
      // Current LUD-25 minting requires the comment commitment. Refuse
      // before an invoice exists if the mint does not advertise enough
      // capacity, then generate the real secret and disclose only its hash.
      // domain the secret is derived/indexed under (see lnurlcash.ts's
      // generateMintSecret) is the note's actual home, the withdraw
      // endpoint - not the payRequest callback, in the unlikely case a mint
      // ever splits those across hosts. withdrawLink is always present here
      // because lookup rejects a payRequest that omits it.
      requireMintComment(info)

      let result: InvoiceResult | null = null
      const client = deviceClient()
      const mintServer = serverOf(info.withdrawLink || info.callback)
      const mintPubkey = getTrustedMintPubkey(mintServer)

      if (client && info.mintToHash === true && mintPubkey) {
        // The device creates and durably stores k1 first. Confirm that this
        // firmware also exposes h in list_notes: that public metadata is what
        // lets a reloaded companion match the pending receipt without export.
        const staged = await stageDeviceBoundMint(client)
        let useBrowserFallback = false
        try {
          const stagedNote = (await client.listAllNotes()).find(
            note => note.id === staged.deviceId
          )
          if (stagedNote?.h?.toLowerCase() !== staged.h) {
            useBrowserFallback = true
            throw new Error(
              'The connected vault firmware cannot recover a pending bound mint by hash.'
            )
          }

          const candidate = await requestInvoice(
            info.callback,
            amount.grossMsat,
            staged.h
          )
          let commitment
          try {
            commitment = requireBoundMintQuote(
              candidate,
              staged.h,
              amount.grossMsat,
              info.mintFee
            )
          } catch (err) {
            // The invoice has not been rendered or paid. Throw it away and
            // request a fresh comment-bound invoice for the compatible
            // browser-secret/import-and-rotate fallback below.
            useBrowserFallback = true
            throw err
          }

          const pending: PendingDeviceMint = {
            version: 1,
            deviceId: staged.deviceId,
            h: staged.h,
            mintInput: mintInput(),
            payRequest: info,
            invoice: {...candidate, verify: candidate.verify!},
            grossMsat: amount.grossMsat,
            amountMsat: commitment.amountMsat,
            mintPubkey,
            createdAt: Date.now()
          }
          // Persist before setInvoice makes the QR visible or copyable.
          savePendingDeviceMint(pending)
          setDeviceMintAttempt(pending)
          setMintSecret(null)
          setInvoicedMsat(commitment.amountMsat)
          result = candidate
        } catch (err) {
          try {
            await discardDeviceBoundMint(client, staged.deviceId)
          } catch (discardError) {
            throw new Error(
              `${(err as Error).message} The unused staged output could not be discarded (${(discardError as Error).message}); it remains pending on the vault.`
            )
          }
          if (!useBrowserFallback) throw err
          notify(
            `${(err as Error).message} Using a recoverable browser secret and moving it onto the vault after settlement instead.`,
            NotifyKind.ERROR
          )
        }
      }

      if (!result) {
        const secret = generateMintSecret(mintServer)
        result = await requestInvoice(
          info.callback,
          amount.grossMsat,
          hashK1(secret)
        )
        setMintSecret(secret)
        setDeviceMintAttempt(null)
        setInvoicedMsat(amount.netMsat)
      }

      setInvoice(result.pr)
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

  const claimDeviceMint = async (
    pending: PendingDeviceMint,
    verification: VerifyResult
  ) => {
    try {
      const receipt = validateBoundMintReceipt(
        pending.invoice,
        verification,
        pending.h,
        pending.amountMsat,
        pending.mintPubkey
      )
      const client = deviceClient()
      if (!client) {
        notify(
          'Payment and receipt are valid. Reconnect the same vault, then check payment again to finish the note without exporting its secret.',
          NotifyKind.ERROR
        )
        return
      }

      const staged = (await client.listAllNotes()).find(
        note => note.id === pending.deviceId
      )
      if (!staged || staged.h?.toLowerCase() !== pending.h) {
        throw new Error(
          'The connected vault does not hold the staged output named by this receipt.'
        )
      }
      if (staged.state === 'spent') {
        throw new Error('The staged vault output is already marked spent.')
      }

      // A crash after addBearer but before clearing the recovery record must
      // not create a duplicate card on retry.
      if (bearers().some(bearer => bearer.deviceId === pending.deviceId)) {
        clearPendingDeviceMint()
        setDeviceMintAttempt(null)
        navigate('/wallet')
        return
      }

      const result = await confirmDeviceBoundMint(client, {
        deviceId: pending.deviceId,
        h: pending.h,
        withdrawLink: pending.payRequest.withdrawLink!,
        amountMsat: receipt.amountMsat,
        signature: receipt.signature
      })
      await addBearer({
        url: result.url,
        callback: result.callback,
        amount: result.amountMsat,
        verified: true,
        mintPubkey: pending.mintPubkey,
        deviceId: result.deviceId,
        deviceHash: result.deviceHash
      })
      // Clear only after the encrypted bearer exists. If the tab dies before
      // here, the persisted receipt safely resumes and deduplicates above.
      clearPendingDeviceMint()
      setDeviceMintAttempt(null)
      logActivity(
        'mint',
        `Minted ${msatToSats(result.amountMsat)} sats from ${serverOf(result.url)} directly onto the vault.`
      )
      const feePaidMsat = pending.grossMsat - result.amountMsat
      notify(
        `Minted ${msatToSats(result.amountMsat)} sats directly onto the vault${feePaidMsat > 0 ? ` (${msatToSats(feePaidMsat)} sat mint fee)` : ''}. Refresh it once before its first spend to learn the mint callback.`,
        NotifyKind.SUCCESS
      )
      navigate('/wallet')
    } catch (err) {
      notify((err as Error).message, NotifyKind.ERROR)
    }
  }

  // Shared by the current wallet-secret claim and the explicit legacy
  // "I already have a preimage" recovery path. It rotates unconditionally
  // after verifying, with no separate confirmation step.
  // expectedNetMsat/grossPaidMsat are only known coming from this page's own
  // "Create new invoice" flow (see getInvoice) - the direct-preimage path
  // (claimDirect) has no invoice of its own to compare against, so both are
  // left undefined there and the checks below are skipped entirely
  const claim = async (
    noteSecret: string,
    expectedNetMsat?: number,
    grossPaidMsat?: number
  ) => {
    const info = payRequest()
    if (!info?.withdrawLink) return
    if (!isPreimage(noteSecret)) {
      notify('The note secret is 64 hex characters.', NotifyKind.ERROR)
      return
    }
    setBusy(true)
    try {
      // declare the invoiced amount (a claim - not yet confirmed) so the
      // note is self-describing even before the verifying GET below
      const declaredUrl = buildNoteUrl(
        info.withdrawLink,
        noteSecret,
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
      // there instead of in this browser - import the note secret, then
      // immediately rotate it (deviceMint), same reasoning as the
      // browser-only rotate below. A rotate that fails AFTER the import
      // already landed leaves the note CONFIRMED on the device (the failed
      // mint call burned nothing) - that case still tracks it, as an
      // unverified mirror, rather than stranding it (see the catch below)
      const client = deviceClient()
      if (client) {
        try {
          const result = await deviceMint(
            client,
            info.withdrawLink,
            noteInfo.callback,
            noteEndpointOf(info.withdrawLink),
            noteSecret,
            noteInfo.maxWithdrawable
          )
          await addBearer({
            url: result.url,
            callback: result.callback,
            amount: result.amountMsat,
            verified: true,
            mintPubkey,
            deviceId: result.deviceId,
            deviceHash: result.deviceHash
          })
          logActivity(
            'mint',
            `Minted ${msatToSats(result.amountMsat)} sats from ${serverOf(result.url)} (on device).` +
              (verifyUrl() ? ` Verify: ${verifyUrl()}.` : '')
          )
          notify(
            `Minted a bearer note of ${msatToSats(result.amountMsat)} sats.`,
            NotifyKind.SUCCESS
          )
        } catch (err) {
          if (!(err instanceof DeviceImportLeftBehindError)) throw err
          // the imported note is still whole on the device - keep
          // tracking it locally (k1-less, unverified, at the service's own
          // reported amount); the next device refresh rotates it properly
          // under device custody and repairs the record
          await addBearer({
            url: err.imported.url,
            callback: err.imported.callback,
            amount: err.imported.amountMsat,
            verified: false,
            mintPubkey,
            deviceId: err.imported.deviceId,
            deviceHash: err.imported.deviceHash
          })
          logActivity(
            'mint',
            `Minted ${msatToSats(err.imported.amountMsat)} sats from ${serverOf(err.imported.url)} (on device), but rotating it under device custody failed (${err.message}) - tracked unverified.` +
              (verifyUrl() ? ` Verify: ${verifyUrl()}.` : '')
          )
          notify(
            `Minted ${msatToSats(err.imported.amountMsat)} sats, but moving it onto the vault didn't complete (${err.message}) - the note is tracked unverified; refresh it with the vault connected to repair.`,
            NotifyKind.ERROR
          )
        }
        navigate('/wallet')
        return
      }

      let url = withNewK1(declaredUrl, noteInfo.k1, noteInfo.maxWithdrawable)
      // that informational GET just put the note secret on the wire (server
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
        if (err instanceof AmbiguousMutationError) {
          // the rotate request may have landed despite the failure - the
          // fresh secret it carried is then the only copy of this note
          const outcome = await probeBurnedNote(url)
          if (outcome === 'gone') {
            // the burn landed - adopt the fresh secret as the note
            url = withNewK1(
              declaredUrl,
              err.newSecrets[0],
              noteInfo.maxWithdrawable
            )
          } else if (outcome === 'unknown') {
            // can't tell: the original note is stored below either way -
            // track the possible rotated copy alongside it
            await addBearer({
              url: withNewK1(
                declaredUrl,
                err.newSecrets[0],
                noteInfo.maxWithdrawable
              ),
              callback: noteInfo.callback,
              amount: noteInfo.maxWithdrawable,
              verified: false,
              mintPubkey
            })
            rotationError = `${(err as Error).message} The rotation may still have gone through - the possible rotated copy is stored unverified alongside this one; refresh both to reconcile.`
          } else {
            rotationError = (err as Error).message
          }
        } else {
          rotationError = (err as Error).message
        }
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
        `Minted ${msatToSats(noteInfo.maxWithdrawable)} sats from ${serverOf(url)}.` +
          (verifyUrl() ? ` Verify: ${verifyUrl()}.` : '')
      )
      // one toast, not two - the note was minted either way (it's in the
      // wallet now), so a failed rotate is folded into the same message
      // rather than shown as a separate, easy-to-miss-the-relation error
      if (rotationError) {
        notify(
          `Minted ${msatToSats(noteInfo.maxWithdrawable)} sats, but could not rotate (${rotationError}) - the note secret was just transmitted, treat this note as exposed.`,
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
                <NfcToggle
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
            <Show when={mintNodeInfo() || pendingTrust() || payRequest()}>
              <Dialog onClose={closeMintDialog}>
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
                          Channel capacity:{' '}
                          {msatToSats(node().nodeCapacityMsat!)} sats
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
                      <div class="btns">
                        <a
                          class="icon-btn"
                          title="Open this mint"
                          href={`https://${serverOf(node().payLink)}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          <IoGlobeSharp />
                        </a>
                        <Show when={node().nodePubkey}>
                          <a
                            class="icon-btn icon-btn-gap"
                            title="Look up this Lightning node on mempool.space"
                            href={mempoolNodeUrl(node().nodePubkey!)}
                            target="_blank"
                            rel="noreferrer"
                          >
                            <IoOpenSharp />
                          </a>
                        </Show>
                      </div>
                    </figure>
                  )}
                </Show>
                <Show when={pendingTrust()}>
                  {pending => (
                    <figure class="setup-card">
                      <h4>Trust this mint?</h4>
                      <p>
                        First time seeing a signing key from{' '}
                        <strong>{pending().server}</strong>. Trusting it lets
                        its notes show as offline-verified against this key -
                        you can remove the trust later, unless you end up
                        holding a note from it.
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
                    <>
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
                              setDirectPreimage('')
                            }}
                          >
                            Recover legacy preimage note
                          </button>
                        </div>
                        <Show when={info().mintFee}>
                          {fee => (
                            <p class="warning">
                              This mint withholds a fee on minting:{' '}
                              {describeMintFee(fee())}. The note you end up
                              holding is worth less than what you pay - amounts
                              below are already adjusted for it. Melts won't
                              have any additional fees - this is only charged
                              once, on minting.
                            </p>
                          )}
                        </Show>
                        <Show
                          when={mode() === 'preimage'}
                          fallback={
                            <>
                              <label>
                                Note value (sats,{' '}
                                {msatToSats(info().minSendable)} -{' '}
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
                                onInput={e =>
                                  setAmountSats(e.currentTarget.value)
                                }
                              />
                              <Show when={amountBreakdown()}>
                                {amount => (
                                  <Show when={amount().feeMsat > 0}>
                                    <p class="bearer-hint">
                                      Invoice: {msatToSats(amount().grossMsat)}{' '}
                                      sats (includes a{' '}
                                      {msatToSats(amount().feeMsat)} sat mint
                                      fee) - note:{' '}
                                      {msatToSats(amount().netMsat)} sats
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
                            Legacy payment preimage - only for recovering a
                            pre-comment note created elsewhere; its value comes
                            straight from the mint, so no amount is needed
                          </label>
                          <input
                            type="text"
                            placeholder="payment preimage (64 hex characters)"
                            value={directPreimage()}
                            onInput={e =>
                              setDirectPreimage(e.currentTarget.value)
                            }
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
                          <Show when={mintSecret()}>
                            {secret => (
                              <>
                                <label>
                                  2. This current LUD-25 mint is bound to this
                                  wallet's secret - nothing to paste. Claim it
                                  below once paid
                                  <Show when={verifyUrl()}>
                                    {' '}
                                    (or wait - this mint checks automatically)
                                  </Show>
                                  .
                                </label>
                                <div class="btns">
                                  <button
                                    disabled={busy() || offlineMode()}
                                    onClick={() =>
                                      claim(
                                        secret(),
                                        invoicedMsat(),
                                        invoicedGrossMsat()
                                      )
                                    }
                                  >
                                    <Show when={busy()}>
                                      <IoRefreshSharp class="spin" />
                                      &nbsp;
                                    </Show>
                                    Claim note
                                  </button>
                                </div>
                              </>
                            )}
                          </Show>
                          <Show when={deviceMintAttempt()}>
                            {pending => (
                              <>
                                <label>
                                  2. This invoice is bound directly to a secret
                                  held PENDING on your vault. The browser has
                                  only its hash; once paid, the mint's signed
                                  receipt confirms it without exporting or
                                  rotating the secret.
                                </label>
                                <div class="btns">
                                  <button
                                    disabled={
                                      verifying() || busy() || offlineMode()
                                    }
                                    onClick={manualCheck}
                                  >
                                    <Show when={verifying()}>
                                      <IoRefreshSharp class="spin" />
                                      &nbsp;
                                    </Show>
                                    {deviceClient()
                                      ? 'Verify and finish on vault'
                                      : 'Reconnect vault, then verify'}
                                  </button>
                                </div>
                                <p class="bearer-hint">
                                  Recovery output {pending().deviceId} · hash{' '}
                                  {pending().h.slice(0, 12)}…
                                </p>
                              </>
                            )}
                          </Show>
                        </figure>
                      </Show>
                    </>
                  )}
                </Show>
              </Dialog>
            </Show>
            <Show when={trustedMints().length > 0}>
              <h4>Your trusted mints</h4>
              <div class="mint-list">
                <For each={trustedMints()}>
                  {mint => (
                    <figure class="mint-card">
                      <h4>
                        <Show when={mint.nodeColor}>
                          <span
                            class="mint-color-dot"
                            style={{'background-color': mint.nodeColor!}}
                          />
                        </Show>
                        {mint.nodeAlias || mint.server}
                      </h4>
                      <Show when={mint.nodeAlias || mint.username}>
                        <p class="mint-date">
                          {mint.username
                            ? `${mint.username}@${mint.server}`
                            : mint.server}
                        </p>
                      </Show>
                      <Show when={mint.nodeCapacityMsat !== undefined}>
                        <p class="mint-date">
                          Channel capacity: {msatToSats(mint.nodeCapacityMsat!)}{' '}
                          sats
                        </p>
                      </Show>
                      <Show
                        when={
                          mint.nodeNumChannels !== undefined ||
                          mint.nodeNumPeers !== undefined
                        }
                      >
                        <p class="mint-date">
                          <Show when={mint.nodeNumChannels !== undefined}>
                            {mint.nodeNumChannels} channels
                          </Show>
                          <Show
                            when={
                              mint.nodeNumChannels !== undefined &&
                              mint.nodeNumPeers !== undefined
                            }
                          >
                            &nbsp;·&nbsp;
                          </Show>
                          <Show when={mint.nodeNumPeers !== undefined}>
                            {mint.nodeNumPeers} peers
                          </Show>
                        </p>
                      </Show>
                      <p class="mint-pubkey">{mint.mintPubkey}</p>
                      <div class="btns">
                        <button
                          disabled={busy() || offlineMode()}
                          onClick={() =>
                            selectMint(mintAddressFor(mint.server))
                          }
                        >
                          Mint here
                        </button>
                        <a
                          class="icon-btn"
                          title="Open this mint"
                          href={`https://${mint.server}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          <IoGlobeSharp />
                        </a>
                        <a
                          class="icon-btn icon-btn-gap"
                          title="Look up this Lightning node on mempool.space"
                          href={mempoolNodeUrl(mint.mintPubkey)}
                          target="_blank"
                          rel="noreferrer"
                        >
                          <IoOpenSharp />
                        </a>
                      </div>
                    </figure>
                  )}
                </For>
              </div>
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
