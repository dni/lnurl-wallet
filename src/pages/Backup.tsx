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
                One JSON file with all {bearers().length} bearer note(s),
                exactly as they sit in local storage: AES-GCM ciphertext, never
                plaintext - plus your {trustedMints().length} trusted mint(s),
                which aren't secret and so travel in plain. Notes marked "on
                device" are only a blank mirror here (amount/host/label) - their
                real secret lives on your paired vault, not in this file, so
                recovering them needs the vault itself, not this backup. Also
                included: the small per-mint counters (LUD-25) behind every note
                secret this wallet derives from your seed rather than drawing at
                random - not secret on their own, just bookkeeping that keeps a
                restored wallet from ever reusing one.
                <Show
                  when={savedKeyIsEncrypted()}
                  fallback={
                    <>
                      {' '}
                      Your linking key is stored unencrypted, so it is{' '}
                      <strong>not</strong> included - restoring this backup on
                      another device needs your seed phrase.
                    </>
                  }
                >
                  {' '}
                  Your password-encrypted linking key is included, so on a new
                  device the backup plus your password is enough.
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
                This removes <strong>everything</strong> from this device - the
                linking key, every bearer note, trusted mints, and saved links.
                Unlike locking, restoring the same seed phrase afterward will
                not bring the notes back: their ciphertext is gone too, not just
                re-locked. A backup downloaded beforehand is the only way back.
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
              Bearers from the file are merged into this wallet (already-present
              ones are skipped) - but they only decrypt under the exact
              seed-derived key they were encrypted with, and this device's
              existing wallet, if it has one, is never replaced by a backup
              file. So <strong>order matters</strong>: do this{' '}
              <strong>before</strong> creating or restoring any wallet here -
              either restore your seed phrase first (see{' '}
              <A href="/setup">Restore from seed</A>), or, if the backup's own
              password-encrypted key is included, just select the file while
              this device has no wallet yet. Setting up a wallet here first and
              importing afterward merges the notes into storage, but they stay
              invisible - wrong key, nothing to decrypt them with.
            </p>
            <Show when={state() === 'none'}>
              <p>
                No wallet on this device yet: restoring a backup that includes a
                password-encrypted linking key sets the wallet up from it -
                otherwise restore your seed phrase first.
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
                The backup's linking key was installed on this device. Whoever
                wrote that file may know this key - encrypted or not - so only
                keep using this wallet if you trust the file's source
                completely; otherwise forget it below and set up a fresh one
                from your own seed phrase.
              </p>
              <Show
                when={savedKeyIsEncrypted()}
                fallback={
                  <>
                    <p class="warning">
                      The restored key was <strong>not</strong>{' '}
                      password-encrypted and is now stored in plaintext.
                      Activating it is withheld until you explicitly confirm:
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
                This device already has a wallet, so the backup's own saved key
                was <strong>not</strong> applied, and any of its notes encrypted
                under a different key won't show up here. If the wallet already
                on this device isn't the one this backup belongs to, forget it
                below - free if it's new/empty - then select this backup file
                again: restoring straight onto a wallet-less device is what
                actually installs the backup's own key.
              </p>
            </Show>
          </figure>
        </div>
      </div>
    </div>
  )
}
export default Backup
