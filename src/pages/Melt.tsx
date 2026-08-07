import type {Component} from 'solid-js'
import {Show, For, createSignal, createMemo, onMount} from 'solid-js'
import {useSearchParams} from '@solidjs/router'
import {
  IoClipboardSharp,
  IoCloseSharp,
  IoReturnDownForwardSharp,
  IoRefreshSharp
} from 'solid-icons/io'

import {useWallet, groupByServer} from '../WalletContext'
import {
  isBolt11Invoice,
  decodeBolt11AmountMsat,
  serverOf,
  noteK1,
  withNewK1,
  meltNote,
  mergeNotes,
  splitNote
} from '../lnurlcash'
import {notify, NotifyKind, msatToSats, pasteFromClipboard} from '../helpers'
import RequireWallet from '../components/RequireWallet'

const Melt: Component = () => {
  const {addBearer, removeBearer, bearers} = useWallet()
  const [searchParams] = useSearchParams()
  let pasteRef: HTMLInputElement | null = null

  const [value, setValue] = createSignal('')
  // this wallet has no Lightning node of its own, so paying an invoice here
  // means spending it out of a held bearer note - melt only ever takes a
  // single k1, so 2+ selected notes get merged into one first
  const [pastedInvoice, setPastedInvoice] = createSignal<string | null>(null)
  const [selectedIds, setSelectedIds] = createSignal<Set<string>>(new Set())
  const [paying, setPaying] = createSignal(false)

  // arriving from Paste.tsx's own bolt11 detection, invoice carried as a
  // query param rather than duplicating this whole dialog there
  onMount(() => {
    const pr = searchParams.pr
    if (typeof pr === 'string' && isBolt11Invoice(pr)) {
      setPastedInvoice(pr.trim())
    }
  })

  const isValid = createMemo(() => value() === '' || isBolt11Invoice(value()))

  const handle = () => {
    if (value() === '') return
    if (!isBolt11Invoice(value())) {
      notify('Not a valid bolt11 invoice.', NotifyKind.ERROR)
      return
    }
    setPastedInvoice(value().trim())
    setValue('')
  }

  const paste = async () => {
    const text = await pasteFromClipboard()
    if (text !== null) {
      setValue(text)
      pasteRef?.focus()
      handle()
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
  // so every selected note must come from the same service and already be
  // verified (callback known) before either action is allowed
  const selectionValid = createMemo(() => {
    const picked = selectedBearers()
    if (picked.length === 0) return false
    const server = serverOf(picked[0].url)
    return picked.every(b => serverOf(b.url) === server && b.callback !== '')
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
  // melt - the spent note is left in place rather than assumed gone;
  // refreshing it later confirms the burn. The invoice itself is kept on
  // screen rather than cleared, so its outcome stays visible
  const payInvoice = async () => {
    const invoice = pastedInvoice()
    const picked = selectedBearers()
    if (!invoice || !selectionPayable() || picked.length === 0) return
    setPaying(true)
    try {
      const current = await mergeSelectionIfNeeded(picked)
      await meltNote(current.callback, noteK1(current.url)!, invoice)
      notify(
        "Payment requested - it's on its way. Refresh the note in a moment to confirm it's gone.",
        NotifyKind.SUCCESS
      )
      setSelectedIds(new Set<string>())
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
      notify(
        "Payment requested - it's on its way. Refresh the note in a moment to confirm it's gone.",
        NotifyKind.SUCCESS
      )
      setSelectedIds(new Set<string>())
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
                placeholder="lnbc1..."
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
              title="Show invoice"
              disabled={value() === '' || !isValid()}
              onClick={handle}
            >
              <IoReturnDownForwardSharp />
            </button>
          </div>
          <Show when={value() !== '' && !isValid()}>
            <p class="warning">Not a valid bolt11 invoice.</p>
          </Show>
        </figure>
        <Show when={pastedInvoice()}>
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
                exactly the invoice amount, so an exact match pays directly and
                anything over it needs Split and pay first.
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
                            disabled={!bearer.callback}
                            onChange={e =>
                              toggleSelect(bearer.id, e.currentTarget.checked)
                            }
                          />
                          &nbsp;{msatToSats(bearer.amount)} sats
                          <Show when={!bearer.callback}>
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
                    disabled={paying() || !selectionPayable()}
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
                <button disabled={paying()} onClick={splitAndPay}>
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
      </div>
    </RequireWallet>
  )
}
export default Melt
