import type {Component} from 'solid-js'
import {Show, createSignal} from 'solid-js'
import {A, useNavigate} from '@solidjs/router'
import {
  IoDownloadSharp,
  IoFolderOpenSharp,
  IoTrashSharp,
  IoRefreshSharp
} from 'solid-icons/io'

import {useWallet} from '../WalletContext'
import {buildBackup, applyBackup, MAX_BACKUP_FILE_BYTES} from '../storage'
import {savedKeyIsEncrypted} from '../keys'
import {trustedMints} from '../trustedMints'
import {notify, NotifyKind} from '../helpers'

const Backup: Component = () => {
  const {state, bearers, reloadBearers, refreshState, forgetWallet, unlock} =
    useWallet()
  const navigate = useNavigate()
  let fileRef: HTMLInputElement | undefined
  const [busy, setBusy] = createSignal(false)
  const [keyRestored, setKeyRestored] = createSignal(false)
  const [keySkipped, setKeySkipped] = createSignal(false)
  const [confirmForget, setConfirmForget] = createSignal(false)

  const download = () => {
    const backup = buildBackup()
    const blob = new Blob([JSON.stringify(backup, null, 2)], {
      type: 'application/json'
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `lnurlwallet-backup-${new Date()
      .toISOString()
      .slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
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
    <div id="backup" class="page">
      <h2>Backup &amp; restore</h2>
      <div class="two-columns">
        <div class="two-col">
          <Show when={state() === 'unlocked'}>
            <figure class="setup-card">
              <h4>Download backup</h4>
              <p>
                One JSON file: your {bearers().length} bearer note(s)
                (encrypted, never plaintext) and {trustedMints().length} trusted
                mint(s). Notes marked "on device" are just a blank mirror -
                recovering those needs the paired vault, not this file.
                <Show
                  when={savedKeyIsEncrypted()}
                  fallback={
                    <>
                      {' '}
                      Your linking key isn't encrypted, so it's{' '}
                      <strong>not</strong> included - restoring elsewhere needs
                      your seed phrase.
                    </>
                  }
                >
                  {' '}
                  Your password-encrypted linking key is included too, so this
                  file plus your password is enough on a new device.
                </Show>
              </p>
              <div class="btns">
                <button onClick={download}>
                  <IoDownloadSharp />
                  &nbsp;Download backup
                </button>
              </div>
            </figure>
          </Show>
          <Show when={state() !== 'none'}>
            <figure class="setup-card">
              <h4>Forget this wallet</h4>
              <p class="warning">
                Removes <strong>everything</strong> from this device - key,
                notes, trusted mints, saved links. Restoring the same seed
                afterward won't bring the notes back; only a backup downloaded
                first can.
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
                  Are you sure? This deletes the linking key and every bearer
                  note from this device - only a backup downloaded beforehand
                  can bring them back.
                </p>
                <div class="btns">
                  <button onClick={doForget}>Yes, forget everything</button>
                  <button onClick={() => setConfirmForget(false)}>
                    Cancel
                  </button>
                </div>
              </Show>
            </figure>
          </Show>
        </div>
        <div class="two-col">
          <figure class="setup-card">
            <h4>Restore backup</h4>
            <p>
              Notes from the file merge in (duplicates skipped), but only
              decrypt under the key they were encrypted with.{' '}
              <strong>Order matters</strong>: restore your seed first (see{' '}
              <A href="/setup">Restore from seed</A>), or select this file while
              the device has no wallet yet, if it carries its own encrypted key.
              Setting up a wallet here first and importing after leaves the
              notes present but undecryptable.
            </p>
            <Show when={state() === 'none'}>
              <p>
                No wallet here yet: a backup with its own encrypted key sets one
                up automatically; otherwise restore your seed phrase first.
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
                This backup's linking key is now installed. Whoever created the
                file may know it - only continue if you trust its source;
                otherwise forget this wallet below and set up fresh from your
                own seed.
              </p>
              <Show
                when={savedKeyIsEncrypted()}
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
                  <A href="/wallet">Unlock the wallet</A> with the password the
                  key was encrypted with.
                </p>
              </Show>
            </Show>
            <Show when={keySkipped()}>
              <p class="warning">
                This device already has a wallet, so the backup's own key wasn't
                applied - its notes won't show up here. If this isn't the right
                wallet, forget it below (free if empty) and select the file
                again on a wallet-less device.
              </p>
            </Show>
          </figure>
        </div>
      </div>
    </div>
  )
}
export default Backup
