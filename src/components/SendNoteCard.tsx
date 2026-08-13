import type {Component} from 'solid-js'
import {Show, createSignal} from 'solid-js'
import {
  IoCopySharp,
  IoQrCodeSharp,
  IoEyeSharp,
  IoEyeOffSharp
} from 'solid-icons/io'

import type {Bearer} from '../storage'
import {toBech32Lnurl, serverOf} from '../lnurlcash'
import {copyToClipboard, msatToSats} from '../helpers'
import Qr from './Qr'

export type SendNoteCardProps = {
  bearer: Bearer
}

// a read-only "hand this note over" view for manually sending a bearer out
// of-band (Melt page's own bottom section) - copy the bech32 text, or
// reveal its QR (download-as-SVG is built into Qr itself). No protocol
// actions here (split/refresh/spent/etc all stay on BearerCard) - this is
// purely about getting a still-held note in front of whoever it's going to.
const SendNoteCard: Component<SendNoteCardProps> = props => {
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
      </div>
    </figure>
  )
}
export default SendNoteCard
