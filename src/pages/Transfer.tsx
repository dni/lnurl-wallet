import type {Component} from 'solid-js'
import {Show, For, createSignal, createMemo} from 'solid-js'
import {useNavigate} from '@solidjs/router'
import {
  IoClipboardSharp,
  IoCloseSharp,
  IoReturnDownForwardSharp,
  IoRefreshSharp,
  IoCopySharp,
  IoEyeSharp
} from 'solid-icons/io'

import type {Bearer} from '../storage'
import {useWallet, groupByServer} from '../WalletContext'
import {
  isValidNoteInput,
  isBolt11Invoice,
  noteK1,
  withNewK1,
  mergeNotes,
  splitNote,
  settleNote,
  toBech32Lnurl,
  serverOf,
  PendingNoteError
} from '../lnurlcash'
import {receiveNote, secureReceivedNote} from '../receive'
import {
  notify,
  NotifyKind,
  msatToSats,
  satsToMsat,
  pasteFromClipboard,
  copyToClipboard
} from '../helpers'
import {offlineMode} from '../offlineMode'
import ScanToggle from '../components/ScanToggle'
import Qr from '../components/Qr'
import RequireWallet from '../components/RequireWallet'

// bringing a note into this wallet, scanned or pasted - same destination
// either way, so one page covers both instead of sending the holder to
// pick an input method up front
const Transfer: Component = () => {
  const {addBearer, updateBearer, removeBearer, bearers, logActivity} =
    useWallet()
  const navigate = useNavigate()
  let pasteRef: HTMLInputElement | null = null
  const [value, setValue] = createSignal('')
  const [busy, setBusy] = createSignal(false)

  // prepare-a-note: carve an exact amount out of one or more held notes
  // (merging and/or splitting as needed) into a single fresh note, ready to
  // hand over - a merge/split response is a secret that's never been shown
  // anywhere yet, so unlike a note you've been holding a while, this one
  // needs no separate rotate step before it's safe to reveal
  const [prepareAmountSats, setPrepareAmountSats] = createSignal('')
  const [prepareSelectedIds, setPrepareSelectedIds] = createSignal<Set<string>>(
    new Set()
  )
  const [preparing, setPreparing] = createSignal(false)
  const [preparedBearer, setPreparedBearer] = createSignal<Bearer | null>(null)

  const prepareAmountMsat = createMemo(() => {
    const msat = satsToMsat(prepareAmountSats())
    return prepareAmountSats() && Number.isFinite(msat) && msat > 0
      ? msat
      : null
  })
  const prepareSelectedBearers = createMemo(() =>
    bearers().filter(b => prepareSelectedIds().has(b.id))
  )
  const prepareSelectedTotal = createMemo(() =>
    prepareSelectedBearers().reduce((sum, b) => sum + b.amount, 0)
  )
  // merging (and, if needed, splitting) burns notes and mints replacements,
  // so every selected note must come from the same service and already be
  // verified (callback known)
  const prepareSelectionValid = createMemo(() => {
    const picked = prepareSelectedBearers()
    if (picked.length === 0) return false
    const server = serverOf(picked[0].url)
    return picked.every(
      b => serverOf(b.url) === server && b.callback !== '' && !b.spent
    )
  })
  const canPrepare = createMemo(() => {
    if (!prepareSelectionValid()) return false
    const target = prepareAmountMsat()
    return target !== null && prepareSelectedTotal() >= target
  })

  const togglePrepareSelect = (id: string, isSelected: boolean) => {
    setPrepareSelectedIds(prev => {
      const next = new Set(prev)
      if (isSelected) next.add(id)
      else next.delete(id)
      return next
    })
  }

  // a single selected note needs no merge/split (and no amount typed in) to
  // be handed over - just show what's already there
  const unveilSelectedNow = () => {
    const picked = prepareSelectedBearers()
    if (picked.length !== 1) return
    setPreparedBearer(picked[0])
    setPrepareSelectedIds(new Set<string>())
    setPrepareAmountSats('')
  }

  // a no-op returning the note itself when only one is selected, since
  // merge only makes sense for 2+. settleNote reads the actual value back
  // (a mint MAY refund part of its fees on merge - LUD-25) and rotates the
  // merged secret, since learning that value necessarily puts it on the
  // wire
  const mergePrepareSelectionIfNeeded = async (
    picked: ReturnType<typeof prepareSelectedBearers>
  ) => {
    if (picked.length === 1) return picked[0]
    const base = picked[0]
    const total = picked.reduce((sum, b) => sum + b.amount, 0)
    const merged = await mergeNotes(
      base.callback,
      picked.map(b => noteK1(b.url)!)
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

  const prepareNote = async () => {
    const picked = prepareSelectedBearers()
    const target = prepareAmountMsat()
    if (!canPrepare() || target === null) return
    setPreparing(true)
    try {
      let current = await mergePrepareSelectionIfNeeded(picked)
      if (current.amount > target) {
        const parts = await splitNote(
          current.callback,
          noteK1(current.url)!,
          target
        )
        removeBearer(current.id)
        // settleNote: the change may be worth less than current.amount -
        // target if this mint charges fees (LUD-25 deducts them from
        // change, never the prepared amount) - stored at its true value,
        // not the naive pre-fee one, or its signature won't verify
        const settledChange = await settleNote(
          current.url,
          parts.change,
          current.amount - target,
          parts.changeSignature
        )
        await addBearer({
          url: withNewK1(
            current.url,
            settledChange.k1,
            settledChange.amountMsat,
            settledChange.signature
          ),
          callback: settledChange.callback,
          amount: settledChange.amountMsat,
          verified: true,
          mintPubkey: current.mintPubkey
        })
        current = await addBearer({
          url: withNewK1(current.url, parts.k1, target, parts.signature),
          callback: current.callback,
          amount: target,
          verified: true,
          mintPubkey: current.mintPubkey
        })
      }
      setPreparedBearer(current)
      setPrepareSelectedIds(new Set<string>())
      setPrepareAmountSats('')
      notify(
        `Prepared a ${msatToSats(target)} sat note - ready to hand over.`,
        NotifyKind.SUCCESS
      )
    } catch (err) {
      notify((err as Error).message, NotifyKind.ERROR)
    } finally {
      setPreparing(false)
    }
  }

  const isValid = createMemo(
    () =>
      value() === '' || isValidNoteInput(value()) || isBolt11Invoice(value())
  )

  // shared by both the scanner and the paste field once they've settled on
  // a valid bearer note
  const receiveIntoWallet = async (noteValue: string) => {
    setBusy(true)
    try {
      const received = await receiveNote(noteValue, bearers())
      const bearer = await addBearer(received)
      setValue('')
      if (!received.verified) {
        notify(
          'Note stored, but its service could not be reached - refresh it later.',
          NotifyKind.LOADING
        )
        navigate('/wallet')
        return
      }
      // rotate immediately: whoever handed this note over still knows the
      // old secret until it is burned
      try {
        const url = await secureReceivedNote(received)
        await updateBearer(bearer.id, {url})
        logActivity(
          'receive',
          `Received ${msatToSats(received.amount)} sats from ${serverOf(received.url)}.`
        )
        notify(
          `Received ${msatToSats(received.amount)} sats - secret rotated, previous copies are burned.`,
          NotifyKind.SUCCESS
        )
      } catch (err) {
        // a PendingNoteError here means this exact k1 has some other
        // operation in flight on the service right now (e.g. the sender's
        // own melt/rotate hasn't settled yet) - temporary, and the note
        // is already stored (addBearer above), so it'll simply rotate on
        // the next refresh. Reporting it the same as every other failure
        // ("the service refused to rotate") reads as a permanent
        // limitation instead of "try again shortly" (see issue #3).
        const pending = err instanceof PendingNoteError
        logActivity(
          'receive',
          `Received ${msatToSats(received.amount)} sats from ${serverOf(received.url)} (${pending ? 'rotate pending - will retry on next refresh' : 'not rotated - sender may still hold a copy'}).`
        )
        notify(
          pending
            ? `Received ${msatToSats(received.amount)} sats, but couldn't rotate yet - this note has another operation in progress on the service. It'll rotate automatically next time you refresh it.`
            : `Received ${msatToSats(received.amount)} sats, but the service refused to rotate - the sender may still hold a spendable copy.`,
          NotifyKind.ERROR
        )
      }
      navigate('/wallet')
    } catch (err) {
      notify((err as Error).message, NotifyKind.ERROR)
    } finally {
      setBusy(false)
    }
  }

  // this wallet has no Lightning node of its own - paying an invoice is its
  // own dialog on the Melt page, reachable from the main nav
  const goToMelt = (pr: string) =>
    navigate(`/melt?pr=${encodeURIComponent(pr.trim())}`)

  // scanning stays bearer-notes-only (a camera pointed at someone else's
  // invoice to pay is an unlikely scenario anyway) - pasting is the one
  // that also takes a bolt11, since that's realistically typed/pasted in
  const onScan = (scanned: string) => receiveIntoWallet(scanned)

  const handlePaste = async () => {
    if (value() === '') return
    if (isBolt11Invoice(value())) {
      goToMelt(value())
      setValue('')
      return
    }
    if (!isValidNoteInput(value())) {
      notify(
        'Not a valid LNURLcash bearer note or bolt11 invoice.',
        NotifyKind.ERROR
      )
      return
    }
    await receiveIntoWallet(value())
  }

  const paste = async () => {
    const text = await pasteFromClipboard()
    if (text !== null) {
      setValue(text)
      pasteRef?.focus()
      handlePaste()
    }
  }

  const onKeydown = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handlePaste()
    }
  }

  return (
    <RequireWallet>
      <div id="transfer" class="page">
        <h2>Bring in a bearer note</h2>
        <figure class="paste-widget">
          <div class="paste-input-row">
            <ScanToggle onScan={onScan} accept={isValidNoteInput} />
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
                placeholder="lnurl1... / lnurlw://...?k1=... / lnbc1..."
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
              title={offlineMode() ? 'Offline mode is on' : 'Add to wallet'}
              disabled={busy() || value() === '' || !isValid() || offlineMode()}
              onClick={handlePaste}
            >
              <Show when={busy()} fallback={<IoReturnDownForwardSharp />}>
                <IoRefreshSharp class="spin" />
              </Show>
            </button>
          </div>
          <Show when={value() !== '' && !isValid()}>
            <p class="warning">
              Not a valid LNURLcash bearer note (an LNURL-withdraw link carrying
              a k1) or bolt11 invoice.
            </p>
          </Show>
        </figure>

        <h2>Prepare a bearer note</h2>
        <figure class="setup-card">
          <figcaption>
            Carve an exact amount out of one or more held notes (merging and/or
            splitting as needed) into a single fresh note, ready to hand over
          </figcaption>
          <label>Amount (sats)</label>
          <input
            type="number"
            min="1"
            placeholder="amount in sats"
            value={prepareAmountSats()}
            onInput={e => setPrepareAmountSats(e.currentTarget.value)}
          />
          <Show when={prepareAmountMsat() !== null}>
            <Show
              when={bearers().length > 0}
              fallback={<p>No bearer notes to prepare from yet.</p>}
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
                            checked={prepareSelectedIds().has(bearer.id)}
                            disabled={!bearer.callback || bearer.spent}
                            onChange={e =>
                              togglePrepareSelect(
                                bearer.id,
                                e.currentTarget.checked
                              )
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
            <Show when={prepareSelectedBearers().length > 0}>
              <p class="bearer-hint">
                Selected {msatToSats(prepareSelectedTotal())} sats
                <Show when={!canPrepare()}>
                  {' '}
                  - not enough selected yet, or spans more than one mint
                </Show>
              </p>
            </Show>
            <div class="btns">
              <Show when={prepareSelectedBearers().length === 1}>
                <button onClick={unveilSelectedNow}>
                  <IoEyeSharp />
                  &nbsp;Unveil now
                </button>
              </Show>
              <button
                disabled={!canPrepare() || preparing() || offlineMode()}
                onClick={prepareNote}
              >
                <Show when={preparing()}>
                  <IoRefreshSharp class="spin" />
                  &nbsp;
                </Show>
                Prepare note
              </button>
            </div>
          </Show>
        </figure>
        <Show when={preparedBearer()}>
          <figure class="setup-card">
            <figcaption>
              Ready to hand over - {msatToSats(preparedBearer()!.amount)} sats
            </figcaption>
            <Qr value={toBech32Lnurl(preparedBearer()!.url)} />
            <div class="btns">
              <button
                onClick={() =>
                  copyToClipboard(toBech32Lnurl(preparedBearer()!.url))
                }
              >
                <IoCopySharp />
                &nbsp;Copy note
              </button>
              <button
                onClick={() => {
                  const handedOver = preparedBearer()!
                  updateBearer(handedOver.id, {spent: true})
                  setPreparedBearer(null)
                  logActivity(
                    'transfer',
                    `Handed over ${msatToSats(handedOver.amount)} sats from ${serverOf(handedOver.url)}.`
                  )
                  notify('Marked as handed over and spent.', NotifyKind.SUCCESS)
                }}
              >
                Done
              </button>
            </div>
          </figure>
        </Show>
      </div>
    </RequireWallet>
  )
}
export default Transfer
