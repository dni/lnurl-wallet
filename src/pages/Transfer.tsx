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
import {useDevice} from '../DeviceContext'
import {
  isValidNoteInput,
  isBolt11Invoice,
  requireNoteK1,
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
  deviceMerge,
  deviceSplit,
  deviceSettle,
  deviceReceive,
  deviceExportForHandoff,
  deviceMarkSpent,
  requireDeviceClient
} from '../deviceOrchestration'
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
  const {client: deviceClient} = useDevice()
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
  // the prepared note's real, secret-bearing url - null until revealed.
  // For a browser-only note this is available the instant it's prepared
  // (see stagePrepared); a device-backed one needs an explicit export
  // (physical button press) first - see revealPrepared. Never persisted,
  // only ever held here in memory.
  const [revealedUrl, setRevealedUrl] = createSignal<string | null>(null)
  const [revealing, setRevealing] = createSignal(false)

  // stages a note as "ready to hand over" - browser-only notes reveal
  // immediately (their url already carries the real secret); device-backed
  // ones wait for an explicit reveal action
  const stagePrepared = (bearer: Bearer) => {
    setPreparedBearer(bearer)
    setRevealedUrl(bearer.deviceId ? null : bearer.url)
  }

  const revealPrepared = async () => {
    const bearer = preparedBearer()
    if (!bearer?.deviceId) return
    setRevealing(true)
    try {
      const client = requireDeviceClient(deviceClient())
      const {url} = await deviceExportForHandoff(
        client,
        bearer.deviceId,
        bearer.url,
        bearer.amount
      )
      setRevealedUrl(url)
    } catch (err) {
      notify((err as Error).message, NotifyKind.ERROR)
    } finally {
      setRevealing(false)
    }
  }

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
  // be handed over - just show what's already there. For a device-backed
  // note "what's already there" still needs an explicit reveal (see
  // revealPrepared) - stagePrepared leaves that gated rather than exporting
  // it right away just because it was selected
  const unveilSelectedNow = () => {
    const picked = prepareSelectedBearers()
    if (picked.length !== 1) return
    stagePrepared(picked[0])
    setPrepareSelectedIds(new Set<string>())
    setPrepareAmountSats('')
  }

  // a no-op returning the note itself when only one is selected, since
  // merge only makes sense for 2+. settleNote reads the actual value back
  // (a mint MAY refund part of its fees on merge - LUD-25) and rotates the
  // merged secret, since learning that value necessarily puts it on the
  // wire. If a vault is connected, the merged note lands there instead -
  // regardless of whether any of the inputs were themselves device-backed
  // (mixed selections are fine, see deviceOrchestration.ts)
  const mergePrepareSelectionIfNeeded = async (
    picked: ReturnType<typeof prepareSelectedBearers>
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

  // when the selection is worth more than target, splits off the exact
  // amount directly from every selected note in one request - split takes
  // one or many k1s per LUD-25, so no merge round trip first. Only an exact
  // match (no split needed) still goes through mergePrepareSelectionIfNeeded.
  // Same device-connected branch as Melt.tsx's splitAndPay: both outputs
  // land on the vault when one's connected, regardless of input custody.
  const prepareNote = async () => {
    const picked = prepareSelectedBearers()
    const target = prepareAmountMsat()
    if (!canPrepare() || target === null) return
    setPreparing(true)
    try {
      const total = prepareSelectedTotal()
      const client = deviceClient()
      let current: Bearer
      if (total > target && client) {
        const base = picked[0]
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
        current = await addBearer({
          url: parts.target.url,
          callback: parts.target.callback,
          amount: target,
          verified: true,
          mintPubkey: base.mintPubkey,
          deviceId: parts.target.deviceId
        })
      } else if (total > target) {
        const base = picked[0]
        const parts = await splitNote(
          base.callback,
          picked.map(b => requireNoteK1(b.url)),
          target
        )
        for (const bearer of picked) removeBearer(bearer.id)
        // settleNote: the change may be worth less than total - target if
        // this mint charges fees (LUD-25 deducts them from change, never
        // the prepared amount) - stored at its true value, not the naive
        // pre-fee one, or its signature won't verify
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
        current = await addBearer({
          url: withNewK1(base.url, parts.k1, target, parts.signature),
          callback: base.callback,
          amount: target,
          verified: true,
          mintPubkey: base.mintPubkey
        })
      } else {
        current = await mergePrepareSelectionIfNeeded(picked)
      }
      stagePrepared(current)
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
      // old secret until it is burned. If a vault is connected, that fresh
      // secret is generated and held there instead of in this browser.
      try {
        const client = deviceClient()
        if (client) {
          const result = await deviceReceive(
            client,
            received.url,
            received.callback,
            serverOf(received.url),
            requireNoteK1(received.url),
            received.amount
          )
          await updateBearer(bearer.id, {
            url: result.url,
            callback: result.callback,
            deviceId: result.deviceId
          })
        } else {
          const url = await secureReceivedNote(received)
          await updateBearer(bearer.id, {url})
        }
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
            <Show
              when={revealedUrl()}
              fallback={
                <div class="btns">
                  <button disabled={revealing()} onClick={revealPrepared}>
                    <Show when={revealing()}>
                      <IoRefreshSharp class="spin" />
                      &nbsp;
                    </Show>
                    {revealing()
                      ? 'Waiting for the vault...'
                      : 'Reveal to hand over'}
                  </button>
                </div>
              }
            >
              {url => (
                <>
                  <Qr value={toBech32Lnurl(url())} />
                  <div class="btns">
                    <button
                      onClick={() => copyToClipboard(toBech32Lnurl(url()))}
                    >
                      <IoCopySharp />
                      &nbsp;Copy note
                    </button>
                    <button
                      onClick={async () => {
                        const handedOver = preparedBearer()!
                        updateBearer(handedOver.id, {spent: true})
                        if (handedOver.deviceId) {
                          const client = deviceClient()
                          if (client) {
                            await deviceMarkSpent(client, handedOver.deviceId)
                          }
                        }
                        setPreparedBearer(null)
                        setRevealedUrl(null)
                        logActivity(
                          'transfer',
                          `Handed over ${msatToSats(handedOver.amount)} sats from ${serverOf(handedOver.url)}.`
                        )
                        notify(
                          'Marked as handed over and spent.',
                          NotifyKind.SUCCESS
                        )
                      }}
                    >
                      Done
                    </button>
                  </div>
                </>
              )}
            </Show>
          </figure>
        </Show>
      </div>
    </RequireWallet>
  )
}
export default Transfer
