import type {Component} from 'solid-js'
import {Show, createSignal, createMemo} from 'solid-js'
import {
  IoCopySharp,
  IoGitMergeSharp,
  IoSwapHorizontalSharp,
  IoRefreshSharp
} from 'solid-icons/io'

import type {Bearer} from '../storage'
import {useWallet} from '../WalletContext'
import {
  noteK1,
  withNewK1,
  mergeNotes,
  rotateNote,
  toBech32Lnurl
} from '../lnurlcash'
import {getTrustedMintPubkey} from '../trustedMints'
import {notify, NotifyKind, msatToSats, copyToClipboard} from '../helpers'
import Qr from './Qr'

export type MintGroupCardProps = {
  server: string
  group: Bearer[]
}

const MintGroupCard: Component<MintGroupCardProps> = props => {
  const {addBearer, removeBearer, updateBearer} = useWallet()
  const [combining, setCombining] = createSignal(false)
  const [transferring, setTransferring] = createSignal(false)
  // set once a transfer rotated the secret - the fresh note to hand over,
  // same handover-confirm flow as BearerCard's own single-note transfer
  const [handover, setHandover] = createSignal<string | null>(null)

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

  // merging burns every eligible note in one callback request - unverified
  // or already-spent ones in the group just sit out rather than blocking it
  const eligibleForCombine = createMemo(() =>
    props.group.filter(b => b.callback !== '' && !b.spent)
  )
  const canCombineAll = createMemo(() => eligibleForCombine().length >= 2)

  // transfer rotates and hands over a single note - with more than one in
  // the group there's no single secret to rotate, so this only lights up
  // for a group that's down to exactly one
  const canTransfer = createMemo(
    () =>
      props.group.length === 1 &&
      props.group[0].callback !== '' &&
      !props.group[0].spent
  )

  const combineAll = async () => {
    const picked = eligibleForCombine()
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
      notify(`Combined ${picked.length} notes into one.`, NotifyKind.SUCCESS)
    } catch (err) {
      notify((err as Error).message, NotifyKind.ERROR)
    } finally {
      setCombining(false)
    }
  }

  const transfer = async () => {
    if (!canTransfer()) return
    const bearer = props.group[0]
    setTransferring(true)
    try {
      const rotated = await rotateNote(bearer.callback, noteK1(bearer.url)!)
      const url = withNewK1(
        bearer.url,
        rotated.k1,
        bearer.amount,
        rotated.signature
      )
      await updateBearer(bearer.id, {url})
      setHandover(toBech32Lnurl(url))
    } catch (err) {
      notify((err as Error).message, NotifyKind.ERROR)
    } finally {
      setTransferring(false)
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
          disabled={!canCombineAll() || combining()}
          title={
            canCombineAll()
              ? 'Combine every eligible note here into one'
              : 'Needs at least 2 verified, unspent notes'
          }
          onClick={combineAll}
        >
          <Show when={combining()} fallback={<IoGitMergeSharp />}>
            <IoRefreshSharp class="spin" />
          </Show>
          &nbsp;Combine all
        </button>
        <button
          disabled={!canTransfer() || transferring()}
          title={
            canTransfer()
              ? 'Transfer - rotate the secret and hand the fresh note over'
              : 'Only possible with a single note'
          }
          onClick={transfer}
        >
          <Show when={transferring()} fallback={<IoSwapHorizontalSharp />}>
            <IoRefreshSharp class="spin" />
          </Show>
          &nbsp;Transfer
        </button>
      </div>
      <Show when={handover()}>
        <p class="warning">
          Secret rotated - this QR is the fresh note. Hand it to the recipient;
          your old copy is already burned.
        </p>
        <Qr value={handover()!} />
        <div class="btns">
          <button
            onClick={() => {
              updateBearer(props.group[0].id, {spent: true})
              setHandover(null)
              notify('Marked as handed over and spent.', NotifyKind.SUCCESS)
            }}
          >
            Handed over
          </button>
          <button onClick={() => setHandover(null)}>Keep it myself</button>
        </div>
      </Show>
    </figure>
  )
}
export default MintGroupCard
