import type {Component, JSX} from 'solid-js'
import {Show, createMemo, createSignal} from 'solid-js'
import {
  IoRefreshSharp,
  IoGitBranchSharp,
  IoTrashSharp,
  IoShieldCheckmarkSharp,
  IoBanSharp,
  IoArrowUndoSharp,
  IoReorderThreeSharp,
  IoPencilSharp,
  IoHardwareChipSharp
} from 'solid-icons/io'

import type {Bearer} from '../storage'
import {useWallet} from '../WalletContext'
import {useDevice} from '../DeviceContext'
import type {SplitResult} from '../lnurlcash'
import {
  noteK1,
  noteSignature,
  serverOf,
  withNewK1,
  fetchNoteInfo,
  verifyNoteSignature,
  splitNote,
  rotateNote,
  settleNote,
  NoteSpentError
} from '../lnurlcash'
import {
  deviceRefresh,
  migrateNoteToDevice,
  deviceSplit,
  deviceSettle,
  markDeviceNoteSpent
} from '../deviceOrchestration'
import {
  msatToSats,
  formatDate,
  formatRelativeTime,
  notify,
  NotifyKind
} from '../helpers'
import {getTrustedMintPubkey, getTrustedMintNodeColor} from '../trustedMints'
import {offlineMode} from '../offlineMode'

type Action = 'split' | null

export type BearerCardProps = {
  bearer: Bearer
  selected: boolean
  onSelect: (selected: boolean) => void
  // drag-to-reorder (see MintGroupCard) - the handle only renders when a
  // handler is given, which MintGroupCard withholds for a spent note.
  // dragStyle is only ever set while dragging is true - it floats this
  // card to follow the pointer (position: fixed) instead of it being just
  // another grid tile reflowing under a static cursor
  dragging?: boolean
  dragStyle?: JSX.CSSProperties
  onDragHandleDown?: (e: PointerEvent) => void
  setRef?: (el: HTMLElement) => void
}

const BearerCard: Component<BearerCardProps> = props => {
  const {updateBearer, removeBearer, addBearer, logActivity} = useWallet()
  const {client: deviceClient} = useDevice()
  const [action, setAction] = createSignal<Action>(null)
  const [busy, setBusy] = createSignal(false)
  const [splitSats, setSplitSats] = createSignal('')
  const [splitTimes, setSplitTimes] = createSignal('1')
  const [confirmDelete, setConfirmDelete] = createSignal(false)
  const [confirmUnspend, setConfirmUnspend] = createSignal(false)
  const [editingLabel, setEditingLabel] = createSignal(false)
  const [labelInput, setLabelInput] = createSignal('')

  const k1 = () => noteK1(props.bearer.url) || ''
  const hasCallback = () => props.bearer.callback !== ''
  const isSpent = () => !!props.bearer.spent

  // this note's issuing mint's self-reported node color (cached via the
  // mint-address lookup, see trustedMints.ts) - tints the card's own
  // background gradient (see the .tinted rule in style.scss) instead of
  // the app's default accent, purely cosmetic. Absent whenever no lookup
  // has ever cached one for this server, same fallback story as
  // offlineVerified's mintPubkey below.
  const noteColor = createMemo(() =>
    getTrustedMintNodeColor(serverOf(props.bearer.url))
  )
  const cardStyle = createMemo(() => ({
    ...props.dragStyle,
    ...(noteColor() ? {'--note-tint': noteColor()!} : {})
  }))
  // the amount and server text are also click targets for select-to-combine
  // - a bigger, more obvious target than the small checkbox alone, which
  // stays as the visible indicator of the current state either way
  const toggleSelect = () => {
    if (!isSpent()) props.onSelect(!props.selected)
  }

  // offline-verifiable iff the note carries a signature AND this wallet
  // already knows the issuing service's mintPubkey - both optional per
  // spec. The trusted-mints registry is the authoritative source (it can
  // hold a newer key than this one bearer's own cached copy, e.g. if a
  // sibling bearer from the same server refreshed more recently); the
  // bearer's own field is only a fallback for the edge case of a restored
  // record whose server isn't in the registry yet.
  const offlineVerified = createMemo(() => {
    const sig = noteSignature(props.bearer.url)
    const mintPubkey =
      getTrustedMintPubkey(serverOf(props.bearer.url)) ??
      props.bearer.mintPubkey
    if (!sig || !mintPubkey) return false
    return verifyNoteSignature(k1(), props.bearer.amount, sig, mintPubkey)
  })

  // the informational GET always puts k1 on the wire now (the spec dropped
  // the optional hash-based lookup), so every refresh is followed by a
  // rotate - per "WALLET SHOULD ... rotate ... after an informational GET
  // on a note it intends to keep holding". When a vault is connected, that
  // replacement secret is generated and held there instead of in this
  // browser - for an already device-backed note that's deviceRefresh
  // (export, then GET+rotate with the same secret); for a browser-only
  // note it's a one-way migration onto the device (see
  // deviceOrchestration.ts's header comment).
  const refresh = async () => {
    setBusy(true)
    try {
      const client = deviceClient()
      const deviceId = props.bearer.deviceId
      if (deviceId && client) {
        const result = await deviceRefresh(client, {...props.bearer, deviceId})
        await updateBearer(props.bearer.id, {
          url: result.url,
          callback: result.callback,
          amount: result.amountMsat,
          verified: true,
          mintPubkey: result.mintPubkey ?? props.bearer.mintPubkey,
          deviceId: result.deviceId
        })
        logActivity(
          'refresh',
          `Refreshed ${msatToSats(result.amountMsat)} sats from ${serverOf(result.url)} (on device).`
        )
        notify('Note refreshed.', NotifyKind.SUCCESS)
        return
      }

      const info = await fetchNoteInfo(props.bearer.url)

      if (client) {
        const migrated = await migrateNoteToDevice(client, {
          url: props.bearer.url,
          callback: info.callback,
          amount: info.maxWithdrawable
        })
        await updateBearer(props.bearer.id, {
          url: migrated.url,
          callback: migrated.callback,
          amount: info.maxWithdrawable,
          verified: true,
          mintPubkey: info.mintPubkey ?? props.bearer.mintPubkey,
          deviceId: migrated.deviceId
        })
        logActivity(
          'refresh',
          `Refreshed ${msatToSats(info.maxWithdrawable)} sats from ${serverOf(migrated.url)} - moved onto your vault.`
        )
        notify('Note refreshed and moved onto your vault.', NotifyKind.SUCCESS)
        return
      }

      let url = props.bearer.url
      let rotationError: string | null = null
      try {
        const rotated = await rotateNote(info.callback, k1())
        url = withNewK1(
          props.bearer.url,
          rotated.k1,
          info.maxWithdrawable,
          rotated.signature
        )
      } catch (err) {
        rotationError = (err as Error).message
      }
      await updateBearer(props.bearer.id, {
        url,
        callback: info.callback,
        amount: info.maxWithdrawable,
        verified: true,
        mintPubkey: info.mintPubkey ?? props.bearer.mintPubkey
      })
      logActivity(
        'refresh',
        `Refreshed ${msatToSats(info.maxWithdrawable)} sats from ${serverOf(url)}.` +
          (rotationError ? ` Could not rotate (${rotationError}).` : '')
      )
      // the GET this refresh is nominally "about" is only ever a means to
      // the rotate - it succeeding on its own isn't worth telling the
      // holder about, so a failed rotate reports just the one thing that
      // actually matters (and is now exposed), not that plus an unrelated
      // "refreshed" success alongside it
      if (rotationError) {
        notify(
          `Could not rotate after refresh (${rotationError}) - your secret was just transmitted, treat old copies of this note as exposed.`,
          NotifyKind.ERROR
        )
      } else {
        notify('Note refreshed.', NotifyKind.SUCCESS)
      }
    } catch (err) {
      // the service just told us - unambiguously, this GET named exactly
      // this note's own k1 - that it's already spent. Trust it and lock
      // the note the same way markSpent() does, rather than leave it
      // sitting there looking spendable until someone notices by hand.
      if (err instanceof NoteSpentError) {
        await updateBearer(props.bearer.id, {spent: true})
        logActivity(
          'spent',
          `${serverOf(props.bearer.url)} reports ${msatToSats(props.bearer.amount)} sats as already spent - marked spent locally.`
        )
      }
      notify((err as Error).message, NotifyKind.ERROR)
    } finally {
      setBusy(false)
    }
  }

  // splitNote is only ever a 2-way split (one piece + a change note), so
  // splitting off the same amount `times` times means chaining that many
  // calls, each peeling one more piece off the still-unspent "change" from
  // the previous one - the leftover remainder (whatever's left after all of
  // them) becomes the final note. A failure partway through (network drop,
  // etc.) leaves whichever pieces already came back safely recorded as
  // bearers, but the in-flight call's own "change" secret isn't recorded
  // anywhere if its response never arrives - same exposure a single split
  // already has, just repeated per extra time
  const split = async () => {
    // whole sats only - satsToMsat alone would round a typed fractional
    // sat (e.g. "10.5") to the nearest msat, not the nearest sat, so a
    // split note could otherwise end up worth a sub-sat amount that isn't
    // really spendable as its own unit
    const sats = Math.trunc(Number(splitSats()))
    const msat = sats * 1000
    const times = parseInt(splitTimes(), 10)
    if (!splitSats() || !Number.isFinite(sats) || sats <= 0) {
      notify('Enter a whole number of sats.', NotifyKind.ERROR)
      return
    }
    if (!Number.isFinite(times) || times < 1) {
      notify('Enter how many times to split (1 or more).', NotifyKind.ERROR)
      return
    }
    if (msat * times >= props.bearer.amount) {
      notify(
        'Total split amount must be below the note value.',
        NotifyKind.ERROR
      )
      return
    }
    setBusy(true)
    try {
      // the still-unspent remainder is tracked as an actual stored bearer
      // throughout, starting as this card's own note - never removed until
      // a split for it has actually succeeded. A rejected split (e.g.
      // "insufficient value" once its own base_fee_msat wouldn't leave
      // enough change - see LUD-25) still puts that remainder's k1 on the
      // wire via the failed callback request, so on failure it's rotated
      // in place (best-effort) rather than left exposed - but always kept,
      // never dropped, so a failed split costs nothing
      let remainderId = props.bearer.id
      let currentK1 = k1()
      let currentUrl = props.bearer.url
      let currentCallback = props.bearer.callback
      let currentAmount = props.bearer.amount
      let currentDeviceId = props.bearer.deviceId
      // a mint MAY charge a flat fee per split (LUD-25), deducted from the
      // change rather than the split-off amount - so the remainder is read
      // back authoritatively (informational GET) after each split instead
      // of just subtracting msat. Tracked per-iteration (perSplitFeeMsat,
      // the same on every iteration since it's a flat fee) as well as
      // summed (totalFeeMsat), so a multi-split report can say both "X per
      // split" and "Y total" instead of one ambiguous number that reads
      // like a single one-time deduction
      let totalFeeMsat = 0
      let perSplitFeeMsat = 0
      const client = deviceClient()
      for (let i = 0; i < times; i++) {
        const expectedChange = currentAmount - msat
        if (client) {
          // if a vault is connected, both outputs land on it - regardless
          // of whether the input being split was itself device-backed
          // (see deviceOrchestration.ts's "migration" note). No local
          // rotate-in-place fallback on failure here (unlike the
          // browser-only branch below): a failed device split never burns
          // its input (that only happens once the mint call succeeds), so
          // the existing remainder record is already correct as-is.
          const parts = await deviceSplit(
            client,
            [{deviceId: currentDeviceId, url: currentUrl}],
            currentCallback,
            msat,
            currentAmount
          )
          // past this point the input IS burned server-side, so both
          // outputs are tracked BEFORE the remainder record is removed -
          // otherwise a settle failure here would strand the change note
          // (CONFIRMED on the device) with no local record. A failed
          // settle still tracks a mirror of the raw output (unverified,
          // at its expected pre-fee amount) and stops the chain; the next
          // device refresh repairs it
          let settledChange = parts.change
          let changeVerified = false
          let settleError: Error | null = null
          try {
            settledChange = await deviceSettle(client, parts.change)
            changeVerified = true
          } catch (err) {
            settleError = new Error(
              `Settling the change note didn't complete (${(err as Error).message}) - it's kept as an unverified note; refresh it with the vault connected to repair.`
            )
          }
          await addBearer({
            url: parts.target.url,
            callback: parts.target.callback,
            amount: msat,
            verified: true,
            mintPubkey: props.bearer.mintPubkey,
            deviceId: parts.target.deviceId
          })
          const remainder = await addBearer({
            url: settledChange.url,
            callback: settledChange.callback,
            amount: settledChange.amountMsat,
            verified: changeVerified,
            mintPubkey: props.bearer.mintPubkey,
            deviceId: settledChange.deviceId
          })
          removeBearer(remainderId)
          remainderId = remainder.id
          if (settleError) throw settleError
          perSplitFeeMsat = expectedChange - settledChange.amountMsat
          totalFeeMsat += perSplitFeeMsat
          currentAmount = settledChange.amountMsat
          currentUrl = settledChange.url
          currentCallback = settledChange.callback
          currentDeviceId = settledChange.deviceId
          continue
        }

        let result: SplitResult
        try {
          result = await splitNote(currentCallback, [currentK1], msat)
        } catch (err) {
          // a single-k1 request, so a NoteSpentError here is unambiguous:
          // it's remainderId that's already gone, not some other selected
          // note - lock it the same way refresh() does, and skip the
          // rotate-in-place attempt below (there's nothing left to rotate)
          if (err instanceof NoteSpentError) {
            await updateBearer(remainderId, {spent: true})
            logActivity(
              'spent',
              `${serverOf(currentUrl)} reports ${msatToSats(currentAmount)} sats as already spent - marked spent locally.`
            )
            throw err
          }
          try {
            const rotated = await rotateNote(currentCallback, currentK1)
            await updateBearer(remainderId, {
              url: withNewK1(
                currentUrl,
                rotated.k1,
                currentAmount,
                rotated.signature
              )
            })
          } catch {
            // rotation unsupported/unreachable too - the remainder stays
            // recorded under its pre-attempt secret rather than vanish
          }
          throw err
        }
        removeBearer(remainderId)
        await addBearer({
          url: withNewK1(currentUrl, result.k1, msat, result.signature),
          callback: currentCallback,
          amount: msat,
          verified: true,
          mintPubkey: props.bearer.mintPubkey
        })
        // settleNote learns the change's true value (a mint MAY have
        // deducted a fee - LUD-25) and rotates it, since the GET that
        // learns it necessarily puts k1 on the wire
        const settled = await settleNote(
          currentUrl,
          result.change,
          expectedChange,
          result.changeSignature
        )
        perSplitFeeMsat = expectedChange - settled.amountMsat
        totalFeeMsat += perSplitFeeMsat
        currentAmount = settled.amountMsat
        currentK1 = settled.k1
        currentUrl = withNewK1(
          currentUrl,
          settled.k1,
          settled.amountMsat,
          settled.signature
        )
        currentCallback = settled.callback
        const remainder = await addBearer({
          url: currentUrl,
          callback: settled.callback,
          amount: settled.amountMsat,
          verified: true,
          mintPubkey: props.bearer.mintPubkey
        })
        remainderId = remainder.id
      }
      const feeNote =
        totalFeeMsat > 0
          ? times > 1
            ? ` ${msatToSats(perSplitFeeMsat)} sats fee deducted per split (${msatToSats(totalFeeMsat)} sats total).`
            : ` ${msatToSats(totalFeeMsat)} sats fee deducted from the remainder.`
          : ''
      logActivity(
        'split',
        `Split off ${times} note${times === 1 ? '' : 's'} of ${msatToSats(msat)} sats each from ${serverOf(props.bearer.url)}.${feeNote}`
      )
      notify(
        `Split off ${times} note${times === 1 ? '' : 's'} of ${msatToSats(msat)} sats each.${feeNote}`,
        NotifyKind.SUCCESS
      )
      setAction(null)
    } catch (err) {
      notify((err as Error).message, NotifyKind.ERROR)
    } finally {
      setBusy(false)
    }
  }

  // a local-only lock (see storage.ts's Bearer.spent) - no network call,
  // just stops this wallet from acting on a note it considers given away.
  // A device-backed note's on-device copy is retired alongside (queued for
  // the next connect if the vault isn't attached right now), so the vault
  // doesn't keep listing as spendable a note this wallet considers gone
  const markSpent = async () => {
    updateBearer(props.bearer.id, {spent: true})
    if (props.bearer.deviceId) {
      await markDeviceNoteSpent(deviceClient(), props.bearer.deviceId)
    }
    logActivity(
      'spent',
      `Marked ${msatToSats(props.bearer.amount)} sats from ${serverOf(props.bearer.url)} as spent.`
    )
    notify(
      'Marked as spent - split and refresh are locked until unspent.',
      NotifyKind.SUCCESS
    )
  }

  const unspend = () => {
    updateBearer(props.bearer.id, {spent: false})
    setConfirmUnspend(false)
    logActivity(
      'unspent',
      `Unspent ${msatToSats(props.bearer.amount)} sats from ${serverOf(props.bearer.url)}.`
    )
    notify('Unspent - actions are available again.', NotifyKind.SUCCESS)
  }

  // purely local, for the holder's own reference - not part of the note
  // itself, never sent anywhere. Available even on a spent note (unlike the
  // protocol actions above), since it's just a memo, not a mutation of it
  const startEditLabel = () => {
    setLabelInput(props.bearer.label ?? '')
    setEditingLabel(true)
  }

  const saveLabel = () => {
    const trimmed = labelInput().trim()
    updateBearer(props.bearer.id, {label: trimmed || undefined})
    setEditingLabel(false)
  }

  return (
    <figure
      class="bearer-card"
      classList={{dragging: props.dragging, tinted: !!noteColor()}}
      style={cardStyle()}
      ref={props.setRef}
    >
      <div class="bearer-head">
        <Show when={props.onDragHandleDown}>
          {onDragHandleDown => (
            <button
              class="icon-btn drag-handle"
              title="Drag to reorder"
              onPointerDown={onDragHandleDown()}
            >
              <IoReorderThreeSharp />
            </button>
          )}
        </Show>
        <label class="bearer-select" title="Select for combine">
          <input
            type="checkbox"
            checked={props.selected}
            disabled={isSpent()}
            onChange={e => props.onSelect(e.currentTarget.checked)}
          />
        </label>
        <div class="bearer-title">
          <span
            class="bearer-amount"
            classList={{clickable: !isSpent()}}
            onClick={toggleSelect}
          >
            {msatToSats(props.bearer.amount)} sats
          </span>
          <Show when={props.bearer.label}>
            <span class="bearer-label">{props.bearer.label}</span>
          </Show>
          <Show when={!props.bearer.verified}>
            <span class="bearer-pending">unverified</span>
          </Show>
          <Show when={offlineVerified()}>
            <span
              class="bearer-signed"
              title="Signature checks out against this mint's published pubkey"
            >
              <IoShieldCheckmarkSharp />
              &nbsp;signed
            </span>
          </Show>
          <Show when={props.bearer.deviceId}>
            <span
              class="bearer-device"
              title="This note's secret lives on your paired vault, not this browser"
            >
              <IoHardwareChipSharp />
              &nbsp;on device
            </span>
          </Show>
          <Show when={isSpent()}>
            <span class="bearer-spent" title="Locally locked - see below">
              <IoBanSharp />
              &nbsp;spent
            </span>
          </Show>
          <span
            class="bearer-server"
            classList={{clickable: !isSpent()}}
            onClick={toggleSelect}
          >
            {serverOf(props.bearer.url)}
          </span>
        </div>
      </div>
      <Show when={editingLabel()}>
        <div class="form-item">
          <label>Label (private, for your own reference)</label>
          <input
            type="text"
            placeholder="e.g. rent, gift for Alex"
            value={labelInput()}
            onInput={e => setLabelInput(e.currentTarget.value)}
            onKeyDown={e => e.key === 'Enter' && saveLabel()}
          />
          <div class="btns">
            <button onClick={saveLabel}>Save</button>
            <button onClick={() => setEditingLabel(false)}>Cancel</button>
          </div>
        </div>
      </Show>
      <div class="btns">
        <button
          class="icon-btn"
          title={
            offlineMode()
              ? 'Offline mode is on'
              : 'Refresh value from the service, then rotate (the GET necessarily exposes k1)'
          }
          disabled={busy() || isSpent() || offlineMode()}
          onClick={refresh}
        >
          <IoRefreshSharp classList={{spin: busy()}} />
        </button>
        <button
          class="icon-btn"
          title={offlineMode() ? 'Offline mode is on' : 'Split into two notes'}
          disabled={!hasCallback() || isSpent() || offlineMode()}
          onClick={() => setAction(action() === 'split' ? null : 'split')}
        >
          <IoGitBranchSharp />
        </button>
        <button
          class="icon-btn"
          title={props.bearer.label ? 'Edit label' : 'Add a label'}
          onClick={startEditLabel}
        >
          <IoPencilSharp />
        </button>
        <div class="bearer-actions">
          <Show
            when={isSpent()}
            fallback={
              <button
                class="icon-btn"
                title="Mark as spent - lock this note without removing it, e.g. if you already handed it out some other way"
                onClick={markSpent}
              >
                <IoBanSharp />
              </button>
            }
          >
            <button
              class="icon-btn"
              title="Unspend - unlock this note again"
              onClick={() => setConfirmUnspend(true)}
            >
              <IoArrowUndoSharp />
            </button>
          </Show>
          <Show when={isSpent()}>
            <button
              class="icon-btn"
              title="Clear spent note from wallet"
              onClick={() => setConfirmDelete(true)}
            >
              <IoTrashSharp />
            </button>
          </Show>
        </div>
      </div>
      <Show when={!hasCallback() && !isSpent()}>
        <p class="bearer-hint">
          Not verified with its service yet - refresh to enable split.
        </p>
      </Show>
      <Show when={isSpent() && !confirmUnspend()}>
        <p class="bearer-hint">
          Locked as spent - refresh and split are disabled so this copy can't be
          reused by accident.
        </p>
      </Show>
      <Show when={confirmUnspend()}>
        <p class="warning">
          This note may already be gone for good - if it was melted, or handed
          to someone who's since redeemed it, unspending it here won't bring it
          back (this is a local flag, not a check with the service). And if you
          handed it over and this wallet spends or rotates it again before the
          recipient does, their copy gets invalidated instead of yours. Unspend
          anyway?
        </p>
        <div class="btns">
          <button onClick={unspend}>Unspend anyway</button>
          <button onClick={() => setConfirmUnspend(false)}>Cancel</button>
        </div>
      </Show>
      <Show when={confirmDelete()}>
        <p class="warning">
          Clear this spent note from the wallet? If it turns out it wasn't
          actually spent, the sats are gone unless you saved the note elsewhere.
        </p>
        <div class="btns">
          <button
            onClick={() => {
              removeBearer(props.bearer.id)
              logActivity(
                'deleted',
                `Cleared a spent ${msatToSats(props.bearer.amount)} sat note from ${serverOf(props.bearer.url)}.`
              )
              notify('Spent note cleared.', NotifyKind.SUCCESS)
            }}
          >
            Clear
          </button>
          <button onClick={() => setConfirmDelete(false)}>Cancel</button>
        </div>
      </Show>
      <Show when={action() === 'split'}>
        <div class="form-item">
          <label>Split off (sats, of {msatToSats(props.bearer.amount)})</label>
          <input
            type="number"
            min="1"
            step="1"
            placeholder="amount in sats"
            value={splitSats()}
            onInput={e => setSplitSats(e.currentTarget.value)}
          />
          <label>How many times</label>
          <input
            type="number"
            min="1"
            step="1"
            placeholder="1"
            value={splitTimes()}
            onInput={e => setSplitTimes(e.currentTarget.value)}
          />
          <p class="bearer-hint">
            If this mint charges a fee, it's deducted from the remainder, not
            the amount split off - splitting fails if too little would be left
            over to cover it.
          </p>
          <Show when={Number(splitTimes()) > 1}>
            <p class="bearer-hint">
              Chains {Number(splitTimes())} split requests one after another -
              if one fails partway through, whichever notes already came back
              are kept, and you'd need to try again for the rest.
            </p>
          </Show>
          <div class="btns">
            <button disabled={busy() || offlineMode()} onClick={split}>
              <Show when={busy()}>
                <IoRefreshSharp class="spin" />
                &nbsp;
              </Show>
              Split
            </button>
          </div>
        </div>
      </Show>
      <p class="bearer-dates" title={formatDate(props.bearer.updatedAt)}>
        updated {formatRelativeTime(props.bearer.updatedAt)}
      </p>
    </figure>
  )
}
export default BearerCard
