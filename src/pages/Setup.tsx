import type {Component} from 'solid-js'
import {Show, createSignal} from 'solid-js'
import {A, useNavigate, useSearchParams} from '@solidjs/router'
import {IoRefreshSharp} from 'solid-icons/io'

import {useWallet} from '../WalletContext'
import {
  generateSeedPhrase,
  isValidSeedPhrase,
  savedKeyIsEncrypted
} from '../keys'
import {applyBackup, MAX_BACKUP_FILE_BYTES} from '../storage'
import {notify, NotifyKind} from '../helpers'

type Tab = 'create' | 'restore' | 'backup'

// the linking key's ciphertext sits in localStorage AND travels inside
// every backup file by design, so this password is the only thing between
// an offline brute-force and every note the wallet holds - a one-character
// password is no password at all
const MIN_PASSWORD_LENGTH = 8

const Setup: Component = () => {
  const {setup, state, refreshState, unlock} = useWallet()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const [tab, setTab] = createSignal<Tab>(
    searchParams.tab === 'restore' || searchParams.tab === 'backup'
      ? searchParams.tab
      : 'create'
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
  const [backupBusy, setBackupBusy] = createSignal(false)
  // set when a backup file's own key was skipped because this device
  // already has a wallet - see applyBackup's linkingKeySkipped
  const [backupSkipped, setBackupSkipped] = createSignal(false)
  // set when a backup installed its own linking key: the restore then holds
  // at an explicit source-trust acknowledgment instead of proceeding
  // straight into a wallet keyed by material the file's author may know
  const [backupKeyRestored, setBackupKeyRestored] = createSignal(false)
  let backupFileRef: HTMLInputElement | undefined

  const generate = () => {
    setSeedPhrase(generateSeedPhrase())
    setConfirmed(false)
  }

  const passwordOk = () =>
    !encrypt() ||
    (setupPassword().length >= MIN_PASSWORD_LENGTH &&
      setupPassword() === confirmPassword())

  const finishSetup = async (phrase: string) => {
    if (encrypt() && setupPassword().length < MIN_PASSWORD_LENGTH) {
      notify(
        `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
        NotifyKind.ERROR
      )
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

  // sets this device's wallet up straight from a backup file's own
  // password-encrypted key (see storage.ts's applyBackup) - no seed phrase
  // needed, as long as the same password is still known. Only installs the
  // key onto a device with none yet; bearers from the file merge into
  // storage regardless of whether the key was.
  const restoreFromBackupFile = async (e: Event) => {
    const input = e.currentTarget as HTMLInputElement
    const file = input.files?.[0]
    input.value = ''
    if (!file) return
    setBackupBusy(true)
    setBackupSkipped(false)
    try {
      if (file.size > MAX_BACKUP_FILE_BYTES) {
        throw new Error('That file is far too large to be a wallet backup.')
      }
      const data = JSON.parse(await file.text())
      const result = applyBackup(data)
      if (result.linkingKeyRestored) {
        // never activated automatically, whatever its storage form: whoever
        // wrote the file necessarily had the key (encrypted or not), so the
        // restore pauses for an explicit source-trust acknowledgment - see
        // the warning shown in this tab
        setBackupKeyRestored(true)
        refreshState()
        return
      }
      if (result.linkingKeySkipped) {
        setBackupSkipped(true)
        notify(
          "This device already has a wallet, so the backup's own key was not installed.",
          NotifyKind.ERROR
        )
        return
      }
      notify(
        "This backup doesn't include a password-encrypted key, so it can't set up a wallet on its own - restore its seed phrase instead. Its bearers were still merged into storage and will appear once that seed is restored.",
        NotifyKind.ERROR
      )
    } catch (err) {
      notify((err as Error).message, NotifyKind.ERROR)
    } finally {
      setBackupBusy(false)
    }
  }

  // the user has acknowledged the source-trust warning for a
  // backup-installed key - proceed into it: the unlock screen for an
  // encrypted key, straight in for a plaintext one
  const proceedWithBackupKey = async () => {
    setBackupKeyRestored(false)
    if (savedKeyIsEncrypted()) {
      navigate('/wallet')
      return
    }
    try {
      await unlock()
      navigate('/wallet')
    } catch (err) {
      notify((err as Error).message, NotifyKind.ERROR)
    }
  }

  return (
    <div id="setup" class="page">
      <h2>Set up your wallet</h2>
      <Show when={state() !== 'none' && tab() !== 'backup'}>
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
        <button
          classList={{active: tab() === 'backup'}}
          onClick={() => setTab('backup')}
        >
          Restore from backup
        </button>
      </div>
      <figure class="setup-card">
        <Show when={tab() === 'create'}>
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
        <Show when={tab() === 'restore'}>
          <label>Your 12-word BIP39 seed phrase</label>
          <textarea
            rows="3"
            placeholder="twelve words separated by spaces"
            autocomplete="off"
            autocapitalize="off"
            spellcheck={false}
            data-1p-ignore
            data-lpignore="true"
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
        </Show>
        <Show when={tab() === 'backup'}>
          <p>
            Sets this device's wallet up straight from a downloaded backup
            file's own password-encrypted key - no seed phrase needed, as long
            as you still know the password it was encrypted with. Only works on
            a device with no wallet on it yet; the file's bearer notes are
            merged into storage either way and appear once the wallet they
            belong to is unlocked.
          </p>
          <Show when={backupSkipped()}>
            <p class="warning">
              This device already has a wallet, so the backup's own key was{' '}
              <strong>not</strong> installed. If that existing wallet isn't the
              one this backup belongs to, forget it first (see{' '}
              <A href="/backup">Backup &amp; restore</A>), then select this file
              again.
            </p>
          </Show>
          <Show when={backupKeyRestored()}>
            <p class="warning">
              The backup's linking key was installed. Whoever wrote that file
              may know this key - encrypted or not - so only continue if you
              trust the file's source completely. Otherwise forget this wallet
              (see <A href="/backup">Backup &amp; restore</A>) and set up a
              fresh one from your own seed phrase instead.
            </p>
            <div class="btns">
              <button onClick={proceedWithBackupKey}>
                I trust this file - continue
              </button>
            </div>
          </Show>
          <input
            ref={backupFileRef}
            type="file"
            accept="application/json"
            style="display: none"
            onChange={restoreFromBackupFile}
          />
          <div class="btns">
            <button
              disabled={backupBusy()}
              onClick={() => backupFileRef?.click()}
            >
              <Show when={backupBusy()}>
                <IoRefreshSharp class="spin" />
                &nbsp;
              </Show>
              Select backup file
            </button>
          </div>
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
        autocomplete="new-password"
        autocapitalize="off"
        spellcheck={false}
        value={props.password}
        onInput={e => props.setPassword(e.currentTarget.value)}
      />
      <input
        type="password"
        placeholder="Confirm password"
        autocomplete="new-password"
        autocapitalize="off"
        spellcheck={false}
        value={props.confirmPassword}
        onInput={e => props.setConfirmPassword(e.currentTarget.value)}
      />
      <Show
        when={
          props.password.length > 0 &&
          props.password.length < MIN_PASSWORD_LENGTH
        }
      >
        <p class="warning">
          At least {MIN_PASSWORD_LENGTH} characters - this password is the only
          thing standing between an offline brute-force and your notes.
        </p>
      </Show>
      <Show
        when={props.confirmPassword && props.password !== props.confirmPassword}
      >
        <p class="warning">Passwords do not match.</p>
      </Show>
    </Show>
  </>
)

export default Setup
