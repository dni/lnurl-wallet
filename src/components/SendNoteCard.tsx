import type {Component} from 'solid-js'
import {Show, createSignal} from 'solid-js'
import {
  IoCopySharp,
  IoQrCodeSharp,
  IoEyeSharp,
  IoEyeOffSharp,
  IoCheckmarkDoneSharp
} from 'solid-icons/io'

import type {Bearer} from '../storage'
import {useWallet} from '../WalletContext'
import {toBech32Lnurl, serverOf} from '../lnurlcash'
import {copyToClipboard, msatToSats, notify, NotifyKind} from '../helpers'
import Qr from './Qr'

export type SendNoteCardProps = {
  bearer: Bearer
}

// a "hand this note over" view for manually sending a bearer out of-band
// (Melt page's own bottom section) - copy the bech32 text, or reveal its QR
// (download-as-SVG is built into Qr itself). No protocol actions here
// (split/refresh/etc all stay on BearerCard) beyond the local spent-lock
// below - this is purely about getting a still-held note in front of
// whoever it's going to, and marking it gone once it has.
const SendNoteCard: Component<SendNoteCardProps> = props => {
  const {updateBearer, logActivity} = useWallet()

  // same two-step reveal as BearerCard used to have: the corner toggle
  // brings back the space for the QR at all, then it still sits behind its
  // own overlay until tapped, so it can't be flashed on screen by one
  // careless click. revealed always resets on the way back out.
  const [showQr, setShowQr] = createSignal(false)
  const [revealed, setRevealed] = createSignal(false)
  const toggleShowQr = () => {
    setShowQr(v => !v)
    setRevealed(false)
  }

  const token = () => toBech32Lnurl(props.bearer.url)

  // same local-only lock as BearerCard's own markSpent (see storage.ts's
  // Bearer.spent) - no network call, just stops this wallet from acting on
  // a note it considers handed away. Surfaced here once the QR is open
  // (i.e. right after actually showing it to whoever it's going to), since
  // that's the moment this note is most likely about to leave the wallet -
  // marking it spent then drops it out of this same unspent-only list.
  const markSpent = () => {
    updateBearer(props.bearer.id, {spent: true})
    logActivity(
      'spent',
      `Marked ${msatToSats(props.bearer.amount)} sats from ${serverOf(props.bearer.url)} as spent.`
    )
    notify(
      "Marked as spent - unspend it from the wallet page if it turns out it wasn't actually sent.",
      NotifyKind.SUCCESS
    )
  }

  return (
    <figure class="bearer-card">
      <div class="bearer-head">
        <div class="bearer-title">
          <span class="bearer-amount">
            {msatToSats(props.bearer.amount)} sats
          </span>
          <span class="bearer-server">{serverOf(props.bearer.url)}</span>
        </div>
      </div>
      <Show when={showQr()}>
        <div class="qr-wrapper">
          <Qr value={token()} />
          <Show when={!revealed()}>
            <button
              class="qr-overlay"
              title="Show QR code - it IS the bearer note, anyone who scans it can spend it"
              onClick={() => setRevealed(true)}
            >
              <IoEyeSharp />
            </button>
          </Show>
        </div>
      </Show>
      <div class="btns">
        <button
          class="icon-btn"
          title="Copy note (bech32 LNURL)"
          onClick={() => copyToClipboard(token())}
        >
          <IoCopySharp />
        </button>
        <button
          class="icon-btn"
          title={showQr() ? 'Hide QR code' : 'Show QR code'}
          onClick={toggleShowQr}
        >
          <Show when={showQr()} fallback={<IoQrCodeSharp />}>
            <IoEyeOffSharp />
          </Show>
        </button>
        <Show when={showQr()}>
          <button
            class="icon-btn"
            title="Mark as spent - lock this note without removing it, e.g. once you've actually handed it out"
            onClick={markSpent}
          >
            <IoCheckmarkDoneSharp />
          </button>
        </Show>
      </div>
    </figure>
  )
}
export default SendNoteCard
