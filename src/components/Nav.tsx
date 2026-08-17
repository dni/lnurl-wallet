import {Show, createSignal} from 'solid-js'
import {A, useNavigate} from '@solidjs/router'
import {
  IoMenuSharp,
  IoCloseSharp,
  IoWalletSharp,
  IoAddCircleSharp,
  IoFlameSharp,
  IoLockClosedSharp,
  IoSaveSharp,
  IoBookSharp,
  IoShieldCheckmarkSharp,
  IoCloudOfflineSharp,
  IoHardwareChipSharp
} from 'solid-icons/io'
import {useWallet} from '../WalletContext'
import {useDevice} from '../DeviceContext'
import {offlineMode, setOfflineMode} from '../offlineMode'

const Nav = () => {
  const {state, encrypted, lock} = useWallet()
  const {connectionState} = useDevice()
  const navigate = useNavigate()
  const [menuOpen, setMenuOpen] = createSignal(false)

  const closeMenu = () => setMenuOpen(false)

  const lock_action = () => {
    closeMenu()
    lock()
    navigate('/wallet')
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
          {/* shown whenever there's a wallet on this device, even locked -
          that's where the unlock form lives now that "/" is the landing
          page (see pages/Hero.tsx and pages/Wallet.tsx) */}
          <Show when={state() !== 'none'}>
            <A href="/wallet" class="nav-link">
              <IoWalletSharp />
              &nbsp;Wallet
            </A>
          </Show>
          <Show when={state() === 'unlocked'}>
            <Show when={!offlineMode()}>
              <A href="/mint" class="nav-link">
                <IoAddCircleSharp />
                &nbsp;Mint
              </A>
            </Show>
            <A href="/melt" class="nav-link">
              <IoFlameSharp />
              &nbsp;Melt
            </A>
          </Show>
        </div>
        <div class="nav-persistent">
          <button
            type="button"
            class="nav-icon-toggle"
            classList={{active: offlineMode()}}
            title={
              offlineMode()
                ? 'Offline mode is on - no requests reach any service until you turn it off'
                : 'Offline mode - block rotate, melt, split, merge and every other service request'
            }
            onClick={() => setOfflineMode(!offlineMode())}
          >
            <IoCloudOfflineSharp />
            <span class="nav-label">&nbsp;Offline mode</span>
          </button>
          <A href="/mints" title="Trusted mints">
            <IoShieldCheckmarkSharp />
            <span class="nav-label">&nbsp;Mints</span>
          </A>
          <A
            href="/vault"
            title={
              connectionState() === 'connected'
                ? 'LNURLvault - connected'
                : 'LNURLvault - pair a hardware device'
            }
          >
            <IoHardwareChipSharp />
            <span class="nav-label">&nbsp;Vault</span>
          </A>
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
