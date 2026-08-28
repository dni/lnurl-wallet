import type {Component} from 'solid-js'
import {Show, createSignal, createMemo} from 'solid-js'
import {useNavigate} from '@solidjs/router'
import {
  IoClipboardSharp,
  IoCloseSharp,
  IoReturnDownForwardSharp,
  IoRefreshSharp
} from 'solid-icons/io'

import {useWallet} from '../WalletContext'
import {useDevice} from '../DeviceContext'
import {
  isValidNoteInput,
  isBolt11Invoice,
  requireNoteK1,
  serverOf,
  noteEndpointOf,
  withNewK1,
  probeBurnedNote,
  PendingNoteError,
  AmbiguousMutationError
} from '../lnurlcash'
import {receiveNote, secureReceivedNote} from '../receive'
import {deviceReceive} from '../deviceOrchestration'
import {handoffMeltInvoice} from '../meltHandoff'
import {notify, NotifyKind, msatToSats, pasteFromClipboard} from '../helpers'
import {offlineMode} from '../offlineMode'
import ScanToggle from './ScanToggle'
import NfcToggle from './NfcToggle'
import Dialog from './Dialog'

export type ReceiveDialogProps = {
  onClose: () => void
  // prefilled when the dialog was reached by opening a vault's handoff link
  // (pages/Claim.tsx). Deliberately prefilled and not auto-accepted: the
  // person should see what they are taking, and from which mint, first.
  initialValue?: string
}

// bringing a note into this wallet, scanned or pasted - same destination
// either way, so one dialog covers both instead of picking an input method
// up front
const ReceiveDialog: Component<ReceiveDialogProps> = props => {
  const {addBearer, updateBearer, bearers, logActivity} = useWallet()
  const {client: deviceClient} = useDevice()
  const navigate = useNavigate()
  let pasteRef: HTMLInputElement | null = null
  const [value, setValue] = createSignal(props.initialValue ?? '')
  const [busy, setBusy] = createSignal(false)

  const isValid = createMemo(
    () =>
      value() === '' || isValidNoteInput(value()) || isBolt11Invoice(value())
  )

  // shared by both the scanner and the paste field once they've settled on
  // a valid bearer note. Re-entrancy-guarded: Enter-key and confirm-click
  // landing together (or a scanner double-fire) must not run two receives
  // for the same k1 - both would pass receiveNote's duplicate check before
  // either addBearer landed, leaving a dead duplicate behind
  const receiveIntoWallet = async (noteValue: string) => {
    if (busy()) return
    setBusy(true)
    try {
      const received = await receiveNote(noteValue, bearers())
      const bearer = await addBearer(received)
      setValue('')
      if (!received.verified) {
        notify(
          'Note stored, but its service could not be reached - refresh it later.',
          NotifyKind.LOADING
        )
        props.onClose()
        return
      }
      // rotate immediately: whoever handed this note over still knows the
      // old secret until it is burned. If a vault is connected, that fresh
      // secret is generated and held there instead of in this browser.
      try {
        const client = deviceClient()
        if (client) {
          const result = await deviceReceive(
            client,
            received.url,
            received.callback,
            noteEndpointOf(received.url),
            requireNoteK1(received.url),
            received.amount
          )
          await updateBearer(bearer.id, {
            url: result.url,
            callback: result.callback,
            deviceId: result.deviceId
          })
        } else {
          const url = await secureReceivedNote(received)
          await updateBearer(bearer.id, {url})
        }
        logActivity(
          'receive',
          `Received ${msatToSats(received.amount)} sats from ${serverOf(received.url)}.`
        )
        notify(
          `Received ${msatToSats(received.amount)} sats - secret rotated, previous copies are burned.`,
          NotifyKind.SUCCESS
        )
      } catch (err) {
        if (err instanceof AmbiguousMutationError) {
          // the rotate request may have landed despite the failure - the
          // fresh secret it carried is then the only copy of this note
          const outcome = await probeBurnedNote(received.url)
          if (outcome === 'gone') {
            // the burn landed - adopt the fresh secret as the note
            const url = withNewK1(
              received.url,
              err.newSecrets[0],
              received.amount
            )
            await updateBearer(bearer.id, {url})
            logActivity(
              'receive',
              `Received ${msatToSats(received.amount)} sats from ${serverOf(received.url)} (rotated - confirmed on re-check after an uncertain response).`
            )
            notify(
              `Received ${msatToSats(received.amount)} sats - secret rotated, previous copies are burned.`,
              NotifyKind.SUCCESS
            )
            props.onClose()
            return
          }
          if (outcome === 'unknown') {
            // can't tell: keep the stored original AND track the possible
            // rotated copy, rather than gamble either way
            await addBearer({
              url: withNewK1(received.url, err.newSecrets[0], received.amount),
              callback: received.callback,
              amount: received.amount,
              verified: false,
              mintPubkey: received.mintPubkey
            })
            logActivity(
              'receive',
              `Received ${msatToSats(received.amount)} sats from ${serverOf(received.url)} (rotation outcome uncertain - the possible rotated copy is stored unverified).`
            )
            notify(
              `Received ${msatToSats(received.amount)} sats, but the rotation's outcome is uncertain - the possible new copy is stored unverified alongside the original; refresh both to reconcile.`,
              NotifyKind.ERROR
            )
            props.onClose()
            return
          }
          // 'live': the rotate never landed - the messages below fit as-is
        }
        // a PendingNoteError here means this exact k1 has some other
        // operation in flight on the service right now (e.g. the sender's
        // own melt/rotate hasn't settled yet) - temporary, and the note
        // is already stored (addBearer above), so it'll simply rotate on
        // the next refresh. Reporting it the same as every other failure
        // ("the service refused to rotate") reads as a permanent
        // limitation instead of "try again shortly" (see issue #3).
        const pending = err instanceof PendingNoteError
        logActivity(
          'receive',
          `Received ${msatToSats(received.amount)} sats from ${serverOf(received.url)} (${pending ? 'rotate pending - will retry on next refresh' : 'not rotated - sender may still hold a copy'}).`
        )
        notify(
          pending
            ? `Received ${msatToSats(received.amount)} sats, but couldn't rotate yet - this note has another operation in progress on the service. It'll rotate automatically next time you refresh it.`
            : `Received ${msatToSats(received.amount)} sats, but the service refused to rotate - the sender may still hold a spendable copy.`,
          NotifyKind.ERROR
        )
      }
      props.onClose()
    } catch (err) {
      notify((err as Error).message, NotifyKind.ERROR)
    } finally {
      setBusy(false)
    }
  }

  // this wallet has no Lightning node of its own - paying an invoice is its
  // own dialog on the Melt page, reachable from the main nav. The invoice
  // travels via an in-memory handoff (meltHandoff.ts), not a URL param -
  // with the hash router a ?pr= would land in location.hash, hence in
  // browser history and bookmarks
  const goToMelt = (pr: string) => {
    props.onClose()
    handoffMeltInvoice(pr)
    navigate('/melt')
  }

  // scanning stays bearer-notes-only (a camera pointed at someone else's
  // invoice to pay is an unlikely scenario anyway) - pasting is the one
  // that also takes a bolt11, since that's realistically typed/pasted in
  const onScan = (scanned: string) => receiveIntoWallet(scanned)

  const handlePaste = async () => {
    if (value() === '') return
    if (isBolt11Invoice(value())) {
      goToMelt(value())
      setValue('')
      return
    }
    if (!isValidNoteInput(value())) {
      notify(
        'Not a valid LNURLcash bearer note or bolt11 invoice.',
        NotifyKind.ERROR
      )
      return
    }
    await receiveIntoWallet(value())
  }

  const paste = async () => {
    const text = await pasteFromClipboard()
    if (text !== null) {
      setValue(text)
      pasteRef?.focus()
      handlePaste()
    }
  }

  const onKeydown = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handlePaste()
    }
  }

  return (
    <Dialog onClose={props.onClose}>
      <figure class="setup-card">
        <figcaption>Bring in a bearer note</figcaption>
        <div class="paste-input-row">
          <ScanToggle onScan={onScan} accept={isValidNoteInput} />
          <NfcToggle onScan={onScan} accept={isValidNoteInput} />
          <button
            type="button"
            class="icon-btn paste-icon-btn"
            title="Paste from clipboard"
            onClick={paste}
          >
            <IoClipboardSharp />
          </button>
          <div class="paste-input-wrapper">
            <input
              ref={pasteRef}
              type="text"
              class="paste-input"
              classList={{invalid: value() !== '' && !isValid()}}
              placeholder="lnurl1... / lnurlw://...?k1=... / lnbc1..."
              value={value()}
              onInput={e => setValue(e.currentTarget.value)}
              onKeyDown={onKeydown}
            />
            <Show when={value() !== ''}>
              <button
                type="button"
                class="icon-btn paste-clear-btn"
                title="Clear"
                onClick={() => setValue('')}
              >
                <IoCloseSharp />
              </button>
            </Show>
          </div>
          <button
            type="button"
            class="icon-btn paste-confirm-btn"
            title={offlineMode() ? 'Offline mode is on' : 'Add to wallet'}
            disabled={busy() || value() === '' || !isValid() || offlineMode()}
            onClick={handlePaste}
          >
            <Show when={busy()} fallback={<IoReturnDownForwardSharp />}>
              <IoRefreshSharp class="spin" />
            </Show>
          </button>
        </div>
        <Show when={value() !== '' && !isValid()}>
          <p class="warning">
            Not a valid LNURLcash bearer note (an LNURL-withdraw link carrying a
            k1) or bolt11 invoice.
          </p>
        </Show>
      </figure>
    </Dialog>
  )
}
export default ReceiveDialog
