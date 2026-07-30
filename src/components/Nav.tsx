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

  const closeMenu = () => setMenuOpen(false)

  const lock_action = () => {
    closeMenu()
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
      <A href="/" class="nav-brand" onClick={closeMenu}>
        LNURLwallet
      </A>
      {/* wraps both groups so they collapse into one dropdown on mobile -
      Docs always renders regardless of wallet state, so this is never
      empty when opened (see .nav-menu in style.scss) */}
      <div class="nav-menu" classList={{open: menuOpen()}} onClick={closeMenu}>
        <div class="nav-links">
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
        <div class="nav-persistent">
          <A href="/docs" title="Documentation">
            <IoBookSharp />
            <span class="nav-label">&nbsp;Docs</span>
          </A>
          <Show when={state() === 'unlocked'}>
            <A href="/backup" title="Backup &amp; restore">
              <IoSaveSharp />
              <span class="nav-label">&nbsp;Backup</span>
            </A>
            <Show when={encrypted()}>
              <a href="#lock" title="Lock wallet" onClick={lock_action}>
                <IoLockClosedSharp />
                <span class="nav-label">&nbsp;Lock</span>
              </a>
            </Show>
          </Show>
        </div>
      </div>
    </nav>
  )
}
export default Nav
