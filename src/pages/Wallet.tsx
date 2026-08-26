import type {Component} from 'solid-js'
import {Show, For, createSignal, createMemo} from 'solid-js'
import {A} from '@solidjs/router'
import {
  IoAddCircleSharp,
  IoPaperPlaneSharp,
  IoArrowDownCircleSharp,
  IoLockOpenSharp,
  IoRefreshSharp,
  IoTrashSharp,
  IoReceiptSharp,
  IoGitMergeSharp,
  IoGitBranchSharp,
  IoSwapHorizontalSharp,
  IoBanSharp,
  IoCloseCircleSharp
} from 'solid-icons/io'

import {useWallet, groupByServer} from '../WalletContext'
import type {Bearer} from '../storage'
import {compareBearerOrder} from '../storage'
import {serverOf} from '../lnurlcash'
import {
  requireNoteK1,
  withNewK1,
  mergeNotes,
  splitNote,
  settleNote,
  probeBurnedNote,
  AmbiguousMutationError
} from '../lnurlcash'
import {deviceMerge, deviceSplit, deviceSettle} from '../deviceOrchestration'
import {useDevice} from '../DeviceContext'
import {offlineMode} from '../offlineMode'
import {notify, NotifyKind, msatToSats} from '../helpers'
import BearerCard from '../components/BearerCard'
import TransferDialog from '../components/TransferDialog'
import SendDialog from '../components/SendDialog'
import ReceiveDialog from '../components/ReceiveDialog'

const Wallet: Component = () => {
  const {
    state,
    bearers,
    unlock,
    addBearer,
    updateBearer,
    removeBearer,
    logActivity
  } = useWallet()
  const {client: deviceClient} = useDevice()
  const [password, setPassword] = createSignal('')
  const [unlocking, setUnlocking] = createSignal(false)
  const [selected, setSelected] = createSignal<Set<string>>(new Set())
  const [confirmClearSpent, setConfirmClearSpent] = createSignal(false)
  // collapsed by default, same reasoning MintGroupCard used to have per
  // mint - now a single wallet-wide toggle since notes no longer live in
  // separate per-mint sections
  const [showSpent, setShowSpent] = createSignal(false)
  const [combining, setCombining] = createSignal(false)
  const [showSplitInput, setShowSplitInput] = createSignal(false)
  const [splitSats, setSplitSats] = createSignal('')
  const [splitting, setSplitting] = createSignal(false)
  // captured once Transfer is clicked, independent of live selection -
  // starting a transfer immediately marks the source spent, which would
  // otherwise drop it out of selectedEligible() and yank the dialog out
  // from under itself mid-flight
  const [transferSource, setTransferSource] = createSignal<Bearer | null>(null)
  // mutually exclusive - opening one closes the other rather than letting
  // both dialogs be up (and independently mutating wallet state) at once
  const [openDialog, setOpenDialog] = createSignal<'send' | 'receive' | null>(
    null
  )
  const showSend = () => openDialog() === 'send'
  const showReceive = () => openDialog() === 'receive'

  // the hero's balance/mint count is always the spendable view (excludes
  // spent notes) - "Total balance" shouldn't count sats that aren't
  // actually yours to spend anymore.
  const spendableBearers = createMemo(() => bearers().filter(b => !b.spent))
  const spentBearers = createMemo(() => bearers().filter(b => b.spent))
  const spentCount = createMemo(() => spentBearers().length)
  const spendableTotal = createMemo(() =>
    spendableBearers().reduce((sum, b) => sum + b.amount, 0)
  )
  const spentTotal = createMemo(() =>
    spentBearers().reduce((sum, b) => sum + b.amount, 0)
  )
  const mintCount = createMemo(() => groupByServer(spendableBearers()).length)
  // every mint currently holding at least one note - this is the source
  // list for the "select all from a mint" picker below
  const serverNames = createMemo(() =>
    groupByServer(bearers()).map(([server]) => server)
  )

  // notes no longer live in per-mint sections - one flat, orderable list
  // for the whole wallet. compareBearerOrder falls back to newest-first,
  // same as before; drag-to-reorder (below) now spans every mint at once
  const orderedBearers = createMemo(() =>
    [...bearers()].sort(compareBearerOrder)
  )
  const visibleBearers = createMemo(() =>
    showSpent() ? orderedBearers() : orderedBearers().filter(b => !b.spent)
  )

  const toggleSelect = (id: string, isSelected: boolean) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (isSelected) next.add(id)
      else next.delete(id)
      return next
    })
  }

  const selectMany = (ids: string[], isSelected: boolean) => {
    setSelected(prev => {
      const next = new Set(prev)
      for (const id of ids) {
        if (isSelected) next.add(id)
        else next.delete(id)
      }
      return next
    })
  }

  // "select all from a mint" - replaces the current selection with every
  // unspent note from the chosen mint, rather than adding to it: it's a
  // fresh, explicit action each time (combine/split/transfer only ever
  // work on a single mint's notes anyway, so mixing in a prior selection
  // from a different mint would just leave everything disabled)
  const selectAllFromServer = (server: string) => {
    if (!server) return
    const ids = bearers()
      .filter(b => serverOf(b.url) === server && !b.spent)
      .map(b => b.id)
    setSelected(new Set(ids))
  }

  // combine/split/transfer all require every selected note to share one
  // issuing mint - selectedEligible collapses to empty the moment the
  // selection spans more than one, which disables all three actions below
  const selectedBearers = createMemo(() =>
    bearers().filter(b => selected().has(b.id))
  )
  const eligibleSelected = createMemo(() =>
    selectedBearers().filter(b => b.callback !== '' && !b.spent)
  )
  const eligibleServers = createMemo(
    () => new Set(eligibleSelected().map(b => serverOf(b.url)))
  )
  const selectedEligible = createMemo(() =>
    eligibleServers().size === 1 ? eligibleSelected() : []
  )
  const canCombine = createMemo(() => selectedEligible().length >= 2)
  const canTransfer = createMemo(() => selectedEligible().length === 1)

  // drag-to-reorder: dragPreview mirrors visibleBearers but is live-spliced
  // on every pointermove for instant feedback, and only ever committed
  // (persisted as sortIndex) on drop - see startDrag below. Refs are
  // grabbed per-card so pointermove can measure who the pointer is
  // currently over, regardless of the list's flex-wrap layout
  const itemRefs = new Map<string, HTMLElement>()
  const [dragPreview, setDragPreview] = createSignal<Bearer[] | null>(null)
  const [draggingId, setDraggingId] = createSignal<string | null>(null)
  const [dragPointerPos, setDragPointerPos] = createSignal<{
    x: number
    y: number
  } | null>(null)
  let dragPointerId: number | null = null
  let dragGrabDx = 0
  let dragGrabDy = 0
  let dragWidth = 0
  let pendingMoveEvent: PointerEvent | null = null
  let rafScheduled = false

  const displayedBearers = createMemo(() => dragPreview() ?? visibleBearers())

  const dragStyle = (bearerId: string) => {
    if (draggingId() !== bearerId) return undefined
    const pos = dragPointerPos()
    if (!pos) return undefined
    return {
      position: 'fixed' as const,
      left: `${pos.x - dragGrabDx}px`,
      top: `${pos.y - dragGrabDy}px`,
      width: `${dragWidth}px`,
      'z-index': 1000,
      'pointer-events': 'none' as const
    }
  }

  const processDragMove = (e: PointerEvent) => {
    setDragPointerPos({x: e.clientX, y: e.clientY})
    const id = draggingId()
    const current = dragPreview()
    if (!id || !current) return
    const fromIndex = current.findIndex(b => b.id === id)
    if (fromIndex === -1) return
    let targetIndex = -1
    for (let i = 0; i < current.length; i++) {
      if (current[i].id === id) continue
      const el = itemRefs.get(current[i].id)
      if (!el) continue
      const rect = el.getBoundingClientRect()
      if (
        e.clientX >= rect.left &&
        e.clientX <= rect.right &&
        e.clientY >= rect.top &&
        e.clientY <= rect.bottom
      ) {
        targetIndex = i
        break
      }
    }
    if (targetIndex === -1 || targetIndex === fromIndex) return
    const insertAt = fromIndex < targetIndex ? targetIndex - 1 : targetIndex
    const next = current.slice()
    const [moved] = next.splice(fromIndex, 1)
    next.splice(insertAt, 0, moved)
    setDragPreview(next)
  }

  const onDragMove = (e: PointerEvent) => {
    if (e.pointerId !== dragPointerId) return
    pendingMoveEvent = e
    if (rafScheduled) return
    rafScheduled = true
    requestAnimationFrame(() => {
      rafScheduled = false
      if (pendingMoveEvent) processDragMove(pendingMoveEvent)
    })
  }

  const endDrag = (e: PointerEvent) => {
    if (e.pointerId !== dragPointerId) return
    window.removeEventListener('pointermove', onDragMove)
    window.removeEventListener('pointerup', endDrag)
    window.removeEventListener('pointercancel', endDrag)
    document.body.classList.remove('dragging-note')
    dragPointerId = null
    pendingMoveEvent = null
    setDraggingId(null)
    setDragPointerPos(null)
    const finalOrder = dragPreview()
    setDragPreview(null)
    if (!finalOrder) return
    // only the ranks that actually moved get written - a drag that lands
    // back where it started, or a card past the shifted range, costs
    // nothing. Sequential, not Promise.all: persistBearer reads localStorage
    // fresh after its own encrypt step, so concurrent writes here could
    // race and clobber each other's records
    ;(async () => {
      for (const [index, bearer] of finalOrder.entries()) {
        if (bearer.sortIndex !== index) {
          await updateBearer(bearer.id, {sortIndex: index})
        }
      }
    })()
  }

  const startDrag = (bearer: Bearer, e: PointerEvent) => {
    if (bearer.spent) return
    e.preventDefault()
    const el = itemRefs.get(bearer.id)
    const rect = el?.getBoundingClientRect()
    dragGrabDx = rect ? e.clientX - rect.left : 0
    dragGrabDy = rect ? e.clientY - rect.top : 0
    dragWidth = rect?.width ?? 0
    dragPointerId = e.pointerId
    setDraggingId(bearer.id)
    setDragPointerPos({x: e.clientX, y: e.clientY})
    setDragPreview(visibleBearers().slice())
    document.body.classList.add('dragging-note')
    window.addEventListener('pointermove', onDragMove)
    window.addEventListener('pointerup', endDrag)
    window.addEventListener('pointercancel', endDrag)
  }

  const unlockWallet = async (e: Event) => {
    e.preventDefault()
    setUnlocking(true)
    try {
      await unlock(password())
      setPassword('')
    } catch {
      notify('Incorrect password.', NotifyKind.ERROR)
    } finally {
      setUnlocking(false)
    }
  }

  const clearAllSpent = () => {
    const spent = spentBearers()
    for (const bearer of spent) removeBearer(bearer.id)
    setConfirmClearSpent(false)
    notify(
      `Cleared ${spent.length} spent note${spent.length === 1 ? '' : 's'}.`,
      NotifyKind.SUCCESS
    )
  }

  const combineSelected = async () => {
    const picked = selectedEligible()
    if (picked.length < 2) return
    setCombining(true)
    try {
      const [base] = picked
      const server = serverOf(base.url)
      const sum = picked.reduce((s, b) => s + b.amount, 0)
      let actualAmount: number
      const client = deviceClient()
      if (client) {
        // if a vault is connected, the merged note lands there instead -
        // regardless of whether any of the inputs were themselves
        // device-backed (mixed selections are fine, see
        // deviceOrchestration.ts)
        const merged = await deviceMerge(
          client,
          picked.map(b => ({deviceId: b.deviceId, url: b.url})),
          base.callback,
          sum
        )
        const settled = await deviceSettle(client, merged)
        actualAmount = settled.amountMsat
        for (const bearer of picked) removeBearer(bearer.id)
        await addBearer({
          url: settled.url,
          callback: settled.callback,
          amount: actualAmount,
          verified: true,
          mintPubkey: base.mintPubkey,
          deviceId: settled.deviceId
        })
      } else {
        let mergedK1: string
        let mergedSignature: string | undefined
        try {
          const merged = await mergeNotes(
            base.callback,
            picked.map(b => requireNoteK1(b.url))
          )
          mergedK1 = merged.k1
          mergedSignature = merged.signature
        } catch (err) {
          if (!(err instanceof AmbiguousMutationError)) throw err
          // the merge request may have landed despite the failure - probe
          // one input before deciding what the carried secret is worth
          const outcome = await probeBurnedNote(base.url)
          if (outcome === 'live') throw err // nothing burned - plain failure
          if (outcome === 'unknown') {
            // can't tell: track the possible output without dropping the
            // inputs, and stop here
            await addBearer({
              url: withNewK1(base.url, err.newSecrets[0], sum),
              callback: base.callback,
              amount: sum,
              verified: false,
              mintPubkey: base.mintPubkey
            })
            throw new Error(
              'The combine may have gone through but could not be confirmed - the possible combined note is stored unverified alongside your originals; refresh them to reconcile.'
            )
          }
          // 'gone': the burn landed - the carried secret is the only money
          mergedK1 = err.newSecrets[0]
        }
        // the mint call above already burned every input server-side, so
        // the merged output is the only money left - it is stored BEFORE
        // any removeBearer of an input, then settled in place: a failed
        // settle leaves an unverified note a refresh can repair, not a
        // lost secret
        const added = await addBearer({
          url: withNewK1(base.url, mergedK1, sum, mergedSignature),
          callback: base.callback,
          amount: sum,
          verified: false,
          mintPubkey: base.mintPubkey
        })
        for (const bearer of picked) removeBearer(bearer.id)
        // a mint MAY refund part of its earlier per-note mint fees on merge
        // (LUD-25: (n - 1) * base_fee_msat back into the result) -
        // settleNote reads the actual value back authoritatively rather
        // than assume the naive sum, and rotates the merged secret (that
        // GET necessarily put it on the wire), so both the stored amount
        // and the notice below reflect what the mint actually credited
        actualAmount = sum
        try {
          const settled = await settleNote(
            base.url,
            mergedK1,
            sum,
            mergedSignature
          )
          actualAmount = settled.amountMsat
          await updateBearer(added.id, {
            url: withNewK1(
              base.url,
              settled.k1,
              settled.amountMsat,
              settled.signature
            ),
            callback: settled.callback,
            amount: settled.amountMsat,
            verified: true
          })
        } catch (err) {
          notify(
            `Combined, but settling the new note didn't complete (${(err as Error).message}) - it's tracked unverified; refresh it to repair.`,
            NotifyKind.ERROR
          )
        }
      }
      selectMany(
        picked.map(b => b.id),
        false
      )
      // LUD-25 refunds (n - 1) * base_fee_msat on an n-note merge - the per-
      // note figure is exactly that division, same "X per unit (Y total)"
      // framing as BearerCard's split, so a combine of several notes
      // doesn't read as a single flat, ambiguous number either
      const creditMsat = actualAmount - sum
      const perNoteCreditMsat = creditMsat / (picked.length - 1)
      const creditNote =
        creditMsat > 0
          ? picked.length > 2
            ? ` ${msatToSats(perNoteCreditMsat)} sats fee credited per extra note (${msatToSats(creditMsat)} sats total).`
            : ` ${msatToSats(creditMsat)} sats fee credited back.`
          : ''
      logActivity(
        'combine',
        `Combined ${picked.length} notes from ${server} into ${msatToSats(actualAmount)} sats.${creditNote}`
      )
      notify(
        `Combined ${picked.length} notes into one.${creditNote}`,
        NotifyKind.SUCCESS
      )
    } catch (err) {
      notify((err as Error).message, NotifyKind.ERROR)
    } finally {
      setCombining(false)
    }
  }

  // combine & split: same selection as combineSelected, but instead of
  // merging into one note, burns them all and mints two - splitSats() worth
  // and a change note for the remainder.
  const combineAndSplit = async () => {
    const picked = selectedEligible()
    if (picked.length < 2) return
    const sats = Math.trunc(Number(splitSats()))
    const msat = sats * 1000
    if (!splitSats() || !Number.isFinite(sats) || sats <= 0) {
      notify('Enter a whole number of sats.', NotifyKind.ERROR)
      return
    }
    const sum = picked.reduce((s, b) => s + b.amount, 0)
    if (msat >= sum) {
      notify('Split amount must be below the combined value.', NotifyKind.ERROR)
      return
    }
    setSplitting(true)
    try {
      const [base] = picked
      const server = serverOf(base.url)
      let targetAmount: number
      let changeAmount: number
      const client = deviceClient()
      if (client) {
        const parts = await deviceSplit(
          client,
          picked.map(b => ({deviceId: b.deviceId, url: b.url})),
          base.callback,
          msat,
          sum
        )
        for (const bearer of picked) removeBearer(bearer.id)
        await addBearer({
          url: parts.target.url,
          callback: parts.target.callback,
          amount: msat,
          verified: true,
          mintPubkey: base.mintPubkey,
          deviceId: parts.target.deviceId
        })
        const settledChange = await deviceSettle(client, parts.change)
        targetAmount = msat
        changeAmount = settledChange.amountMsat
        await addBearer({
          url: settledChange.url,
          callback: settledChange.callback,
          amount: settledChange.amountMsat,
          verified: true,
          mintPubkey: base.mintPubkey,
          deviceId: settledChange.deviceId
        })
      } else {
        let partK1 = ''
        let partSignature: string | undefined
        let changeK1 = ''
        let changeSignature: string | undefined
        let splitError: Error | null = null
        try {
          const result = await splitNote(
            base.callback,
            picked.map(b => requireNoteK1(b.url)),
            msat
          )
          partK1 = result.k1
          partSignature = result.signature
          changeK1 = result.change
          changeSignature = result.changeSignature
        } catch (err) {
          splitError = err as Error
        }
        if (splitError) {
          if (!(splitError instanceof AmbiguousMutationError)) throw splitError
          const outcome = await probeBurnedNote(base.url)
          if (outcome === 'live') throw splitError
          if (outcome === 'unknown') {
            await addBearer({
              url: withNewK1(base.url, splitError.newSecrets[0], msat),
              callback: base.callback,
              amount: msat,
              verified: false,
              mintPubkey: base.mintPubkey
            })
            await addBearer({
              url: withNewK1(base.url, splitError.newSecrets[1], sum - msat),
              callback: base.callback,
              amount: sum - msat,
              verified: false,
              mintPubkey: base.mintPubkey
            })
            throw new Error(
              'The split may have gone through but could not be confirmed - the possible outputs are stored unverified alongside your originals; refresh them to reconcile.'
            )
          }
          partK1 = splitError.newSecrets[0]
          changeK1 = splitError.newSecrets[1]
        }
        await addBearer({
          url: withNewK1(base.url, partK1, msat, partSignature),
          callback: base.callback,
          amount: msat,
          verified: true,
          mintPubkey: base.mintPubkey
        })
        const change = await addBearer({
          url: withNewK1(base.url, changeK1, sum - msat, changeSignature),
          callback: base.callback,
          amount: sum - msat,
          verified: false,
          mintPubkey: base.mintPubkey
        })
        for (const bearer of picked) removeBearer(bearer.id)
        targetAmount = msat
        changeAmount = sum - msat
        try {
          const settled = await settleNote(
            base.url,
            changeK1,
            sum - msat,
            changeSignature
          )
          changeAmount = settled.amountMsat
          await updateBearer(change.id, {
            url: withNewK1(
              base.url,
              settled.k1,
              settled.amountMsat,
              settled.signature
            ),
            callback: settled.callback,
            amount: settled.amountMsat,
            verified: true
          })
        } catch (err) {
          notify(
            `Split succeeded, but settling the change note didn't complete (${(err as Error).message}) - it's tracked unverified; refresh it to repair.`,
            NotifyKind.ERROR
          )
        }
      }
      selectMany(
        picked.map(b => b.id),
        false
      )
      const feeMsat = sum - msat - changeAmount
      const feeNote =
        feeMsat > 0
          ? ` ${msatToSats(feeMsat)} sats fee deducted from the change.`
          : ''
      logActivity(
        'split',
        `Combined ${picked.length} notes from ${server} and split into ${msatToSats(targetAmount)} + ${msatToSats(changeAmount)} sats.${feeNote}`
      )
      notify(
        `Split into ${msatToSats(targetAmount)} sats and ${msatToSats(changeAmount)} sats change.${feeNote}`,
        NotifyKind.SUCCESS
      )
      setShowSplitInput(false)
      setSplitSats('')
    } catch (err) {
      notify((err as Error).message, NotifyKind.ERROR)
    } finally {
      setSplitting(false)
    }
  }

  return (
    <Show
      when={state() !== 'none'}
      fallback={
        <div id="wallet" class="page">
          <figure>
            <h2>No wallet on this device yet</h2>
            <p>Create one, or restore a seed phrase you already have.</p>
            <div class="btns">
              <A href="/setup" class="hero-btn hero-btn-primary">
                Create wallet
              </A>
            </div>
          </figure>
        </div>
      }
    >
      <Show
        when={state() === 'unlocked'}
        fallback={
          <div id="unlock" class="page">
            <figure>
              <h2>Unlock your wallet</h2>
              <p>
                Your linking key is stored encrypted - enter your password to
                decrypt it and your bearer tokens.
              </p>
              <form onSubmit={unlockWallet}>
                <input
                  type="password"
                  placeholder="Password"
                  autocomplete="current-password"
                  autocapitalize="off"
                  spellcheck={false}
                  value={password()}
                  onInput={e => setPassword(e.currentTarget.value)}
                />
                <div class="btns">
                  <button type="submit" disabled={unlocking() || !password()}>
                    <Show when={unlocking()} fallback={<IoLockOpenSharp />}>
                      <IoRefreshSharp class="spin" />
                    </Show>
                    &nbsp;Unlock
                  </button>
                </div>
              </form>
              <p>
                <A href="/setup?tab=restore">Forgot password?</A>
              </p>
            </figure>
          </div>
        }
      >
        <Show
          when={bearers().length > 0}
          fallback={
            <div id="wallet" class="page">
              <section class="hero-intro">
                <h1>No LNURLcash yet</h1>
                <p class="hero-subtitle">
                  Your wallet is ready but empty. Mint a fresh bearer note from
                  any LNURLcash mint, or bring one in by scanning or pasting a
                  note someone handed you.
                </p>
                <div class="hero-actions">
                  <A href="/mint" class="hero-btn hero-btn-primary">
                    <IoAddCircleSharp />
                    &nbsp;Mint
                  </A>
                  <button
                    type="button"
                    class="hero-btn hero-btn-primary"
                    onClick={() => setOpenDialog('receive')}
                  >
                    <IoArrowDownCircleSharp />
                    &nbsp;Receive
                  </button>
                </div>
                <Show when={showReceive()}>
                  <ReceiveDialog onClose={() => setOpenDialog(null)} />
                </Show>
              </section>
            </div>
          }
        >
          <div id="wallet" class="page">
            <section class="wallet-hero">
              <div class="wallet-hero-header">
                <h2>Your LNURLcash</h2>
                <div class="wallet-hero-actions">
                  <A
                    href="/activity"
                    class="icon-btn"
                    title="Activity log - a history of every mint, split, combine, melt and transfer"
                  >
                    <IoReceiptSharp />
                  </A>
                  <Show when={spentCount() > 0}>
                    <button
                      class="icon-btn"
                      title={`Clear all ${spentCount()} spent note${spentCount() === 1 ? '' : 's'} from the wallet`}
                      onClick={() => setConfirmClearSpent(true)}
                    >
                      <IoTrashSharp />
                    </button>
                  </Show>
                </div>
              </div>
              <Show when={confirmClearSpent()}>
                <p class="warning">
                  Clear all {spentCount()} spent note
                  {spentCount() === 1 ? '' : 's'} from the wallet? If any of
                  them turn out not to have actually been spent, those sats are
                  gone unless you saved them elsewhere.
                </p>
                <div class="btns">
                  <button onClick={clearAllSpent}>Clear all</button>
                  <button onClick={() => setConfirmClearSpent(false)}>
                    Cancel
                  </button>
                </div>
              </Show>
              <div class="wallet-stats">
                <div class="wallet-stat">
                  <span class="wallet-stat-value">
                    {msatToSats(spendableTotal())} sats
                  </span>
                  <span class="wallet-stat-label">Total balance</span>
                </div>
                <div class="wallet-stat">
                  <span class="wallet-stat-value">{mintCount()}</span>
                  <span class="wallet-stat-label">
                    {mintCount() === 1 ? 'Mint' : 'Mints'}
                  </span>
                </div>
                <Show when={spentCount() > 0}>
                  <div class="wallet-stat">
                    <span class="wallet-stat-value">
                      {msatToSats(spentTotal())} sats
                    </span>
                    <span class="wallet-stat-label">
                      Spent&nbsp;·&nbsp;{spentCount()}
                    </span>
                  </div>
                </Show>
              </div>
              <div class="btns">
                <button type="button" onClick={() => setOpenDialog('receive')}>
                  <IoArrowDownCircleSharp />
                  &nbsp;Receive
                </button>
                <button type="button" onClick={() => setOpenDialog('send')}>
                  <IoPaperPlaneSharp />
                  &nbsp;Send
                </button>
              </div>
            </section>
            <Show when={showReceive()}>
              <ReceiveDialog onClose={() => setOpenDialog(null)} />
            </Show>
            <Show when={showSend()}>
              <SendDialog onClose={() => setOpenDialog(null)} />
            </Show>

            <section class="selection-toolbar">
              <div class="selection-toolbar-row">
                <select
                  class="mint-select-all"
                  value=""
                  onChange={e => {
                    selectAllFromServer(e.currentTarget.value)
                    e.currentTarget.value = ''
                  }}
                >
                  <option value="" disabled>
                    Select all from a mint...
                  </option>
                  <For each={serverNames()}>
                    {server => <option value={server}>{server}</option>}
                  </For>
                </select>
                <Show when={selected().size > 0}>
                  <span class="selection-count">
                    {selected().size} selected
                  </span>
                  <button
                    type="button"
                    class="icon-btn"
                    title="Clear selection"
                    onClick={() => setSelected(new Set<string>())}
                  >
                    <IoCloseCircleSharp />
                  </button>
                </Show>
                <Show when={spentCount() > 0}>
                  <label
                    class="switch-control"
                    title="Spent notes are locally locked (melted, or marked by hand) - this just shows or hides them, it doesn't change anything about them"
                  >
                    <IoBanSharp />
                    <span>
                      Show spent
                      <Show when={!showSpent()}>&nbsp;({spentCount()})</Show>
                    </span>
                    <span class="switch">
                      <input
                        type="checkbox"
                        checked={showSpent()}
                        onChange={e => setShowSpent(e.currentTarget.checked)}
                      />
                      <span class="switch-track"></span>
                    </span>
                  </label>
                </Show>
              </div>
              <div class="btns">
                <button
                  class="icon-btn combine-btn"
                  disabled={!canCombine() || combining() || offlineMode()}
                  title={
                    offlineMode()
                      ? 'Offline mode is on'
                      : canCombine()
                        ? 'Combine the selected notes into one'
                        : 'Select 2+ verified, unspent notes from the same mint to combine'
                  }
                  onClick={combineSelected}
                >
                  <Show when={combining()} fallback={<IoGitMergeSharp />}>
                    <IoRefreshSharp class="spin" />
                  </Show>
                  &nbsp;Combine
                  <Show when={selectedEligible().length > 0}>
                    &nbsp;({selectedEligible().length})
                  </Show>
                </button>
                <button
                  class="icon-btn split-btn"
                  disabled={!canCombine() || splitting() || offlineMode()}
                  title={
                    offlineMode()
                      ? 'Offline mode is on'
                      : canCombine()
                        ? 'Combine the selected notes and split off an amount, leaving the rest as change'
                        : 'Select 2+ verified, unspent notes from the same mint to combine & split'
                  }
                  onClick={() => setShowSplitInput(v => !v)}
                >
                  <Show when={splitting()} fallback={<IoGitBranchSharp />}>
                    <IoRefreshSharp class="spin" />
                  </Show>
                  &nbsp;Combine &amp; split
                  <Show when={selectedEligible().length > 0}>
                    &nbsp;({selectedEligible().length})
                  </Show>
                </button>
                <button
                  class="icon-btn transfer-btn"
                  disabled={!canTransfer() || offlineMode()}
                  title={
                    offlineMode()
                      ? 'Offline mode is on'
                      : canTransfer()
                        ? 'Transfer the selected note to a different mint'
                        : 'Select exactly 1 note to transfer'
                  }
                  onClick={() => setTransferSource(selectedEligible()[0])}
                >
                  <IoSwapHorizontalSharp />
                  &nbsp;Transfer
                </button>
              </div>
              <Show when={canCombine()}>
                <p class="bearer-hint">
                  If this mint charges a fee, combining refunds part of what was
                  already withheld when these notes were minted - you get back
                  all but one base fee.
                </p>
              </Show>
              <Show when={showSplitInput() && canCombine()}>
                <div class="form-item">
                  <label>
                    Split off (sats, of{' '}
                    {msatToSats(
                      selectedEligible().reduce((s, b) => s + b.amount, 0)
                    )}
                    )
                  </label>
                  <input
                    type="number"
                    min="1"
                    step="1"
                    placeholder="amount in sats"
                    value={splitSats()}
                    onInput={e => setSplitSats(e.currentTarget.value)}
                  />
                  <p class="bearer-hint">
                    Burns the {selectedEligible().length} selected notes and
                    mints two: this amount, and a change note for the rest. If
                    this mint charges a fee, it's deducted from the change, not
                    the amount split off.
                  </p>
                  <div class="btns">
                    <button
                      disabled={splitting() || offlineMode()}
                      onClick={combineAndSplit}
                    >
                      <Show when={splitting()}>
                        <IoRefreshSharp class="spin" />
                        &nbsp;
                      </Show>
                      Split
                    </button>
                    <button
                      onClick={() => {
                        setShowSplitInput(false)
                        setSplitSats('')
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              </Show>
            </section>

            <div class="bearer-list">
              <For each={displayedBearers()}>
                {bearer => (
                  <BearerCard
                    bearer={bearer}
                    selected={selected().has(bearer.id)}
                    onSelect={isSelected => toggleSelect(bearer.id, isSelected)}
                    dragging={draggingId() === bearer.id}
                    dragStyle={dragStyle(bearer.id)}
                    onDragHandleDown={
                      bearer.spent ? undefined : e => startDrag(bearer, e)
                    }
                    setRef={el => itemRefs.set(bearer.id, el)}
                  />
                )}
              </For>
            </div>
          </div>
        </Show>
      </Show>
      <Show when={transferSource()}>
        {bearer => (
          <TransferDialog
            sourceBearer={bearer()}
            onClose={() => setTransferSource(null)}
          />
        )}
      </Show>
    </Show>
  )
}
export default Wallet
