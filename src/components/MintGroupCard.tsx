import type {Component} from 'solid-js'
import {Show, For, createSignal, createMemo} from 'solid-js'
import {
  IoCopySharp,
  IoGitMergeSharp,
  IoSwapHorizontalSharp,
  IoRefreshSharp,
  IoCheckboxSharp,
  IoSquareOutline,
  IoListSharp,
  IoOpenSharp,
  IoGlobeSharp,
  IoBanSharp,
  IoTrashSharp,
  IoReorderThreeSharp
} from 'solid-icons/io'

import type {Bearer} from '../storage'
import {compareBearerOrder} from '../storage'
import {useWallet} from '../WalletContext'
import {
  noteK1,
  withNewK1,
  mergeNotes,
  fetchNoteInfo,
  rotateNote
} from '../lnurlcash'
import {getTrustedMintPubkey} from '../trustedMints'
import {offlineMode} from '../offlineMode'
import {
  notify,
  NotifyKind,
  msatToSats,
  copyToClipboard,
  mempoolNodeUrl
} from '../helpers'
import BearerCard from './BearerCard'
import TransferDialog from './TransferDialog'

export type MintGroupCardProps = {
  server: string
  group: Bearer[]
  selected: Set<string>
  onSelect: (id: string, isSelected: boolean) => void
  onSelectAll: (ids: string[], isSelected: boolean) => void
}

const MintGroupCard: Component<MintGroupCardProps> = props => {
  const {addBearer, updateBearer, removeBearer} = useWallet()
  const [combining, setCombining] = createSignal(false)
  // collapsed by default - a long wallet would otherwise render every
  // note's full card (QR toggle, actions, ...) up front for nothing
  const [showNotes, setShowNotes] = createSignal(false)
  // per-mint spent visibility (was a single wallet-wide toggle - each mint
  // group now controls its own, mirroring the per-mint clear button below)
  const [showSpent, setShowSpent] = createSignal(false)
  const [confirmClearSpent, setConfirmClearSpent] = createSignal(false)
  // captured once Transfer is clicked, independent of live selection -
  // starting a transfer immediately marks the source spent, which would
  // otherwise drop it out of selectedEligible() and yank the dialog out
  // from under itself mid-flight
  const [transferSource, setTransferSource] = createSignal<Bearer | null>(null)

  // props.group holds every note for this mint, spent or not, in whatever
  // order the wallet's bearers() happens to be in - orderedGroup is the one
  // that actually reflects display order (manual drag rank, falling back to
  // newest-first - see compareBearerOrder)
  const orderedGroup = createMemo(() =>
    [...props.group].sort(compareBearerOrder)
  )
  // "Total" stays spendable-only regardless of the showSpent toggle, same
  // as the wallet-wide hero total
  const spendableGroup = createMemo(() => orderedGroup().filter(b => !b.spent))
  const spentGroup = createMemo(() => orderedGroup().filter(b => b.spent))
  const spentCount = createMemo(() => spentGroup().length)
  const visibleGroup = createMemo(() =>
    showSpent() ? orderedGroup() : spendableGroup()
  )
  const total = createMemo(() =>
    spendableGroup().reduce((sum, b) => sum + b.amount, 0)
  )

  // drag-to-reorder: dragPreview mirrors visibleGroup but is live-spliced
  // on every pointermove for instant feedback, and only ever committed
  // (persisted as sortIndex) on drop - see startDrag below. Refs are
  // grabbed per-card so pointermove can measure who the pointer is
  // currently over, regardless of the list's flex-wrap layout
  const itemRefs = new Map<string, HTMLElement>()
  const [dragPreview, setDragPreview] = createSignal<Bearer[] | null>(null)
  const [draggingId, setDraggingId] = createSignal<string | null>(null)
  // the dragged card's own position while held - it's pulled out of the
  // list's normal flex flow (position: fixed, see dragStyle below) and
  // instead floats to follow the pointer directly, rather than being one
  // of the tiles that reflow in place. Without this the dragged card was
  // just another grid tile jumping between slots on every reorder, which
  // read as flicker since nothing visually tracked the pointer
  const [dragPointerPos, setDragPointerPos] = createSignal<{
    x: number
    y: number
  } | null>(null)
  let dragPointerId: number | null = null
  let dragGrabDx = 0
  let dragGrabDy = 0
  let dragWidth = 0
  // coalesces pointermove into at most one measure+splice per frame -
  // interleaving getBoundingClientRect reads with the style writes those
  // splices cause forces a synchronous layout on every single pointermove
  // otherwise, which is its own source of visible jank on top of the
  // reorder logic itself
  let pendingMoveEvent: PointerEvent | null = null
  let rafScheduled = false

  const displayedGroup = createMemo(() => dragPreview() ?? visibleGroup())

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
    // hit-test (pointer literally over a card), not nearest-by-distance -
    // distance-to-center flips between two equally-close neighbors on the
    // tiniest jitter, which was the other half of the flicker
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
    // land ON the target's current slot (pushing it, and everything after,
    // one further) rather than after it - removing fromIndex first shifts
    // every later index down by one, so a forward move's target needs the
    // same correction
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
    setDragPreview(visibleGroup().slice())
    document.body.classList.add('dragging-note')
    window.addEventListener('pointermove', onDragMove)
    window.addEventListener('pointerup', endDrag)
    window.addEventListener('pointercancel', endDrag)
  }

  // a per-mint version of Wallet.tsx's own bulk Clear - each spent note is
  // just a local record at this point (see storage.ts's Bearer.spent), so
  // this is a plain local removal, not a service call
  const clearMintSpent = () => {
    const spent = spentGroup()
    for (const bearer of spent) removeBearer(bearer.id)
    setConfirmClearSpent(false)
    setShowSpent(false)
    notify(
      `Cleared ${spent.length} spent note${spent.length === 1 ? '' : 's'} from ${props.server}.`,
      NotifyKind.SUCCESS
    )
  }

  // the trusted-mints registry can hold a newer key than any one bearer's
  // own cached copy (e.g. a sibling note refreshed more recently) - same
  // preference BearerCard's offlineVerified uses
  const mintPubkey = createMemo(
    () =>
      getTrustedMintPubkey(props.server) ??
      props.group.find(b => b.mintPubkey)?.mintPubkey ??
      null
  )

  // combine and transfer both act on whichever of this group's notes are
  // currently selected (checkbox on each BearerCard, or Select all below)
  const selectedEligible = createMemo(() =>
    props.group.filter(
      b => props.selected.has(b.id) && b.callback !== '' && !b.spent
    )
  )
  const canCombine = createMemo(() => selectedEligible().length >= 2)
  const canTransfer = createMemo(() => selectedEligible().length === 1)

  // select/deselect all: only unspent notes are ever selectable (see
  // BearerCard, whose own checkbox is disabled once a note is spent)
  const selectableIds = createMemo(() =>
    props.group.filter(b => !b.spent).map(b => b.id)
  )
  const allSelected = createMemo(
    () =>
      selectableIds().length > 0 &&
      selectableIds().every(id => props.selected.has(id))
  )

  const combineSelected = async () => {
    const picked = selectedEligible()
    if (picked.length < 2) return
    setCombining(true)
    try {
      const [base] = picked
      const sum = picked.reduce((s, b) => s + b.amount, 0)
      const merged = await mergeNotes(
        base.callback,
        picked.map(b => noteK1(b.url)!)
      )
      // a mint MAY refund part of its earlier per-note mint fees on merge
      // (LUD-25: (n - 1) * base_fee_msat back into the result) - read the
      // actual value back authoritatively (informational GET) rather than
      // assume the naive sum, so both the stored amount and the notice
      // below reflect what the mint actually credited
      const mergedInfo = await fetchNoteInfo(
        withNewK1(base.url, merged.k1, sum, merged.signature)
      )
      const actualAmount = mergedInfo.maxWithdrawable
      // that informational GET just put the merged secret on the wire -
      // same as BearerCard's refresh()/split(), rotate it before it's
      // stored rather than keep circulating an exposed copy
      let finalK1 = merged.k1
      let finalSignature = merged.signature
      try {
        const rotated = await rotateNote(mergedInfo.callback, finalK1)
        finalK1 = rotated.k1
        finalSignature = rotated.signature
      } catch {
        // service doesn't support rotation - keep the GET-exposed secret,
        // same tolerance refresh() shows
      }
      for (const bearer of picked) removeBearer(bearer.id)
      await addBearer({
        url: withNewK1(base.url, finalK1, actualAmount, finalSignature),
        callback: base.callback,
        amount: actualAmount,
        verified: true,
        mintPubkey: base.mintPubkey
      })
      props.onSelectAll(
        picked.map(b => b.id),
        false
      )
      const creditMsat = actualAmount - sum
      notify(
        `Combined ${picked.length} notes into one.` +
          (creditMsat > 0
            ? ` ${msatToSats(creditMsat)} sats fee credited back.`
            : ''),
        NotifyKind.SUCCESS
      )
    } catch (err) {
      notify((err as Error).message, NotifyKind.ERROR)
    } finally {
      setCombining(false)
    }
  }

  return (
    <>
      <figure class="setup-card mint-group-card">
        <figcaption class="mint-group-caption">
          <span>
            {props.server}&nbsp;·&nbsp;{msatToSats(total())} sats
          </span>
          <span class="mint-group-caption-links">
            <button
              class="icon-btn"
              title="Copy mint pubkey"
              disabled={!mintPubkey()}
              onClick={() => copyToClipboard(mintPubkey()!)}
            >
              <IoCopySharp />
            </button>
            <a
              class="icon-btn"
              title="Open this mint"
              href={`https://${props.server}`}
              target="_blank"
              rel="noreferrer"
            >
              <IoGlobeSharp />
            </a>
            <Show when={mintPubkey()}>
              <a
                class="icon-btn"
                title="Look up this mint's Lightning node on mempool.space"
                href={mempoolNodeUrl(mintPubkey()!)}
                target="_blank"
                rel="noreferrer"
              >
                <IoOpenSharp />
              </a>
            </Show>
            <Show when={spentCount() > 0}>
              <button
                class="icon-btn"
                title={`Clear all ${spentCount()} spent note${spentCount() === 1 ? '' : 's'} from ${props.server}`}
                onClick={() => setConfirmClearSpent(true)}
              >
                <IoTrashSharp />
              </button>
            </Show>
          </span>
        </figcaption>
        <Show when={mintPubkey()}>
          <p class="bearer-hint mint-pubkey">
            <code>{mintPubkey()}</code>
          </p>
        </Show>
        <Show when={confirmClearSpent()}>
          <p class="warning">
            Clear all {spentCount()} spent note
            {spentCount() === 1 ? '' : 's'} from {props.server}? If any of them
            turn out not to have actually been spent, those sats are gone unless
            you saved them elsewhere.
          </p>
          <div class="btns">
            <button onClick={clearMintSpent}>Clear all</button>
            <button onClick={() => setConfirmClearSpent(false)}>Cancel</button>
          </div>
        </Show>
        <div class="btns">
          <button class="show-notes-btn" onClick={() => setShowNotes(v => !v)}>
            <IoListSharp />
            &nbsp;{showNotes() ? 'Hide notes' : 'Show notes'}&nbsp;(
            {visibleGroup().length})
          </button>
          <Show when={showNotes()}>
            <button
              class="select-all-btn"
              disabled={selectableIds().length === 0}
              title={
                allSelected()
                  ? 'Deselect all notes here'
                  : 'Select all notes here'
              }
              onClick={() => props.onSelectAll(selectableIds(), !allSelected())}
            >
              <Show when={allSelected()} fallback={<IoSquareOutline />}>
                <IoCheckboxSharp />
              </Show>
              &nbsp;{allSelected() ? 'Deselect all' : 'Select all'}
            </button>
            <button
              class="icon-btn combine-btn"
              disabled={!canCombine() || combining() || offlineMode()}
              title={
                offlineMode()
                  ? 'Offline mode is on'
                  : canCombine()
                    ? 'Combine the selected notes into one'
                    : 'Select 2+ verified, unspent notes here to combine'
              }
              onClick={combineSelected}
            >
              <Show when={combining()} fallback={<IoGitMergeSharp />}>
                <IoRefreshSharp class="spin" />
              </Show>
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
                    : 'Select exactly 1 note here to transfer'
              }
              onClick={() => setTransferSource(selectedEligible()[0])}
            >
              <IoSwapHorizontalSharp />
            </button>
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
          </Show>
        </div>
        <Show when={showNotes() && canCombine()}>
          <p class="bearer-hint">
            If this mint charges a fee, combining refunds part of what was
            already withheld when these notes were minted - you get back all but
            one base fee.
          </p>
        </Show>
        <Show when={showNotes()}>
          <div class="bearer-list">
            <For each={displayedGroup()}>
              {bearer => (
                <BearerCard
                  bearer={bearer}
                  selected={props.selected.has(bearer.id)}
                  onSelect={isSelected => props.onSelect(bearer.id, isSelected)}
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
        </Show>
      </figure>
      <Show when={transferSource()}>
        {bearer => (
          <TransferDialog
            sourceBearer={bearer()}
            onClose={() => setTransferSource(null)}
          />
        )}
      </Show>
    </>
  )
}
export default MintGroupCard
