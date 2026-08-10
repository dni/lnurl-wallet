import type {Component} from 'solid-js'
import {Show, For, createSignal, createMemo, onMount, onCleanup} from 'solid-js'
import {useNavigate, useSearchParams} from '@solidjs/router'
import {
  IoClipboardSharp,
  IoCloseSharp,
  IoReturnDownForwardSharp,
  IoRefreshSharp
} from 'solid-icons/io'

import type {Bearer} from '../storage'
import {useWallet, groupByServer} from '../WalletContext'
import type {PayRequestInfo} from '../lnurlcash'
import {
  isBolt11Invoice,
  isLightningAddress,
  resolveMintInput,
  fetchPayRequest,
  requestInvoice,
  decodeBolt11AmountMsat,
  serverOf,
  noteK1,
  withNewK1,
  meltNote,
  mergeNotes,
  splitNote,
  rotateNote,
  PendingNoteError
} from '../lnurlcash'
import {
  notify,
  NotifyKind,
  msatToSats,
  satsToMsat,
  pasteFromClipboard
} from '../helpers'
import {offlineMode} from '../offlineMode'
import ScanToggle from '../components/ScanToggle'
import RequireWallet from '../components/RequireWallet'

// same cadence as Mint.tsx's LUD-21 verify poll - a melted note's fate
// (settled vs failed) is discovered the same way here: try to rotate it
const PENDING_POLL_SECONDS = 5

const Melt: Component = () => {
  const {addBearer, updateBearer, removeBearer, bearers} = useWallet()
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
  const [lnAddressAmountSats, setLnAddressAmountSats] = createSignal('')
  const [fetchingInvoice, setFetchingInvoice] = createSignal(false)

  // set right after a melt is requested - polled by trying to rotate the
  // (locally already spent-locked) note until we learn which way it went
  const [pendingNote, setPendingNote] = createSignal<Bearer | null>(null)
  const [secondsLeft, setSecondsLeft] = createSignal(PENDING_POLL_SECONDS)
  const [checkingPending, setCheckingPending] = createSignal(false)
  let pollTimer: ReturnType<typeof setInterval> | null = null

  const stopPolling = () => {
    if (pollTimer) clearInterval(pollTimer)
    pollTimer = null
  }

  // a melt's {"status":"OK"} only means the payment is in flight (see
  // meltNote) - rotating the note is how its actual fate gets discovered:
  // if the rotate itself SUCCEEDS, the note was still there to burn, so the
  // melt must have failed - unspend it and swap in the fresh secret the
  // rotate just minted. If the rotate FAILS with anything other than
  // "pending" (unknown k1, already spent, ...), the note is genuinely gone,
  // which is exactly what a settled melt looks like from the outside
  const checkPending = async () => {
    const note = pendingNote()
    if (!note || checkingPending()) return
    setCheckingPending(true)
    try {
      const rotated = await rotateNote(note.callback, noteK1(note.url)!)
      stopPolling()
      setPendingNote(null)
      await updateBearer(note.id, {
        url: withNewK1(note.url, rotated.k1, note.amount, rotated.signature),
        spent: false
      })
      setSelectedIds(new Set([note.id]))
      notify(
        'Payment failed - the note is still yours (freshly rotated). Select it again to retry.',
        NotifyKind.ERROR
      )
    } catch (err) {
      if (err instanceof PendingNoteError) return // still in flight - next tick
      stopPolling()
      setPendingNote(null)
      notify('Payment confirmed - the note is gone.', NotifyKind.SUCCESS)
      navigate('/wallet')
    } finally {
      setCheckingPending(false)
    }
  }

  const startPolling = (note: Bearer) => {
    stopPolling()
    setPendingNote(note)
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
  // stops a second concurrent rotate, but on its own that still lets a
  // rapid double-click (or a click landing right as the automatic tick was
  // about to fire) restart the interval twice in a row - guard here too so
  // the whole "check + restart" action only happens once per click
  const manualCheckPending = () => {
    if (checkingPending()) return
    checkPending()
    const note = pendingNote()
    if (note) startPolling(note)
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
    setPastedInvoice(null)
    setSelectedIds(new Set<string>())
  }

  // merges the selection into one note worth their sum - a no-op returning
  // the note itself when only one is selected, since merge only makes
  // sense for 2+
  const mergeSelectionIfNeeded = async (
    picked: ReturnType<typeof selectedBearers>
  ) => {
    if (picked.length === 1) return picked[0]
    const base = picked[0]
    const total = picked.reduce((sum, b) => sum + b.amount, 0)
    const merged = await mergeNotes(
      base.callback,
      picked.map(b => noteK1(b.url)!)
    )
    for (const bearer of picked) removeBearer(bearer.id)
    return addBearer({
      url: withNewK1(base.url, merged.k1, total, merged.signature),
      callback: base.callback,
      amount: total,
      verified: true,
      mintPubkey: base.mintPubkey
    })
  }

  // melts the selected note(s) as-is - only valid once they're already
  // worth exactly the invoice (merged into one first if there's more than
  // one). Per meltNote's own semantics a resolved call only means the
  // payment is in flight, not confirmed spent, so - same as BearerCard's
  // melt - the note is left in the wallet rather than removed, but locked
  // as spent so it can't be acted on again out from under it. checkPending
  // then polls to find out how it actually went and redirects once it does
  const payInvoice = async () => {
    const invoice = pastedInvoice()
    const picked = selectedBearers()
    if (!invoice || !selectionPayable() || picked.length === 0) return
    setPaying(true)
    try {
      const current = await mergeSelectionIfNeeded(picked)
      await meltNote(current.callback, noteK1(current.url)!, invoice)
      await updateBearer(current.id, {spent: true})
      setSelectedIds(new Set<string>())
      notify(
        'Payment requested and the note is locked as spent - confirming...',
        NotifyKind.LOADING
      )
      startPolling(current)
    } catch (err) {
      notify((err as Error).message, NotifyKind.ERROR)
    } finally {
      setPaying(false)
    }
  }

  // for a selection worth more than the invoice: merges it into one note
  // (if needed), splits off the exact amount owed - keeping the remainder
  // as a fresh note - then melts that exact piece, all in one click
  const splitAndPay = async () => {
    const invoice = pastedInvoice()
    const picked = selectedBearers()
    const target = invoiceAmountMsat()
    if (!invoice || !selectionNeedsSplit() || target === null) return
    if (picked.length === 0) return
    setPaying(true)
    try {
      const merged = await mergeSelectionIfNeeded(picked)
      const parts = await splitNote(
        merged.callback,
        noteK1(merged.url)!,
        target
      )
      removeBearer(merged.id)
      await addBearer({
        url: withNewK1(
          merged.url,
          parts.change,
          merged.amount - target,
          parts.changeSignature
        ),
        callback: merged.callback,
        amount: merged.amount - target,
        verified: true,
        mintPubkey: merged.mintPubkey
      })
      const spend = await addBearer({
        url: withNewK1(merged.url, parts.k1, target, parts.signature),
        callback: merged.callback,
        amount: target,
        verified: true,
        mintPubkey: merged.mintPubkey
      })
      await meltNote(spend.callback, noteK1(spend.url)!, invoice)
      await updateBearer(spend.id, {spent: true})
      setSelectedIds(new Set<string>())
      notify(
        'Payment requested and the note is locked as spent - confirming...',
        NotifyKind.LOADING
      )
      startPolling(spend)
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
        <Show when={pastedInvoice()}>
          <Show
            when={!pendingNote()}
            fallback={
              <figure class="setup-card">
                <figcaption>Confirming payment</figcaption>
                <p class="bearer-hint">
                  Trying to rotate the locked note to find out what happened:
                  succeeding means it's still yours (the payment failed) -
                  anything else means the service already burned it.
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
                when={bearers().length > 0}
                fallback={<p>No bearer notes to pay with yet.</p>}
              >
                <For each={groupByServer(bearers())}>
                  {([server, group]) => (
                    <div class="form-item">
                      <label>{server}</label>
                      <For each={group}>
                        {bearer => (
                          <label>
                            <input
                              type="checkbox"
                              checked={selectedIds().has(bearer.id)}
                              disabled={!bearer.callback || bearer.spent}
                              onChange={e =>
                                toggleSelect(bearer.id, e.currentTarget.checked)
                              }
                            />
                            &nbsp;{msatToSats(bearer.amount)} sats
                            <Show when={bearer.spent}>&nbsp;(spent)</Show>
                            <Show when={!bearer.callback && !bearer.spent}>
                              &nbsp;(not verified yet)
                            </Show>
                          </label>
                        )}
                      </For>
                    </div>
                  )}
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
      </div>
    </RequireWallet>
  )
}
export default Melt
