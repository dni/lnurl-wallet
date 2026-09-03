import type {Component, JSX} from 'solid-js'
import {Show} from 'solid-js'
import {A} from '@solidjs/router'

import {useWallet} from '../WalletContext'

// Gate for pages that need an unlocked wallet (mint/scan/paste/backup):
// without one there is no AES key to encrypt incoming bearers with, so
// point at setup / the unlock form on the wallet page instead
const RequireWallet: Component<{children: JSX.Element}> = props => {
  const {state} = useWallet()
  return (
    <Show
      when={state() === 'unlocked'}
      fallback={
        <div class="page">
          <div class="setup-card">
            <Show
              when={state() === 'locked'}
              fallback={
                <>
                  <p>No wallet on this device yet.</p>
                  <A href="/setup" class="hero-btn hero-btn-primary">
                    Create wallet
                  </A>
                </>
              }
            >
              <p>Your wallet is locked.</p>
              <A href="/wallet" class="hero-btn hero-btn-primary">
                Unlock
              </A>
            </Show>
          </div>
        </div>
      }
    >
      {props.children}
    </Show>
  )
}
export default RequireWallet
