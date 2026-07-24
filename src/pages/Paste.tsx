import type {Component} from 'solid-js'
import {Show, createSignal, createMemo} from 'solid-js'
import {useNavigate} from '@solidjs/router'
import {
  IoClipboardSharp,
  IoCloseSharp,
  IoReturnDownForwardSharp
} from 'solid-icons/io'

import {useWallet} from '../WalletContext'
import {isValidNoteInput} from '../lnurlcash'
import {receiveNote, secureReceivedNote} from '../receive'
import {
  notify,
  NotifyKind,
  msatToSats,
  pasteFromClipboard
} from '../helpers'
import RequireWallet from '../components/RequireWallet'

const Paste: Component = () => {
  const {addBearer, updateBearer, bearers} = useWallet()
  const navigate = useNavigate()
  let pasteRef: HTMLInputElement | null = null
  const [value, setValue] = createSignal('')
  const [busy, setBusy] = createSignal(false)

  // an empty field isn't "invalid" - just nothing to show feedback about yet
  const isValid = createMemo(() => value() === '' || isValidNoteInput(value()))

  const handle = async () => {
    if (value() === '') return
    if (!isValidNoteInput(value())) {
      notify('Not a valid LNURLcash bearer note.', NotifyKind.ERROR)
      return
    }
    setBusy(true)
    try {
      const received = await receiveNote(value(), bearers())
      const bearer = await addBearer(received)
      setValue('')
      if (!received.verified) {
        notify(
          'Note stored, but its service could not be reached - refresh it later.',
          NotifyKind.LOADING
        )
        navigate('/')
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
      navigate('/')
    } catch (err) {
      notify((err as Error).message, NotifyKind.ERROR)
    } finally {
      setBusy(false)
    }
  }

  const paste = async () => {
    const text = await pasteFromClipboard()
    if (text !== null) {
      setValue(text)
      pasteRef?.focus()
      handle()
    }
  }

  const onKeydown = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handle()
    }
  }

  return (
    <RequireWallet>
      <div id="paste" class="page">
        <h2>Paste a bearer note</h2>
        <figure class="paste-widget">
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
                placeholder="lnurl1... or lnurlw://...?k1=..."
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
              onClick={handle}
            >
              <IoReturnDownForwardSharp />
            </button>
          </div>
          <Show when={value() !== '' && !isValid()}>
            <p class="warning">
              Not a valid LNURLcash bearer note (an LNURL-withdraw link
              carrying a k1).
            </p>
          </Show>
        </figure>
      </div>
    </RequireWallet>
  )
}
export default Paste
