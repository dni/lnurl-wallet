import type {Component} from 'solid-js'
import {Show, createSignal, createMemo} from 'solid-js'
import {useNavigate} from '@solidjs/router'
import {
  IoClipboardSharp,
  IoCloseSharp,
  IoReturnDownForwardSharp
} from 'solid-icons/io'

import {useWallet} from '../WalletContext'
import {isValidCashInput} from '../lnurlcash'
import {receiveCash} from '../receive'
import {
  notify,
  NotifyKind,
  msatToSats,
  pasteFromClipboard
} from '../helpers'
import RequireWallet from '../components/RequireWallet'

const Paste: Component = () => {
  const {addBearer, bearers} = useWallet()
  const navigate = useNavigate()
  let pasteRef: HTMLInputElement | null = null
  const [value, setValue] = createSignal('')
  const [busy, setBusy] = createSignal(false)

  // an empty field isn't "invalid" - just nothing to show feedback about yet
  const isValid = createMemo(() => value() === '' || isValidCashInput(value()))

  const handle = async () => {
    if (value() === '') return
    if (!isValidCashInput(value())) {
      notify('Not a valid LNURLcash token.', NotifyKind.ERROR)
      return
    }
    setBusy(true)
    try {
      const received = await receiveCash(value(), bearers())
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
      setValue('')
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
        <h2>Paste LNURLcash</h2>
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
                placeholder="lnurlcash1..."
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
            <p class="warning">Not a valid LNURLcash token.</p>
          </Show>
        </figure>
      </div>
    </RequireWallet>
  )
}
export default Paste
