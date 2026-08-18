import type {Component} from 'solid-js'
import {Show, For, createSignal, createMemo} from 'solid-js'
import {IoRefreshSharp, IoCopySharp, IoEyeSharp} from 'solid-icons/io'

import type {Bearer} from '../storage'
import {useWallet, groupByServer} from '../WalletContext'
import {useDevice} from '../DeviceContext'
import {
  requireNoteK1,
  withNewK1,
  mergeNotes,
  splitNote,
  settleNote,
  toBech32Lnurl,
  serverOf
} from '../lnurlcash'
import {
  deviceMerge,
  deviceSplit,
  deviceSettle,
  deviceExportForHandoff,
  deviceMarkSpent,
  requireDeviceClient
} from '../deviceOrchestration'
import {
  notify,
  NotifyKind,
  msatToSats,
  satsToMsat,
  copyToClipboard
} from '../helpers'
import {offlineMode} from '../offlineMode'
import Qr from './Qr'

export type SendDialogProps = {
  onClose: () => void
}

// carve an exact amount out of one or more held notes (merging and/or
// splitting as needed) into a single fresh note, ready to hand over
const SendDialog: Component<SendDialogProps> = props => {
  const {addBearer, updateBearer, removeBearer, bearers, logActivity} =
    useWallet()
  const {client: deviceClient} = useDevice()

  const [amountSats, setAmountSats] = createSignal('')
  const [selectedIds, setSelectedIds] = createSignal<Set<string>>(new Set())
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

  const amountMsat = createMemo(() => {
    const msat = satsToMsat(amountSats())
    return amountSats() && Number.isFinite(msat) && msat > 0 ? msat : null
  })
  // only notes that could actually carve this amount off on their own are
  // worth showing at all - a spent note is gone for good, and one smaller
  // than the target can never be picked toward it (this dialog carves an
  // amount down out of notes, it never tops several small ones up to reach
  // a bigger target)
  const eligibleBearers = createMemo(() => {
    const target = amountMsat()
    if (target === null) return []
    return bearers().filter(b => !b.spent && b.amount >= target)
  })
  // filtered against eligibleBearers, not the raw bearers() list, so a note
  // that falls out of eligibility (the amount was edited up after it was
  // checked) drops out of the selection too, instead of staying counted
  // toward selectedTotal while no longer even shown to uncheck
  const selectedBearers = createMemo(() =>
    eligibleBearers().filter(b => selectedIds().has(b.id))
  )
  const selectedTotal = createMemo(() =>
    selectedBearers().reduce((sum, b) => sum + b.amount, 0)
  )
  // merging (and, if needed, splitting) burns notes and mints replacements,
  // so every selected note must come from the same service and already be
  // verified (callback known)
  const selectionValid = createMemo(() => {
    const picked = selectedBearers()
    if (picked.length === 0) return false
    const server = serverOf(picked[0].url)
    return picked.every(
      b => serverOf(b.url) === server && b.callback !== '' && !b.spent
    )
  })
  const canPrepare = createMemo(() => {
    if (!selectionValid()) return false
    const target = amountMsat()
    return target !== null && selectedTotal() >= target
  })

  const toggleSelect = (id: string, isSelected: boolean) => {
    setSelectedIds(prev => {
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
    const picked = selectedBearers()
    if (picked.length !== 1) return
    stagePrepared(picked[0])
    setSelectedIds(new Set<string>())
    setAmountSats('')
  }

  // a no-op returning the note itself when only one is selected, since
  // merge only makes sense for 2+. settleNote reads the actual value back
  // (a mint MAY refund part of its fees on merge - LUD-25) and rotates the
  // merged secret, since learning that value necessarily puts it on the
  // wire. If a vault is connected, the merged note lands there instead -
  // regardless of whether any of the inputs were themselves device-backed
  // (mixed selections are fine, see deviceOrchestration.ts)
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
      // the mint call inside deviceMerge already burned every input
      // server-side, so the merged output is the only money left - it must
      // end up tracked no matter what fails from here on. Settle first
      // (best-effort), then addBearer BEFORE any removeBearer of an input;
      // a failed settle still tracks a mirror of the raw output
      // (unverified, at its expected pre-fee amount), which the next device
      // refresh can repair
      let settled = merged
      let verified = false
      try {
        settled = await deviceSettle(client, merged)
        verified = true
      } catch (err) {
        notify(
          `Merged, but settling the new note didn't complete (${(err as Error).message}) - it's tracked unverified; refresh it with the vault connected to repair.`,
          NotifyKind.ERROR
        )
      }
      const added = await addBearer({
        url: settled.url,
        callback: settled.callback,
        amount: settled.amountMsat,
        verified,
        mintPubkey: base.mintPubkey,
        deviceId: settled.deviceId
      })
      for (const bearer of picked) removeBearer(bearer.id)
      return added
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
  // match (no split needed) still goes through mergeSelectionIfNeeded.
  // Same device-connected branch as Melt.tsx's splitAndPay: both outputs
  // land on the vault when one's connected, regardless of input custody.
  const prepareNote = async () => {
    const picked = selectedBearers()
    const target = amountMsat()
    if (!canPrepare() || target === null) return
    setPreparing(true)
    try {
      const total = selectedTotal()
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
        // the mint call inside deviceSplit already burned every input
        // server-side - both outputs are the only money left, so both
        // addBearers happen BEFORE any removeBearer of an input, and a
        // failed settle of the change leg still tracks a mirror of the raw
        // output (unverified, at its expected pre-fee amount). The next
        // device refresh repairs the mirror
        let settledChange = parts.change
        let changeVerified = false
        try {
          settledChange = await deviceSettle(client, parts.change)
          changeVerified = true
        } catch (err) {
          notify(
            `Split succeeded, but settling the change note didn't complete (${(err as Error).message}) - it's tracked unverified; refresh it with the vault connected to repair.`,
            NotifyKind.ERROR
          )
        }
        current = await addBearer({
          url: parts.target.url,
          callback: parts.target.callback,
          amount: target,
          verified: true,
          mintPubkey: base.mintPubkey,
          deviceId: parts.target.deviceId
        })
        await addBearer({
          url: settledChange.url,
          callback: settledChange.callback,
          amount: settledChange.amountMsat,
          verified: changeVerified,
          mintPubkey: base.mintPubkey,
          deviceId: settledChange.deviceId
        })
        for (const bearer of picked) removeBearer(bearer.id)
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
        current = await mergeSelectionIfNeeded(picked)
      }
      stagePrepared(current)
      setSelectedIds(new Set<string>())
      setAmountSats('')
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

  return (
    <>
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
          value={amountSats()}
          onInput={e => setAmountSats(e.currentTarget.value)}
        />
        <Show when={amountMsat() !== null}>
          <Show
            when={eligibleBearers().length > 0}
            fallback={
              <p>
                {bearers().length > 0
                  ? 'No unspent notes are big enough to carve that amount out of - try a smaller amount.'
                  : 'No bearer notes to prepare from yet.'}
              </p>
            }
          >
            <For each={groupByServer(eligibleBearers())}>
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
              <Show when={!canPrepare()}>
                {' '}
                - not enough selected yet, or spans more than one mint
              </Show>
            </p>
          </Show>
        </Show>
        <div class="btns">
          <Show when={selectedBearers().length === 1}>
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
          <button type="button" onClick={props.onClose}>
            Cancel
          </button>
        </div>
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
                  <button onClick={() => copyToClipboard(toBech32Lnurl(url()))}>
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
                      props.onClose()
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
    </>
  )
}
export default SendDialog
