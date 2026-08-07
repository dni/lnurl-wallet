import type {Component} from 'solid-js'
import {Show, For, createSignal, createMemo} from 'solid-js'
import {
  IoCopySharp,
  IoGitMergeSharp,
  IoSwapHorizontalSharp,
  IoRefreshSharp,
  IoCheckboxSharp,
  IoSquareOutline,
  IoListSharp
} from 'solid-icons/io'

import type {Bearer} from '../storage'
import {useWallet} from '../WalletContext'
import {noteK1, withNewK1, mergeNotes} from '../lnurlcash'
import {getTrustedMintPubkey} from '../trustedMints'
import {notify, NotifyKind, msatToSats, copyToClipboard} from '../helpers'
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
  const {addBearer, removeBearer} = useWallet()
  const [combining, setCombining] = createSignal(false)
  // collapsed by default - a long wallet would otherwise render every
  // note's full card (QR toggle, actions, ...) up front for nothing
  const [showNotes, setShowNotes] = createSignal(false)
  // captured once Transfer is clicked, independent of live selection -
  // starting a transfer immediately marks the source spent, which would
  // otherwise drop it out of selectedEligible() and yank the dialog out
  // from under itself mid-flight
  const [transferSource, setTransferSource] = createSignal<Bearer | null>(null)

  const total = createMemo(() =>
    props.group.reduce((sum, b) => sum + b.amount, 0)
  )

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
      for (const bearer of picked) removeBearer(bearer.id)
      await addBearer({
        url: withNewK1(base.url, merged.k1, sum, merged.signature),
        callback: base.callback,
        amount: sum,
        verified: true,
        mintPubkey: base.mintPubkey
      })
      props.onSelectAll(
        picked.map(b => b.id),
        false
      )
      notify(`Combined ${picked.length} notes into one.`, NotifyKind.SUCCESS)
    } catch (err) {
      notify((err as Error).message, NotifyKind.ERROR)
    } finally {
      setCombining(false)
    }
  }

  return (
    <>
      <figure class="setup-card mint-group-card">
        <figcaption>
          {props.server}&nbsp;·&nbsp;{msatToSats(total())} sats
        </figcaption>
        <Show when={mintPubkey()}>
          <p class="bearer-hint mint-pubkey">
            <code>{mintPubkey()}</code>
          </p>
        </Show>
        <div class="btns">
          <button
            class="icon-btn"
            title="Copy mint pubkey"
            disabled={!mintPubkey()}
            onClick={() => copyToClipboard(mintPubkey()!)}
          >
            <IoCopySharp />
          </button>
          <button class="show-notes-btn" onClick={() => setShowNotes(v => !v)}>
            <IoListSharp />
            &nbsp;{showNotes() ? 'Hide notes' : 'Show notes'}&nbsp;(
            {props.group.length})
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
              disabled={!canCombine() || combining()}
              title={
                canCombine()
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
              disabled={!canTransfer()}
              title={
                canTransfer()
                  ? 'Transfer the selected note to a different mint'
                  : 'Select exactly 1 note here to transfer'
              }
              onClick={() => setTransferSource(selectedEligible()[0])}
            >
              <IoSwapHorizontalSharp />
            </button>
          </Show>
        </div>
        <Show when={showNotes()}>
          <div class="bearer-list">
            <For each={props.group}>
              {bearer => (
                <BearerCard
                  bearer={bearer}
                  selected={props.selected.has(bearer.id)}
                  onSelect={isSelected => props.onSelect(bearer.id, isSelected)}
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
