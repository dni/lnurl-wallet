import type {Component} from 'solid-js'
import {For, Show, createSignal} from 'solid-js'
import {A, useNavigate} from '@solidjs/router'
import {
  IoCashSharp,
  IoCloudOfflineSharp,
  IoTimeSharp,
  IoDownloadSharp,
  IoTrashSharp,
  IoFolderOpenSharp,
  IoRefreshSharp,
  IoShieldCheckmarkSharp
} from 'solid-icons/io'

import {useWallet} from '../WalletContext'
import {offlineMode, setOfflineMode} from '../offlineMode'
import {currency, setCurrency, CURRENCY_LABEL} from '../currency'
import type {Currency} from '../currency'
import {
  autoLockMinutes,
  setAutoLockMinutes,
  AUTO_LOCK_OPTIONS,
  AUTO_LOCK_LABEL
} from '../autoLock'
import {
  applyBackup,
  MAX_BACKUP_FILE_BYTES,
  downloadBackupFile
} from '../storage'
import {isValidSeedPhrase} from '../keys'
import {trustedMints} from '../trustedMints'
import {notify, NotifyKind} from '../helpers'
import {MIN_PASSWORD_LENGTH} from './Setup'

// order they appear - 'none' (Disabled) first since that's the default/off
// state, then alphabetical by the same three currencies price.lnbits.com
// serves directly (see currency.ts)
const CURRENCY_OPTIONS: Currency[] = ['none', 'eur', 'gbp', 'usd']

// nothing here is gated on wallet state at the page level - each card below
// carries its own Show where it actually matters (Download/Upgrade need
// unlocked, Forget needs a wallet at all, the rest work regardless), so this
// page shouldn't start requiring one either
const Settings: Component = () => {
  const {
    state,
    bearers,
    reloadBearers,
    refreshState,
    forgetWallet,
    unlock,
    encrypted,
    encryptionUpgraded,
    upgradeEncryption
  } = useWallet()
  const navigate = useNavigate()
  let fileRef: HTMLInputElement | undefined
  const [busy, setBusy] = createSignal(false)
  const [keyRestored, setKeyRestored] = createSignal(false)
  const [keySkipped, setKeySkipped] = createSignal(false)
  const [upgradeSeed, setUpgradeSeed] = createSignal('')
  const [upgradePassword, setUpgradePassword] = createSignal('')
  const [upgradeConfirmPassword, setUpgradeConfirmPassword] = createSignal('')
  const [upgrading, setUpgrading] = createSignal(false)
  const [confirmForget, setConfirmForget] = createSignal(false)

  const runUpgrade = async () => {
    if (!isValidSeedPhrase(upgradeSeed())) {
      notify('Not a valid BIP39 seed phrase.', NotifyKind.ERROR)
      return
    }
    if (encrypted() && upgradePassword().length < MIN_PASSWORD_LENGTH) {
      notify(
        `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
        NotifyKind.ERROR
      )
      return
    }
    if (encrypted() && upgradePassword() !== upgradeConfirmPassword()) {
      notify('Passwords do not match.', NotifyKind.ERROR)
      return
    }
    setUpgrading(true)
    try {
      await upgradeEncryption(
        upgradeSeed().trim().toLowerCase(),
        encrypted() ? upgradePassword() : undefined
      )
      setUpgradeSeed('')
      setUpgradePassword('')
      setUpgradeConfirmPassword('')
      notify(
        'Encryption upgraded - every note was re-encrypted under the new key.',
        NotifyKind.SUCCESS
      )
    } catch (err) {
      notify((err as Error).message, NotifyKind.ERROR)
    } finally {
      setUpgrading(false)
    }
  }

  const download = () => {
    downloadBackupFile()
    notify('Backup downloaded.', NotifyKind.SUCCESS)
  }

  const restore = async (e: Event) => {
    const input = e.currentTarget as HTMLInputElement
    const file = input.files?.[0]
    input.value = ''
    if (!file) return
    setBusy(true)
    setKeySkipped(false)
    setKeyRestored(false)
    try {
      if (file.size > MAX_BACKUP_FILE_BYTES) {
        throw new Error('That file is far too large to be a wallet backup.')
      }
      const data = JSON.parse(await file.text())
      const result = applyBackup(data)
      if (state() === 'unlocked') await reloadBearers()
      if (result.linkingKeyRestored) {
        // never activated automatically, whatever its storage form: whoever
        // wrote the file necessarily had the key (encrypted or not), so the
        // restore pauses on the source-trust warning below instead
        setKeyRestored(true)
        refreshState()
      }
      if (result.linkingKeySkipped) setKeySkipped(true)
      notify(
        `Restored ${result.added} bearer(s), skipped ${result.skipped}` +
          (result.trustedMintsAdded > 0
            ? `, added ${result.trustedMintsAdded} trusted mint(s).`
            : '.') +
          (result.linkingKeySkipped
            ? ' This device already has a wallet - see the warning below.'
            : '') +
          (result.linkingKeyRestored
            ? " The backup's linking key was installed - read the warning below before using it."
            : ''),
        result.linkingKeySkipped || result.linkingKeyRestored
          ? NotifyKind.ERROR
          : NotifyKind.SUCCESS
      )
    } catch (err) {
      notify((err as Error).message, NotifyKind.ERROR)
    } finally {
      setBusy(false)
    }
  }

  // the user has acknowledged the source-trust warning for a
  // plaintext-stored backup key - activate it (an encrypted one instead
  // just gets pointed at the unlock screen, see below)
  const activateRestoredKey = async () => {
    try {
      await unlock()
      setKeyRestored(false)
      notify('Restored wallet activated.', NotifyKind.SUCCESS)
      navigate('/wallet')
    } catch (err) {
      notify((err as Error).message, NotifyKind.ERROR)
    }
  }

  const doForget = () => {
    forgetWallet()
    setConfirmForget(false)
    notify(
      'Wallet forgotten - the linking key and every bearer note were removed from this device.',
      NotifyKind.SUCCESS
    )
    navigate('/')
  }

  return (
    <div id="settings" class="page">
      <h2>Settings</h2>
      <div class="setup-card">
        <h4>
          <IoTimeSharp />
          &nbsp;Auto-lock
        </h4>
        <p>
          Locks the wallet after this long with no activity in the tab, with a
          30-second warning first.
          <Show when={!encrypted()}>
            {' '}
            Only takes effect once the wallet is set up with a password - an
            unencrypted key would just silently unlock itself again anyway.
          </Show>
        </p>
        <div class="btns">
          <For each={AUTO_LOCK_OPTIONS}>
            {option => (
              <button
                type="button"
                classList={{active: autoLockMinutes() === option}}
                onClick={() => setAutoLockMinutes(option)}
              >
                {AUTO_LOCK_LABEL[option]}
              </button>
            )}
          </For>
        </div>
      </div>
      <div class="setup-card">
        <h4>
          <IoCashSharp />
          &nbsp;Currency
        </h4>
        <p>
          Show a fiat estimate alongside sats, using price.lnbits.com. Purely
          cosmetic - every amount is still held and moved in sats underneath.
        </p>
        <div class="btns">
          <For each={CURRENCY_OPTIONS}>
            {option => (
              <button
                type="button"
                classList={{active: currency() === option}}
                onClick={() => setCurrency(option)}
              >
                {option === 'none' ? 'Disabled' : CURRENCY_LABEL[option]}
              </button>
            )}
          </For>
        </div>
      </div>
      <div class="setup-card">
        <h4>
          <IoCloudOfflineSharp />
          &nbsp;Offline mode
        </h4>
        <p>
          Blocks rotate, melt, split, merge and every other request to a service
          - notes already in the wallet stay readable, nothing new reaches the
          network until this is off again.
        </p>
        <div class="btns">
          <button
            type="button"
            classList={{active: offlineMode()}}
            onClick={() => setOfflineMode(!offlineMode())}
          >
            <IoCloudOfflineSharp />
            &nbsp;
            <Show when={offlineMode()} fallback="Turn on">
              Turn off
            </Show>
          </button>
        </div>
      </div>
      <Show when={state() === 'unlocked'}>
        <div class="setup-card">
          <h4>
            <IoDownloadSharp />
            &nbsp;Download backup
          </h4>
          <p>
            One JSON file: your {bearers().length} bearer note(s) (encrypted,
            never plaintext) and {trustedMints().length} trusted mint(s). Notes
            marked "on device" are just a blank mirror - recovering those needs
            the paired vault, not this file.
            <Show
              when={encrypted()}
              fallback={
                <>
                  {' '}
                  Your encryption key isn't password-protected, so it's{' '}
                  <strong>not</strong> included - restoring elsewhere needs your
                  seed phrase.
                </>
              }
            >
              {' '}
              Your password-encrypted key is included too, so this file plus
              your password is enough on a new device.
            </Show>
          </p>
          <div class="btns">
            <button onClick={download}>
              <IoDownloadSharp />
              &nbsp;Download backup
            </button>
          </div>
        </div>
      </Show>
      <Show when={state() === 'unlocked' && !encryptionUpgraded()}>
        <div class="setup-card">
          <h4>Upgrade encryption</h4>
          <p>
            Your notes are currently encrypted with a key derived through an
            extra identity keypair this wallet never actually uses for anything.
            Re-entering your seed phrase here switches to a simpler key derived
            directly from it, and re-encrypts every note and activity entry
            already stored under the new one. Nothing about your seed phrase or
            your notes themselves changes - only how the encryption key is
            derived.
          </p>
          <label>Your 12-word BIP39 seed phrase</label>
          <textarea
            rows="3"
            placeholder="twelve words separated by spaces"
            autocomplete="off"
            autocapitalize="off"
            spellcheck={false}
            data-1p-ignore
            data-lpignore="true"
            value={upgradeSeed()}
            onInput={e => setUpgradeSeed(e.currentTarget.value)}
          />
          <Show when={encrypted()}>
            <input
              type="password"
              placeholder="Password to encrypt the new key"
              autocomplete="new-password"
              autocapitalize="off"
              spellcheck={false}
              value={upgradePassword()}
              onInput={e => setUpgradePassword(e.currentTarget.value)}
            />
            <input
              type="password"
              placeholder="Confirm password"
              autocomplete="new-password"
              autocapitalize="off"
              spellcheck={false}
              value={upgradeConfirmPassword()}
              onInput={e => setUpgradeConfirmPassword(e.currentTarget.value)}
            />
          </Show>
          <div class="btns">
            <button
              disabled={upgrading() || !upgradeSeed().trim()}
              onClick={runUpgrade}
            >
              <Show when={upgrading()} fallback={<IoShieldCheckmarkSharp />}>
                <IoRefreshSharp class="spin" />
              </Show>
              &nbsp;Upgrade encryption
            </button>
          </div>
        </div>
      </Show>
      <div class="setup-card">
        <h4>
          <IoFolderOpenSharp />
          &nbsp;Restore backup
        </h4>
        <p>
          Notes from the file merge in (duplicates skipped), but only decrypt
          under the key they were encrypted with. <strong>Order matters</strong>
          : restore your seed first (see <A href="/setup">Restore from seed</A>
          ), or select this file while the device has no wallet yet, if it
          carries its own encrypted key. Setting up a wallet here first and
          importing after leaves the notes present but undecryptable.
        </p>
        <Show when={state() === 'none'}>
          <p>
            No wallet here yet: a backup with its own encrypted key sets one up
            automatically; otherwise restore your seed phrase first.
          </p>
        </Show>
        <input
          ref={fileRef}
          type="file"
          accept="application/json"
          style="display: none"
          onChange={restore}
        />
        <div class="btns">
          <button disabled={busy()} onClick={() => fileRef?.click()}>
            <Show when={busy()} fallback={<IoFolderOpenSharp />}>
              <IoRefreshSharp class="spin" />
            </Show>
            &nbsp;Select backup file
          </button>
        </div>
        <Show when={keyRestored()}>
          <p class="warning">
            This backup's linking key is now installed. Whoever created the file
            may know it - only continue if you trust its source; otherwise
            forget this wallet below and set up fresh from your own seed.
          </p>
          <Show
            when={encrypted()}
            fallback={
              <>
                <p class="warning">
                  This key wasn't password-encrypted, so it's now stored in
                  plaintext. Confirm before activating it:
                </p>
                <div class="btns">
                  <button onClick={activateRestoredKey}>
                    I trust this file - activate the restored wallet
                  </button>
                </div>
              </>
            }
          >
            <p class="warning">
              <A href="/wallet">Unlock the wallet</A> with the password the key
              was encrypted with.
            </p>
          </Show>
        </Show>
        <Show when={keySkipped()}>
          <p class="warning">
            This device already has a wallet, so the backup's own key wasn't
            applied - its notes won't show up here. If this isn't the right
            wallet, forget it below (free if empty) and select the file again on
            a wallet-less device.
          </p>
        </Show>
      </div>
      <Show when={state() !== 'none'}>
        <div class="setup-card">
          <h4>
            <IoTrashSharp />
            &nbsp;Forget this wallet
          </h4>
          <p class="warning">
            Removes <strong>everything</strong> from this device - key, notes,
            trusted mints, saved links. Restoring the same seed afterward won't
            bring the notes back; only a backup downloaded first can.
          </p>
          <div class="btns">
            <button onClick={download}>
              <IoDownloadSharp />
              &nbsp;Download backup first
            </button>
          </div>
          <Show
            when={confirmForget()}
            fallback={
              <div class="btns">
                <button onClick={() => setConfirmForget(true)}>
                  <IoTrashSharp />
                  &nbsp;Forget wallet
                </button>
              </div>
            }
          >
            <p class="warning">
              Are you sure? This deletes the linking key and every bearer note
              from this device - only a backup downloaded beforehand can bring
              them back.
            </p>
            <div class="btns">
              <button onClick={doForget}>Yes, forget everything</button>
              <button onClick={() => setConfirmForget(false)}>Cancel</button>
            </div>
          </Show>
        </div>
      </Show>
    </div>
  )
}
export default Settings
