import type {Component} from 'solid-js'
import {Show, For, createSignal, createMemo, onMount} from 'solid-js'
import {useNavigate, useSearchParams} from '@solidjs/router'
import {
  IoClipboardSharp,
  IoCloseSharp,
  IoReturnDownForwardSharp,
  IoCopySharp
} from 'solid-icons/io'

import {useWallet, groupByServer} from '../WalletContext'
import {
  isBolt11Invoice,
  decodeBolt11AmountMsat,
  serverOf,
  noteK1,
  withNewK1,
  meltNote,
  mergeNotes
} from '../lnurlcash'
import {
  notify,
  NotifyKind,
  msatToSats,
  pasteFromClipboard,
  copyToClipboard
} from '../helpers'
import Qr from '../components/Qr'
import RequireWallet from '../components/RequireWallet'

const Melt: Component = () => {
  const {addBearer, removeBearer, bearers} = useWallet()
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
  // melting burns every selected note in one payment (via a merge first if
  // there's more than one), so they must share a service and each must
  // already be verified (callback known)
  const selectionPayable = createMemo(() => {
    const picked = selectedBearers()
    if (picked.length === 0) return false
    const server = serverOf(picked[0].url)
    if (!picked.every(b => serverOf(b.url) === server && b.callback !== ''))
      return false
    // an invoice amount that fails to decode is treated as unknown, not
    // zero - let the service be the judge rather than block on it here
    const amount = invoiceAmountMsat()
    return amount === null || selectedTotal() === amount
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

  // pays the pasted invoice with the selected note(s) - merges them into
  // one first when more than one is selected, since melt only takes a
  // single k1, then melts that note against the invoice. Per meltNote's own
  // semantics a resolved call only means the payment is in flight, not
  // confirmed spent, so - same as BearerCard's melt - the note is left in
  // place rather than assumed gone; refreshing it later confirms the burn
  const payInvoice = async () => {
    const invoice = pastedInvoice()
    const picked = selectedBearers()
    if (!invoice || !selectionPayable() || picked.length === 0) return
    setPaying(true)
    try {
      let payCallback = picked[0].callback
      let payK1 = noteK1(picked[0].url)!
      if (picked.length > 1) {
        const [base] = picked
        const total = selectedTotal()
        const merged = await mergeNotes(
          base.callback,
          picked.map(b => noteK1(b.url)!)
        )
        for (const bearer of picked) removeBearer(bearer.id)
        const newBearer = await addBearer({
          url: withNewK1(base.url, merged.k1, total, merged.signature),
          callback: base.callback,
          amount: total,
          verified: true,
          mintPubkey: base.mintPubkey
        })
        payCallback = newBearer.callback
        payK1 = noteK1(newBearer.url)!
      }
      await meltNote(payCallback, payK1, invoice)
      notify(
        "Payment requested - it's on its way. Refresh the note in a moment to confirm it's gone.",
        NotifyKind.SUCCESS
      )
      clearInvoice()
      navigate('/wallet')
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
            <figcaption>
              Bolt11 invoice - this wallet has no Lightning node of its own, so
              pay it with another wallet, or select bearer note(s) below to pay
              it directly
            </figcaption>
            <Qr value={pastedInvoice()!.toUpperCase()} />
            <div class="btns">
              <button onClick={() => copyToClipboard(pastedInvoice()!)}>
                <IoCopySharp />
                &nbsp;Copy invoice
              </button>
              <button onClick={clearInvoice}>Clear</button>
            </div>
          </figure>
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
                Wants exactly {msatToSats(invoiceAmountMsat()!)} sats - select
                note(s) from one mint that add up to it (2+ get merged into one
                first, since a melt only ever spends a single note).
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
                <Show when={!selectionPayable()}>
                  {' '}
                  - doesn't add up to the invoice yet, or spans more than one
                  mint
                </Show>
              </p>
            </Show>
            <div class="btns">
              <button
                disabled={paying() || !selectionPayable()}
                onClick={payInvoice}
              >
                Pay invoice
              </button>
            </div>
          </figure>
        </Show>
      </div>
    </RequireWallet>
  )
}
export default Melt
