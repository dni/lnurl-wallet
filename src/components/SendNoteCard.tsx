import type {Component} from 'solid-js'
import {Show, createSignal} from 'solid-js'
import {
  IoCopySharp,
  IoQrCodeSharp,
  IoEyeSharp,
  IoEyeOffSharp,
  IoCheckmarkDoneSharp,
  IoRefreshSharp
} from 'solid-icons/io'

import type {Bearer} from '../storage'
import {useWallet} from '../WalletContext'
import {useDevice} from '../DeviceContext'
import {toBech32Lnurl, serverOf} from '../lnurlcash'
import {deviceExportForHandoff, deviceMarkSpent} from '../deviceOrchestration'
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
  const {client: deviceClient} = useDevice()

  // same two-step reveal as BearerCard used to have: the corner toggle
  // brings back the space for the QR at all, then it still sits behind its
  // own overlay until tapped, so it can't be flashed on screen by one
  // careless click. revealed always resets on the way back out.
  const [showQr, setShowQr] = createSignal(false)
  const [revealed, setRevealed] = createSignal(false)

  // a device-backed note's real secret is null until explicitly exported
  // (physical button press, up to ~35s) - a browser-only note already has
  // it in hand (props.bearer.url IS the note), nothing to wait for
  const [exportedUrl, setExportedUrl] = createSignal<string | null>(null)
  const [exporting, setExporting] = createSignal(false)

  const realUrl = () =>
    props.bearer.deviceId ? exportedUrl() : props.bearer.url
  const token = () => {
    const url = realUrl()
    return url ? toBech32Lnurl(url) : null
  }

  // no-op once already exported this session, or for a browser-only note.
  // Never called just because this card rendered - only from an explicit
  // copy/reveal click.
  const ensureRevealed = async (): Promise<boolean> => {
    if (realUrl()) return true
    const deviceId = props.bearer.deviceId
    const client = deviceClient()
    if (!deviceId || !client) {
      notify(
        'Vault not connected - reconnect to reveal this note.',
        NotifyKind.ERROR
      )
      return false
    }
    setExporting(true)
    try {
      const {url} = await deviceExportForHandoff(
        client,
        deviceId,
        props.bearer.url,
        props.bearer.amount
      )
      setExportedUrl(url)
      return true
    } catch (err) {
      notify((err as Error).message, NotifyKind.ERROR)
      return false
    } finally {
      setExporting(false)
    }
  }

  const copyNote = async () => {
    if (!(await ensureRevealed())) return
    copyToClipboard(token()!)
  }

  const toggleShowQr = async () => {
    if (showQr()) {
      setShowQr(false)
      setRevealed(false)
      return
    }
    if (!(await ensureRevealed())) return
    setShowQr(true)
    setRevealed(false)
  }

  // same local-only lock as BearerCard's own markSpent (see storage.ts's
  // Bearer.spent) - no network call, just stops this wallet from acting on
  // a note it considers handed away. Surfaced here once the QR is open
  // (i.e. right after actually showing it to whoever it's going to), since
  // that's the moment this note is most likely about to leave the wallet -
  // marking it spent then drops it out of this same unspent-only list. For
  // a device-backed note this is also the point the device's own copy is
  // retired (deviceMarkSpent) - not on export/reveal, which by itself
  // doesn't mean the note actually left this wallet yet.
  const markSpent = async () => {
    updateBearer(props.bearer.id, {spent: true})
    const deviceId = props.bearer.deviceId
    const client = deviceClient()
    if (deviceId && client) await deviceMarkSpent(client, deviceId)
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
        <Show when={token()}>
          {url => (
            <div class="qr-wrapper">
              <Qr value={url()} />
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
          )}
        </Show>
      </Show>
      <div class="btns">
        <button
          class="icon-btn"
          title={
            props.bearer.deviceId
              ? 'Copy note (exports the secret from your vault first)'
              : 'Copy note (bech32 LNURL)'
          }
          disabled={exporting()}
          onClick={copyNote}
        >
          <Show when={exporting()} fallback={<IoCopySharp />}>
            <IoRefreshSharp class="spin" />
          </Show>
        </button>
        <button
          class="icon-btn"
          title={
            exporting()
              ? 'Waiting for the vault...'
              : showQr()
                ? 'Hide QR code'
                : props.bearer.deviceId
                  ? 'Show QR code (exports the secret from your vault first)'
                  : 'Show QR code'
          }
          disabled={exporting()}
          onClick={toggleShowQr}
        >
          <Show when={!exporting()} fallback={<IoRefreshSharp class="spin" />}>
            <Show when={showQr()} fallback={<IoQrCodeSharp />}>
              <IoEyeOffSharp />
            </Show>
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
