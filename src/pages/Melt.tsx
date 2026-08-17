import type {Component} from 'solid-js'
import {Show, For, createSignal, createMemo, onMount, onCleanup} from 'solid-js'
import {useNavigate, useSearchParams} from '@solidjs/router'
import {
  IoClipboardSharp,
  IoCloseSharp,
  IoReturnDownForwardSharp,
  IoRefreshSharp,
  IoTrashSharp
} from 'solid-icons/io'

import type {Bearer} from '../storage'
import {useWallet, groupByServer} from '../WalletContext'
import {useDevice} from '../DeviceContext'
import type {PayRequestInfo, MeltResult} from '../lnurlcash'
import {
  isBolt11Invoice,
  isLightningAddress,
  resolveMintInput,
  fetchPayRequest,
  requestInvoice,
  fetchInvoiceVerification,
  decodeBolt11AmountMsat,
  serverOf,
  requireNoteK1,
  withNewK1,
  meltNote,
  mergeNotes,
  splitNote,
  settleNote,
  NoteSpentError
} from '../lnurlcash'
import {
  deviceMerge,
  deviceSplit,
  deviceSettle,
  deviceMeltRequest,
  deviceMarkSpent,
  requireDeviceClient
} from '../deviceOrchestration'
import {
  notify,
  NotifyKind,
  msatToSats,
  satsToMsat,
  pasteFromClipboard
} from '../helpers'
import {offlineMode} from '../offlineMode'
import {getTrustedMintNodeColor} from '../trustedMints'
import {
  storeableMeltAddresses,
  addStoreableMeltAddress,
  removeStoreableMeltAddress
} from '../storeableLinks'
import ScanToggle from '../components/ScanToggle'
import RequireWallet from '../components/RequireWallet'
import SendNoteCard from '../components/SendNoteCard'

// same cadence as Mint.tsx's LUD-21 verify poll - a melt's own LUD-25 melt
// proof (see meltNote) is checked the same way that poll checks an
// incoming payment
const PENDING_POLL_SECONDS = 5

const Melt: Component = () => {
  const {addBearer, updateBearer, removeBearer, bearers, logActivity} =
    useWallet()
  const {client: deviceClient} = useDevice()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  let pasteRef: HTMLInputElement | null = null

  const [value, setValue] = createSignal('')
  // this wallet has no Lightning node of its own, so paying an invoice here
  // means spending it out of a held bearer note - melt only ever takes a
  // single k1, so 2+ selected notes get merged into one first
  const [pastedInvoice, setPastedInvoice] = createSignal<string | null>(null)
  const [selectedIds, setSelectedIds] = createSignal<Set<string>>(new Set())
  const [paying, setPaying] = createSignal(false)

  // a Lightning Address has no invoice of its own yet - resolving one just
  // gets its payRequest, then an amount is needed before an actual invoice
  // (and thus a pastedInvoice) exists
  const [lnAddressPayRequest, setLnAddressPayRequest] =
    createSignal<PayRequestInfo | null>(null)
  // the raw address itself, kept alongside its resolved payRequest above -
  // needed at invoice-request time to save it as storeable (LUD-11), and
  // otherwise not derivable back from lnAddressPayRequest alone
  const [lnAddressText, setLnAddressText] = createSignal('')
  const [lnAddressAmountSats, setLnAddressAmountSats] = createSignal('')
  const [fetchingInvoice, setFetchingInvoice] = createSignal(false)

  // set right after a melt is requested, alongside the LUD-25 melt proof
  // URL it returned - polled until that proof reports the payment settled
  const [pendingNote, setPendingNote] = createSignal<Bearer | null>(null)
  const [meltVerifyUrl, setMeltVerifyUrl] = createSignal<string | null>(null)
  const [secondsLeft, setSecondsLeft] = createSignal(PENDING_POLL_SECONDS)
  const [checkingPending, setCheckingPending] = createSignal(false)
  let pollTimer: ReturnType<typeof setInterval> | null = null

  const stopPolling = () => {
    if (pollTimer) clearInterval(pollTimer)
    pollTimer = null
  }

  // a melt's {"status":"OK"} only means the payment is in flight (see
  // meltNote) - its melt proof (LUD-25's `verify`, only present when the
  // service advertises one) is how its actual fate gets confirmed: once it
  // reports `settled`, the outgoing payment went through for good, so the
  // note (already locked as spent locally) really is gone. Unlike the old
  // rotate-and-see probe, a not-yet-settled result never distinguishes
  // "still in flight" from "failed" - a genuinely failed melt only shows up
  // here as a check that keeps not reporting settled, same as one that's
  // merely slow; the note can still be freed by hand (BearerCard's "Unspend
  // anyway") if it's ever confirmed to have actually failed some other way
  const checkPending = async () => {
    const note = pendingNote()
    const url = meltVerifyUrl()
    if (!note || !url || checkingPending()) return
    setCheckingPending(true)
    try {
      const result = await fetchInvoiceVerification(url)
      if (!result.settled) return // still in flight - next tick
      stopPolling()
      setPendingNote(null)
      setMeltVerifyUrl(null)
      // this is the settlement-confirmed moment, not optimistic - mirrors
      // exactly when the local spent-flag above already landed
      if (note.deviceId) {
        const client = deviceClient()
        if (client) await deviceMarkSpent(client, note.deviceId)
      }
      logActivity(
        'melt',
        `Melted ${msatToSats(note.amount)} sats from ${serverOf(note.url)} to pay an invoice.`
      )
      notify('Payment confirmed - the note is gone.', NotifyKind.SUCCESS)
      navigate('/wallet')
    } catch {
      // a single failed check isn't fatal - the next tick tries again
    } finally {
      setCheckingPending(false)
    }
  }

  const startPolling = (note: Bearer, verifyUrl: string) => {
    stopPolling()
    setPendingNote(note)
    setMeltVerifyUrl(verifyUrl)
    setSecondsLeft(PENDING_POLL_SECONDS)
    pollTimer = setInterval(() => {
      setSecondsLeft(s => {
        if (s <= 1) {
          checkPending()
          return PENDING_POLL_SECONDS
        }
        return s - 1
      })
    }, 1000)
  }

  // manual click: check right away, then restart the countdown so the next
  // automatic tick isn't immediately on its heels. checkPending's own guard
  // stops a second concurrent check, but on its own that still lets a rapid
  // double-click (or a click landing right as the automatic tick was about
  // to fire) restart the interval twice in a row - guard here too so the
  // whole "check + restart" action only happens once per click
  const manualCheckPending = () => {
    if (checkingPending()) return
    checkPending()
    const note = pendingNote()
    const url = meltVerifyUrl()
    if (note && url) startPolling(note, url)
  }

  onCleanup(stopPolling)

  // arriving from Paste.tsx's own bolt11 detection, invoice carried as a
  // query param rather than duplicating this whole dialog there
  onMount(() => {
    const pr = searchParams.pr
    if (typeof pr === 'string' && isBolt11Invoice(pr)) {
      setPastedInvoice(pr.trim())
    }
  })

  const isValid = createMemo(
    () =>
      value() === '' || isBolt11Invoice(value()) || isLightningAddress(value())
  )

  // a Lightning Address just gets its payRequest here - getInvoiceFromAddress
  // below turns that into an actual invoice once an amount is chosen
  const lookupLnAddress = async (address: string) => {
    const url = resolveMintInput(address)
    if (!url) {
      notify('Not a valid Lightning Address.', NotifyKind.ERROR)
      return
    }
    setFetchingInvoice(true)
    try {
      setLnAddressPayRequest(await fetchPayRequest(url))
      setLnAddressText(address)
    } catch (err) {
      notify((err as Error).message, NotifyKind.ERROR)
    } finally {
      setFetchingInvoice(false)
    }
  }

  const handleValue = (raw: string) => {
    const trimmed = raw.trim()
    if (isBolt11Invoice(trimmed)) {
      setPastedInvoice(trimmed)
      setValue('')
      return
    }
    if (isLightningAddress(trimmed)) {
      lookupLnAddress(trimmed)
      setValue('')
      return
    }
    notify('Not a valid bolt11 invoice or Lightning Address.', NotifyKind.ERROR)
  }

  const handle = () => {
    if (value() === '') return
    handleValue(value())
  }

  const paste = async () => {
    const text = await pasteFromClipboard()
    if (text !== null) {
      setValue(text)
      pasteRef?.focus()
      handle()
    }
  }

  const onScan = (scanned: string) => handleValue(scanned)

  // click-to-select from the saved-addresses picker below
  const selectSavedAddress = (address: string) => handleValue(address)

  // validates lnAddressAmountSats() against the payRequest's bounds, then
  // turns it into an actual bolt11 - same shape as a directly pasted one
  const getInvoiceFromAddress = async () => {
    const info = lnAddressPayRequest()
    if (!info) return
    const msat = satsToMsat(lnAddressAmountSats())
    if (!lnAddressAmountSats() || !Number.isFinite(msat) || msat <= 0) {
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
    setFetchingInvoice(true)
    try {
      const result = await requestInvoice(info.callback, msat)
      setPastedInvoice(result.pr)
      // LUD-11: this address says it's meant to be reused for future
      // melts (not this one invoice, which is spent once paid regardless)
      // - save it, kept apart from Mint.tsx's own storeable mints (see
      // storeableLinks.ts - a melt destination isn't necessarily a mint)
      if (!result.disposable) addStoreableMeltAddress(lnAddressText())
      setLnAddressPayRequest(null)
      setLnAddressAmountSats('')
    } catch (err) {
      notify((err as Error).message, NotifyKind.ERROR)
    } finally {
      setFetchingInvoice(false)
    }
  }

  const onKeydown = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handle()
    }
  }

  const invoiceAmountMsat = createMemo(() => {
    const invoice = pastedInvoice()
    return invoice ? decodeBolt11AmountMsat(invoice) : null
  })

  const unspentBearers = createMemo(() => bearers().filter(b => !b.spent))
  const selectedBearers = createMemo(() =>
    bearers().filter(b => selectedIds().has(b.id))
  )
  const selectedTotal = createMemo(() =>
    selectedBearers().reduce((sum, b) => sum + b.amount, 0)
  )
  // merging (and, if needed, splitting) burns notes and mints replacements,
  // so every selected note must come from the same service, already be
  // verified (callback known), and not be locally locked as spent
  const selectionValid = createMemo(() => {
    const picked = selectedBearers()
    if (picked.length === 0) return false
    const server = serverOf(picked[0].url)
    return picked.every(
      b => serverOf(b.url) === server && b.callback !== '' && !b.spent
    )
  })

  // melt demands an exact match - an invoice amount that fails to decode is
  // treated as unknown, not zero, so it's left for the service to judge
  // rather than blocking here
  const selectionPayable = createMemo(() => {
    if (!selectionValid()) return false
    const amount = invoiceAmountMsat()
    return amount === null || selectedTotal() === amount
  })

  // covers the invoice but isn't an exact note - Split and pay carves off
  // exact change (keeping the remainder as a fresh note) before melting
  const selectionNeedsSplit = createMemo(() => {
    if (!selectionValid()) return false
    const amount = invoiceAmountMsat()
    return amount !== null && selectedTotal() > amount
  })

  const toggleSelect = (id: string, isSelected: boolean) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (isSelected) next.add(id)
      else next.delete(id)
      return next
    })
  }

  const clearInvoice = () => {
    stopPolling()
    setPendingNote(null)
    setMeltVerifyUrl(null)
    setPastedInvoice(null)
    setSelectedIds(new Set<string>())
  }

  // merges the selection into one note worth their sum - a no-op returning
  // the note itself when only one is selected, since merge only makes
  // sense for 2+. settleNote reads the actual value back (a mint MAY
  // refund part of its fees on merge - LUD-25) and rotates the merged
  // secret, since learning that value necessarily puts it on the wire -
  // melt below demands an exact amount match, so the stored note must be
  // trustworthy, not the naive pre-fee sum. If a vault is connected, the
  // merged note lands there instead - regardless of whether any of the
  // inputs were themselves device-backed (mixed selections are fine, see
  // deviceOrchestration.ts)
  const mergeSelectionIfNeeded = async (
    picked: ReturnType<typeof selectedBearers>
  ) => {
    if (picked.length === 1) return picked[0]
    const base = picked[0]
    const total = picked.reduce((sum, b) => sum + b.amount, 0)
    const client = deviceClient()
    if (client) {
      const merged = await deviceMerge(
        client,
        picked.map(b => ({deviceId: b.deviceId, url: b.url})),
        base.callback,
        total
      )
      const settled = await deviceSettle(client, merged)
      for (const bearer of picked) removeBearer(bearer.id)
      return addBearer({
        url: settled.url,
        callback: settled.callback,
        amount: settled.amountMsat,
        verified: true,
        mintPubkey: base.mintPubkey,
        deviceId: settled.deviceId
      })
    }
    const merged = await mergeNotes(
      base.callback,
      picked.map(b => requireNoteK1(b.url))
    )
    const settled = await settleNote(
      base.url,
      merged.k1,
      total,
      merged.signature
    )
    for (const bearer of picked) removeBearer(bearer.id)
    return addBearer({
      url: withNewK1(
        base.url,
        settled.k1,
        settled.amountMsat,
        settled.signature
      ),
      callback: settled.callback,
      amount: settled.amountMsat,
      verified: true,
      mintPubkey: base.mintPubkey
    })
  }

  // called right after meltNote locks a note as spent. If the service
  // returned a LUD-25 melt proof, checkPending polls it to confirm
  // settlement and redirects once it does - same as BearerCard's melt, the
  // note stays in the wallet (locked) rather than being removed outright,
  // in case that confirmation never arrives. Without one there's nothing
  // to poll, so this treats the request as done right away: the note was
  // already locked as spent, and BearerCard's "Unspend anyway" remains the
  // way back if it later turns out the payment actually failed
  const finishMelt = (note: Bearer, result: {verify?: string}) => {
    if (result.verify) {
      notify(
        'Payment requested and the note is locked as spent - confirming...',
        NotifyKind.LOADING
      )
      startPolling(note, result.verify)
      return
    }
    logActivity(
      'melt',
      `Melted ${msatToSats(note.amount)} sats from ${serverOf(note.url)} to pay an invoice.`
    )
    notify(
      "Payment requested and the note is locked as spent - this mint doesn't support checking automatically.",
      NotifyKind.SUCCESS
    )
    navigate('/wallet')
  }

  // melts the selected note(s) as-is - only valid once they're already
  // worth exactly the invoice (merged into one first if there's more than
  // one). Per meltNote's own semantics a resolved call only means the
  // payment is in flight, not confirmed spent - see finishMelt for what
  // happens next
  const payInvoice = async () => {
    const invoice = pastedInvoice()
    const picked = selectedBearers()
    if (!invoice || !selectionPayable() || picked.length === 0) return
    setPaying(true)
    try {
      const current = await mergeSelectionIfNeeded(picked)
      let result: MeltResult
      try {
        result = current.deviceId
          ? await deviceMeltRequest(
              requireDeviceClient(deviceClient()),
              current.deviceId,
              current.callback,
              invoice
            )
          : await meltNote(
              current.callback,
              requireNoteK1(current.url),
              invoice
            )
      } catch (err) {
        // this melt names a single note (current), so a NoteSpentError here
        // is unambiguous - it's already gone, lock it the same way a
        // successful melt would have rather than leave it looking spendable
        if (err instanceof NoteSpentError) {
          await updateBearer(current.id, {spent: true})
          logActivity(
            'spent',
            `${serverOf(current.url)} reports ${msatToSats(current.amount)} sats as already spent - marked spent locally.`
          )
        }
        throw err
      }
      await updateBearer(current.id, {spent: true})
      setSelectedIds(new Set<string>())
      finishMelt(current, result)
    } catch (err) {
      notify((err as Error).message, NotifyKind.ERROR)
    } finally {
      setPaying(false)
    }
  }

  // for a selection worth more than the invoice: splits off the exact
  // amount owed directly from every selected note - keeping the remainder
  // as a fresh note - then melts that exact piece, all in one click. Split
  // takes one or many k1s per LUD-25 ("one or many | no | yes"), so this
  // burns the whole selection in a single callback request; no merge round
  // trip first, unlike an exact-amount pay (see payInvoice/meltNote, which
  // only ever takes a single k1 and still needs one)
  const splitAndPay = async () => {
    const invoice = pastedInvoice()
    const picked = selectedBearers()
    const target = invoiceAmountMsat()
    if (!invoice || !selectionNeedsSplit() || target === null) return
    if (picked.length === 0) return
    setPaying(true)
    try {
      const base = picked[0]
      const total = picked.reduce((sum, b) => sum + b.amount, 0)
      const client = deviceClient()
      if (client) {
        const parts = await deviceSplit(
          client,
          picked.map(b => ({deviceId: b.deviceId, url: b.url})),
          base.callback,
          target,
          total
        )
        for (const bearer of picked) removeBearer(bearer.id)
        const settledChange = await deviceSettle(client, parts.change)
        await addBearer({
          url: settledChange.url,
          callback: settledChange.callback,
          amount: settledChange.amountMsat,
          verified: true,
          mintPubkey: base.mintPubkey,
          deviceId: settledChange.deviceId
        })
        const spend = await addBearer({
          url: parts.target.url,
          callback: parts.target.callback,
          amount: target,
          verified: true,
          mintPubkey: base.mintPubkey,
          deviceId: parts.target.deviceId
        })
        let result: MeltResult
        try {
          result = await deviceMeltRequest(
            client,
            parts.target.deviceId,
            spend.callback,
            invoice
          )
        } catch (err) {
          if (err instanceof NoteSpentError) {
            await updateBearer(spend.id, {spent: true})
            logActivity(
              'spent',
              `${serverOf(spend.url)} reports ${msatToSats(spend.amount)} sats as already spent - marked spent locally.`
            )
          }
          throw err
        }
        await updateBearer(spend.id, {spent: true})
        setSelectedIds(new Set<string>())
        finishMelt(spend, result)
        return
      }
      const parts = await splitNote(
        base.callback,
        picked.map(b => requireNoteK1(b.url)),
        target
      )
      for (const bearer of picked) removeBearer(bearer.id)
      // settleNote: the change may be worth less than total - target if
      // this mint charges fees (LUD-25 deducts them from change, never the
      // melted amount) - stored at its true value, not the naive pre-fee
      // one, or its signature won't verify against it
      const settledChange = await settleNote(
        base.url,
        parts.change,
        total - target,
        parts.changeSignature
      )
      await addBearer({
        url: withNewK1(
          base.url,
          settledChange.k1,
          settledChange.amountMsat,
          settledChange.signature
        ),
        callback: settledChange.callback,
        amount: settledChange.amountMsat,
        verified: true,
        mintPubkey: base.mintPubkey
      })
      const spend = await addBearer({
        url: withNewK1(base.url, parts.k1, target, parts.signature),
        callback: base.callback,
        amount: target,
        verified: true,
        mintPubkey: base.mintPubkey
      })
      let result: MeltResult
      try {
        result = await meltNote(
          spend.callback,
          requireNoteK1(spend.url),
          invoice
        )
      } catch (err) {
        if (err instanceof NoteSpentError) {
          await updateBearer(spend.id, {spent: true})
          logActivity(
            'spent',
            `${serverOf(spend.url)} reports ${msatToSats(spend.amount)} sats as already spent - marked spent locally.`
          )
        }
        throw err
      }
      await updateBearer(spend.id, {spent: true})
      setSelectedIds(new Set<string>())
      finishMelt(spend, result)
    } catch (err) {
      notify((err as Error).message, NotifyKind.ERROR)
    } finally {
      setPaying(false)
    }
  }

  return (
    <RequireWallet>
      <div id="melt" class="page">
        <h2>Melt - pay an invoice with a bearer note</h2>
        <figure class="paste-widget">
          <div class="paste-input-row">
            <ScanToggle
              onScan={onScan}
              accept={v => isBolt11Invoice(v) || isLightningAddress(v)}
            />
            <button
              type="button"
              class="icon-btn paste-icon-btn"
              title="Paste from clipboard"
              onClick={paste}
            >
              <IoClipboardSharp />
            </button>
            <div class="paste-input-wrapper">
              <input
                ref={pasteRef}
                type="text"
                class="paste-input"
                classList={{invalid: value() !== '' && !isValid()}}
                placeholder="lnbc1... or user@example.com"
                value={value()}
                onInput={e => setValue(e.currentTarget.value)}
                onKeyDown={onKeydown}
              />
              <Show when={value() !== ''}>
                <button
                  type="button"
                  class="icon-btn paste-clear-btn"
                  title="Clear"
                  onClick={() => setValue('')}
                >
                  <IoCloseSharp />
                </button>
              </Show>
            </div>
            <button
              type="button"
              class="icon-btn paste-confirm-btn"
              title={offlineMode() ? 'Offline mode is on' : 'Continue'}
              disabled={
                value() === '' ||
                !isValid() ||
                fetchingInvoice() ||
                offlineMode()
              }
              onClick={handle}
            >
              <Show
                when={fetchingInvoice()}
                fallback={<IoReturnDownForwardSharp />}
              >
                <IoRefreshSharp class="spin" />
              </Show>
            </button>
          </div>
          <Show when={value() !== '' && !isValid()}>
            <p class="warning">
              Not a valid bolt11 invoice or Lightning Address.
            </p>
          </Show>
          <Show when={lnAddressPayRequest()}>
            {info => (
              <div class="form-item">
                <label>
                  Amount (sats, {msatToSats(info().minSendable)} -{' '}
                  {msatToSats(info().maxSendable)})
                </label>
                <input
                  type="number"
                  min="1"
                  placeholder="amount in sats"
                  value={lnAddressAmountSats()}
                  onInput={e => setLnAddressAmountSats(e.currentTarget.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      if (!fetchingInvoice() && !offlineMode())
                        getInvoiceFromAddress()
                    }
                  }}
                />
                <div class="btns">
                  <button
                    disabled={fetchingInvoice() || offlineMode()}
                    onClick={getInvoiceFromAddress}
                  >
                    <Show when={fetchingInvoice()}>
                      <IoRefreshSharp class="spin" />
                      &nbsp;
                    </Show>
                    Get invoice
                  </button>
                  <button onClick={() => setLnAddressPayRequest(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </Show>
        </figure>
        <Show when={storeableMeltAddresses().length > 0}>
          <figure class="setup-card">
            <h4>Your saved addresses</h4>
            <p>
              These said their own address is meant to be reused, not a one-time
              link (LUD-11) - saved here for a one-click return trip. Melt
              destinations only, kept separate from the mints on the Mint page.
            </p>
            <div class="mint-picker">
              <For each={storeableMeltAddresses()}>
                {link => (
                  <span class="mint-picker-entry">
                    <button
                      disabled={offlineMode()}
                      onClick={() => selectSavedAddress(link.address)}
                    >
                      {link.address}
                    </button>
                    <button
                      class="icon-btn"
                      title="Forget this address"
                      onClick={() => removeStoreableMeltAddress(link.address)}
                    >
                      <IoTrashSharp />
                    </button>
                  </span>
                )}
              </For>
            </div>
          </figure>
        </Show>
        <Show when={pastedInvoice()}>
          <Show
            when={!pendingNote()}
            fallback={
              <figure class="setup-card">
                <figcaption>Confirming payment</figcaption>
                <p class="bearer-hint">
                  Checking the mint's own melt proof (LUD-25) for this payment -
                  once it reports the outgoing payment settled, the note is
                  confirmed gone for good.
                </p>
                <div class="btns">
                  <button
                    disabled={checkingPending() || offlineMode()}
                    onClick={manualCheckPending}
                  >
                    <Show when={checkingPending()}>
                      <IoRefreshSharp class="spin" />
                      &nbsp;
                    </Show>
                    {checkingPending()
                      ? 'Checking...'
                      : `Check payment (${secondsLeft()}s)`}
                  </button>
                </div>
              </figure>
            }
          >
            <figure class="setup-card">
              <figcaption>Pay with your bearer notes</figcaption>
              <Show
                when={invoiceAmountMsat() !== null}
                fallback={
                  <p class="bearer-hint">
                    Couldn't read an amount from this invoice - select note(s)
                    from one mint and the service will judge whether they cover
                    it.
                  </p>
                }
              >
                <p class="bearer-hint">
                  Wants {msatToSats(invoiceAmountMsat()!)} sats - select note(s)
                  from one mint worth at least that. Melt only spends a note of
                  exactly the invoice amount, so an exact match pays directly
                  and anything over it needs Split and pay first.
                </p>
              </Show>
              <Show
                when={unspentBearers().length > 0}
                fallback={<p>No bearer notes to pay with yet.</p>}
              >
                <For each={groupByServer(unspentBearers())}>
                  {([server, group]) => {
                    // same mint for the whole group, so the same node color
                    // (if any's cached) applies to every note in it - see
                    // BearerCard's own noteColor for the tinting itself
                    const noteColor = () => getTrustedMintNodeColor(server)
                    return (
                      <div class="form-item">
                        <label>{server}</label>
                        <div class="bearer-list">
                          <For each={group}>
                            {bearer => (
                              <figure
                                class="bearer-card"
                                classList={{tinted: !!noteColor()}}
                                style={
                                  noteColor()
                                    ? {'--note-tint': noteColor()!}
                                    : undefined
                                }
                              >
                                <div class="bearer-head">
                                  <label class="bearer-select">
                                    <input
                                      type="checkbox"
                                      checked={selectedIds().has(bearer.id)}
                                      disabled={!bearer.callback}
                                      onChange={e =>
                                        toggleSelect(
                                          bearer.id,
                                          e.currentTarget.checked
                                        )
                                      }
                                    />
                                  </label>
                                  <div
                                    class="bearer-title clickable"
                                    onClick={() =>
                                      bearer.callback &&
                                      toggleSelect(
                                        bearer.id,
                                        !selectedIds().has(bearer.id)
                                      )
                                    }
                                  >
                                    <span class="bearer-amount">
                                      {msatToSats(bearer.amount)} sats
                                    </span>
                                    <Show when={!bearer.callback}>
                                      <span class="bearer-pending">
                                        unverified
                                      </span>
                                    </Show>
                                  </div>
                                </div>
                              </figure>
                            )}
                          </For>
                        </div>
                      </div>
                    )
                  }}
                </For>
              </Show>
              <Show when={selectedBearers().length > 0}>
                <p class="bearer-hint">
                  Selected {msatToSats(selectedTotal())} sats
                  <Show when={!selectionPayable() && !selectionNeedsSplit()}>
                    {' '}
                    - not enough selected yet, or spans more than one mint
                  </Show>
                </p>
              </Show>
              <div class="btns">
                <Show
                  when={selectionNeedsSplit()}
                  fallback={
                    <button
                      disabled={
                        paying() || !selectionPayable() || offlineMode()
                      }
                      onClick={payInvoice}
                    >
                      <Show when={paying()}>
                        <IoRefreshSharp class="spin" />
                        &nbsp;
                      </Show>
                      Pay invoice
                    </button>
                  }
                >
                  <button
                    disabled={paying() || offlineMode()}
                    onClick={splitAndPay}
                  >
                    <Show when={paying()}>
                      <IoRefreshSharp class="spin" />
                      &nbsp;
                    </Show>
                    Split and pay
                  </button>
                </Show>
                <button onClick={clearInvoice}>Clear</button>
              </div>
            </figure>
          </Show>
        </Show>
        <h2>Manually send out bearers</h2>
        <Show
          when={unspentBearers().length > 0}
          fallback={<p>No bearer notes to send yet.</p>}
        >
          <For each={groupByServer(unspentBearers())}>
            {([server, group]) => (
              <div class="form-item">
                <label>{server}</label>
                <div class="bearer-list">
                  <For each={group}>
                    {bearer => <SendNoteCard bearer={bearer} />}
                  </For>
                </div>
              </div>
            )}
          </For>
        </Show>
      </div>
    </RequireWallet>
  )
}
export default Melt
