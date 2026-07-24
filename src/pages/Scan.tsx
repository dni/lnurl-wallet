import type {Component} from 'solid-js'
import {Show, createSignal} from 'solid-js'
import {useNavigate} from '@solidjs/router'

import {useWallet} from '../WalletContext'
import {isValidNoteInput} from '../lnurlcash'
import {receiveNote, secureReceivedNote} from '../receive'
import {notify, NotifyKind, msatToSats} from '../helpers'
import Scanner from '../components/Scanner'
import RequireWallet from '../components/RequireWallet'

const Scan: Component = () => {
  const {addBearer, updateBearer, bearers} = useWallet()
  const navigate = useNavigate()
  const [busy, setBusy] = createSignal(false)

  const onScan = async (value: string) => {
    setBusy(true)
    try {
      const received = await receiveNote(value, bearers())
      const bearer = await addBearer(received)
      if (!received.verified) {
        notify(
          'Note stored, but its service could not be reached - refresh it later.',
          NotifyKind.LOADING
        )
        navigate('/')
        return
      }
      // rotate immediately: whoever showed us this QR still knows the old
      // secret until it is burned
      try {
        const url = await secureReceivedNote(received)
        await updateBearer(bearer.id, {url})
        notify(
          `Received ${msatToSats(received.amount)} sats - secret rotated, previous copies are burned.`,
          NotifyKind.SUCCESS
        )
      } catch {
        notify(
          `Received ${msatToSats(received.amount)} sats, but the service refused to rotate - the sender may still hold a spendable copy.`,
          NotifyKind.ERROR
        )
      }
      navigate('/')
    } catch (err) {
      notify((err as Error).message, NotifyKind.ERROR)
    } finally {
      setBusy(false)
    }
  }

  return (
    <RequireWallet>
      <div id="scan" class="page">
        <h2>Scan a bearer note</h2>
        <figure class="setup-card">
          <figcaption>
            Point the camera at a note QR (<code>lnurl1...</code> or{' '}
            <code>lnurlw://...?k1=...</code>)
          </figcaption>
          <Show when={!busy()} fallback={<p>Adding note...</p>}>
            <Scanner onScan={onScan} accept={isValidNoteInput} />
          </Show>
        </figure>
      </div>
    </RequireWallet>
  )
}
export default Scan
