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
import {isValidNoteInput, isBolt11Invoice} from '../lnurlcash'
import {receiveNote, secureReceivedNote} from '../receive'
import {notify, NotifyKind, msatToSats, pasteFromClipboard} from '../helpers'
import Scanner from '../components/Scanner'
import RequireWallet from '../components/RequireWallet'

// bringing a note into this wallet, scanned or pasted - same destination
// either way, so one page covers both instead of sending the holder to
// pick an input method up front
const Transfer: Component = () => {
  const {addBearer, updateBearer, bearers} = useWallet()
  const navigate = useNavigate()
  let pasteRef: HTMLInputElement | null = null
  const [value, setValue] = createSignal('')
  const [busy, setBusy] = createSignal(false)

  const isValid = createMemo(
    () =>
      value() === '' || isValidNoteInput(value()) || isBolt11Invoice(value())
  )

  // shared by both the scanner and the paste field once they've settled on
  // a valid bearer note
  const receiveIntoWallet = async (noteValue: string) => {
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
        navigate('/wallet')
        return
      }
      // rotate immediately: whoever handed this note over still knows the
      // old secret until it is burned
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
      navigate('/wallet')
    } catch (err) {
      notify((err as Error).message, NotifyKind.ERROR)
    } finally {
      setBusy(false)
    }
  }

  // this wallet has no Lightning node of its own - paying an invoice is its
  // own dialog on the Melt page, reachable from the main nav
  const goToMelt = (pr: string) =>
    navigate(`/melt?pr=${encodeURIComponent(pr.trim())}`)

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
    <RequireWallet>
      <div id="transfer" class="page">
        <h2>Bring in a bearer note</h2>
        <figure class="setup-card">
          <figcaption>
            Point the camera at a note QR (<code>lnurl1...</code> or{' '}
            <code>lnurlw://...?k1=...</code>)
          </figcaption>
          <Show when={!busy()} fallback={<p>Adding note...</p>}>
            <Scanner onScan={onScan} accept={isValidNoteInput} />
          </Show>
        </figure>
        <figure class="paste-widget">
          <figcaption>...or paste one instead</figcaption>
          <div class="paste-input-row">
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
              title="Add to wallet"
              disabled={busy() || value() === '' || !isValid()}
              onClick={handlePaste}
            >
              <Show when={busy()} fallback={<IoReturnDownForwardSharp />}>
                <IoRefreshSharp class="spin" />
              </Show>
            </button>
          </div>
          <Show when={value() !== '' && !isValid()}>
            <p class="warning">
              Not a valid LNURLcash bearer note (an LNURL-withdraw link carrying
              a k1) or bolt11 invoice.
            </p>
          </Show>
        </figure>
      </div>
    </RequireWallet>
  )
}
export default Transfer
