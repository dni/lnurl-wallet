import type {Component} from 'solid-js'
import {Show, createSignal} from 'solid-js'
import {useNavigate, useSearchParams} from '@solidjs/router'
import {IoRefreshSharp} from 'solid-icons/io'

import {useWallet} from '../WalletContext'
import {generateSeedPhrase, isValidSeedPhrase} from '../keys'
import {notify, NotifyKind} from '../helpers'

type Tab = 'create' | 'restore'

const Setup: Component = () => {
  const {setup, state} = useWallet()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const [tab, setTab] = createSignal<Tab>(
    searchParams.tab === 'restore' ? 'restore' : 'create'
  )
  const [seedPhrase, setSeedPhrase] = createSignal<string | null>(null)
  const [restorePhrase, setRestorePhrase] = createSignal('')
  const [confirmed, setConfirmed] = createSignal(false)
  // encrypting the linking key is the default - opting out is possible but
  // means anyone with access to this browser profile can read the wallet
  const [encrypt, setEncrypt] = createSignal(true)
  const [setupPassword, setSetupPassword] = createSignal('')
  const [confirmPassword, setConfirmPassword] = createSignal('')
  const [busy, setBusy] = createSignal(false)

  const generate = () => {
    setSeedPhrase(generateSeedPhrase())
    setConfirmed(false)
  }

  const passwordOk = () =>
    !encrypt() || (!!setupPassword() && setupPassword() === confirmPassword())

  const finishSetup = async (phrase: string) => {
    if (encrypt() && !setupPassword()) {
      notify('Enter a password to encrypt your linking key.', NotifyKind.ERROR)
      return
    }
    if (encrypt() && setupPassword() !== confirmPassword()) {
      notify('Passwords do not match.', NotifyKind.ERROR)
      return
    }
    setBusy(true)
    try {
      await setup(phrase, encrypt() ? setupPassword() : undefined)
      notify('Wallet ready.', NotifyKind.SUCCESS)
      navigate('/wallet')
    } catch (err) {
      notify((err as Error).message, NotifyKind.ERROR)
    } finally {
      setBusy(false)
    }
  }

  const restore = async () => {
    if (!isValidSeedPhrase(restorePhrase())) {
      notify('Not a valid BIP39 seed phrase.', NotifyKind.ERROR)
      return
    }
    await finishSetup(restorePhrase().trim().toLowerCase())
  }

  return (
    <div id="setup" class="page">
      <h2>Set up your wallet</h2>
      <Show when={state() !== 'none'}>
        <p class="warning">
          A wallet already exists on this device - setting up a new one replaces
          its linking key. Stored bearer tokens encrypted with the old key will
          stay in local storage but become unreadable until that seed is
          restored again.
        </p>
      </Show>
      <div class="tabs">
        <button
          classList={{active: tab() === 'create'}}
          onClick={() => setTab('create')}
        >
          Create new
        </button>
        <button
          classList={{active: tab() === 'restore'}}
          onClick={() => setTab('restore')}
        >
          Restore from seed
        </button>
      </div>
      <figure class="setup-card">
        <Show
          when={tab() === 'create'}
          fallback={
            <>
              <label>Your 12-word BIP39 seed phrase</label>
              <textarea
                rows="3"
                placeholder="twelve words separated by spaces"
                value={restorePhrase()}
                onInput={e => setRestorePhrase(e.currentTarget.value)}
              />
              <EncryptChoice
                encrypt={encrypt()}
                setEncrypt={setEncrypt}
                password={setupPassword()}
                setPassword={setSetupPassword}
                confirmPassword={confirmPassword()}
                setConfirmPassword={setConfirmPassword}
              />
              <div class="btns">
                <button
                  disabled={busy() || !restorePhrase().trim() || !passwordOk()}
                  onClick={restore}
                >
                  <Show when={busy()}>
                    <IoRefreshSharp class="spin" />
                    &nbsp;
                  </Show>
                  Restore wallet
                </button>
              </div>
            </>
          }
        >
          <Show
            when={seedPhrase()}
            fallback={
              <>
                <p>
                  A fresh seed phrase is generated in your browser - it is the
                  master key to your wallet and the only way to recover your
                  encrypted bearer tokens on another device.
                </p>
                <div class="btns">
                  <button onClick={generate}>Generate seed phrase</button>
                </div>
              </>
            }
          >
            <label>
              Your seed phrase - write it down, it is never stored anywhere:
            </label>
            <pre>{seedPhrase()}</pre>
            <label>
              <input
                type="checkbox"
                checked={confirmed()}
                onChange={e => setConfirmed(e.currentTarget.checked)}
              />
              &nbsp;I have saved my seed phrase somewhere safe
            </label>
            <EncryptChoice
              encrypt={encrypt()}
              setEncrypt={setEncrypt}
              password={setupPassword()}
              setPassword={setSetupPassword}
              confirmPassword={confirmPassword()}
              setConfirmPassword={setConfirmPassword}
            />
            <div class="btns">
              <button
                disabled={busy() || !confirmed() || !passwordOk()}
                onClick={() => finishSetup(seedPhrase()!)}
              >
                <Show when={busy()}>
                  <IoRefreshSharp class="spin" />
                  &nbsp;
                </Show>
                Continue
              </button>
              <button onClick={() => setSeedPhrase(null)}>Cancel</button>
            </div>
          </Show>
        </Show>
      </figure>
    </div>
  )
}

const EncryptChoice: Component<{
  encrypt: boolean
  setEncrypt: (v: boolean) => void
  password: string
  setPassword: (v: string) => void
  confirmPassword: string
  setConfirmPassword: (v: string) => void
}> = props => (
  <>
    <label>
      <input
        type="checkbox"
        checked={props.encrypt}
        onChange={e => props.setEncrypt(e.currentTarget.checked)}
      />
      &nbsp;Store my linking key encrypted, with a password (recommended)
    </label>
    <Show
      when={props.encrypt}
      fallback={
        <p class="warning">
          Without a password the linking key sits in local storage in plaintext
          - anyone using this browser profile can spend your LNURLcash.
        </p>
      }
    >
      <input
        type="password"
        placeholder="Password to encrypt the linking key"
        value={props.password}
        onInput={e => props.setPassword(e.currentTarget.value)}
      />
      <input
        type="password"
        placeholder="Confirm password"
        value={props.confirmPassword}
        onInput={e => props.setConfirmPassword(e.currentTarget.value)}
      />
      <Show
        when={props.confirmPassword && props.password !== props.confirmPassword}
      >
        <p class="warning">Passwords do not match.</p>
      </Show>
    </Show>
  </>
)

export default Setup
