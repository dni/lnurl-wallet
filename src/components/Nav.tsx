import {Show, createSignal} from 'solid-js'
import {A, useNavigate} from '@solidjs/router'
import {
  IoMenuSharp,
  IoCloseSharp,
  IoAddCircleSharp,
  IoQrCodeSharp,
  IoClipboardSharp,
  IoLockClosedSharp,
  IoSaveSharp,
  IoBookSharp
} from 'solid-icons/io'
import {useWallet} from '../WalletContext'

const Nav = () => {
  const {state, encrypted, lock} = useWallet()
  const navigate = useNavigate()
  const [menuOpen, setMenuOpen] = createSignal(false)

  const lock_action = () => {
    lock()
    navigate('/')
  }

  return (
    <nav>
      <button
        class="nav-toggle"
        title={menuOpen() ? 'Close menu' : 'Open menu'}
        onClick={() => setMenuOpen(v => !v)}
      >
        {menuOpen() ? <IoCloseSharp /> : <IoMenuSharp />}
      </button>
      <A href="/" class="nav-brand">
        LNURLwallet
      </A>
      <div
        class="nav-links"
        classList={{open: menuOpen()}}
        onClick={() => setMenuOpen(false)}
      >
        <Show when={state() === 'unlocked'}>
          <A href="/mint" class="nav-link">
            <IoAddCircleSharp />
            &nbsp;Mint
          </A>
          <A href="/scan" class="nav-link">
            <IoQrCodeSharp />
            &nbsp;Scan
          </A>
          <A href="/paste" class="nav-link">
            <IoClipboardSharp />
            &nbsp;Paste
          </A>
        </Show>
      </div>
      {/* always visible, not part of the collapsible .nav-links dropdown -
      on mobile this stays pinned to the right regardless of menuOpen() */}
      <div class="nav-persistent">
        <A href="/docs" title="Documentation">
          <IoBookSharp />
        </A>
        <Show when={state() === 'unlocked'}>
          <A href="/backup" title="Backup &amp; restore">
            <IoSaveSharp />
          </A>
          <Show when={encrypted()}>
            <a href="#lock" title="Lock wallet" onClick={lock_action}>
              <IoLockClosedSharp />
            </a>
          </Show>
        </Show>
      </div>
    </nav>
  )
}
export default Nav
