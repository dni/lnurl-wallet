import type {Component} from 'solid-js'
import {Show, createSignal} from 'solid-js'
import {useNavigate} from '@solidjs/router'

import {useWallet} from '../WalletContext'
import {isValidCashInput} from '../lnurlcash'
import {receiveCash} from '../receive'
import {notify, NotifyKind, msatToSats} from '../helpers'
import Scanner from '../components/Scanner'
import RequireWallet from '../components/RequireWallet'

const Scan: Component = () => {
  const {addBearer, bearers} = useWallet()
  const navigate = useNavigate()
  const [busy, setBusy] = createSignal(false)

  const onScan = async (value: string) => {
    setBusy(true)
    try {
      const received = await receiveCash(value, bearers())
      await addBearer(received.url, received.amount, received.pending)
      if (received.verified) {
        notify(
          `Added a bearer of ${msatToSats(received.amount)} sats.`,
          NotifyKind.SUCCESS
        )
      } else {
        notify(
          'Bearer stored, but its server could not be reached - refresh it later.',
          NotifyKind.LOADING
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
        <h2>Scan LNURLcash</h2>
        <figure class="setup-card">
          <figcaption>
            Point the camera at an <code>lnurlcash1...</code> QR code
          </figcaption>
          <Show when={!busy()} fallback={<p>Adding bearer...</p>}>
            <Scanner onScan={onScan} accept={isValidCashInput} />
          </Show>
        </figure>
      </div>
    </RequireWallet>
  )
}
export default Scan
