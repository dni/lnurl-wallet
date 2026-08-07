import type {Component} from 'solid-js'
import {Show, createSignal, createMemo} from 'solid-js'
import {
  IoCopySharp,
  IoGitMergeSharp,
  IoRefreshSharp,
  IoCheckboxSharp,
  IoSquareOutline
} from 'solid-icons/io'

import type {Bearer} from '../storage'
import {useWallet} from '../WalletContext'
import {noteK1, withNewK1, mergeNotes} from '../lnurlcash'
import {getTrustedMintPubkey} from '../trustedMints'
import {notify, NotifyKind, msatToSats, copyToClipboard} from '../helpers'

export type MintGroupCardProps = {
  server: string
  group: Bearer[]
  selected: Set<string>
  onSelectAll: (ids: string[], isSelected: boolean) => void
}

const MintGroupCard: Component<MintGroupCardProps> = props => {
  const {addBearer, removeBearer} = useWallet()
  const [combining, setCombining] = createSignal(false)

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

  // merging burns whichever of this group's notes are currently selected
  // (checkbox on each BearerCard, or the Select all button below) - not
  // every eligible note in the group regardless of selection
  const selectedEligible = createMemo(() =>
    props.group.filter(
      b => props.selected.has(b.id) && b.callback !== '' && !b.spent
    )
  )
  const canCombine = createMemo(() => selectedEligible().length >= 2)

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
        <button
          disabled={selectableIds().length === 0}
          title={
            allSelected() ? 'Deselect all notes here' : 'Select all notes here'
          }
          onClick={() => props.onSelectAll(selectableIds(), !allSelected())}
        >
          <Show when={allSelected()} fallback={<IoCheckboxSharp />}>
            <IoSquareOutline />
          </Show>
          &nbsp;{allSelected() ? 'Deselect all' : 'Select all'}
        </button>
        <button
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
          &nbsp;Combine selected
        </button>
      </div>
    </figure>
  )
}
export default MintGroupCard
