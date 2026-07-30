import type {Component} from 'solid-js'
import {Show, createSignal} from 'solid-js'
import {A, useNavigate} from '@solidjs/router'
import {IoDownloadSharp, IoFolderOpenSharp, IoTrashSharp} from 'solid-icons/io'

import {useWallet} from '../WalletContext'
import {buildBackup, applyBackup} from '../storage'
import {savedKeyIsEncrypted} from '../keys'
import {notify, NotifyKind} from '../helpers'

const Backup: Component = () => {
  const {state, bearers, reloadBearers, refreshState, forgetWallet} =
    useWallet()
  const navigate = useNavigate()
  let fileRef: HTMLInputElement | undefined
  const [busy, setBusy] = createSignal(false)
  const [keyRestored, setKeyRestored] = createSignal(false)
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
    try {
      const data = JSON.parse(await file.text())
      const result = applyBackup(data)
      if (state() === 'unlocked') await reloadBearers()
      if (result.linkingKeyRestored) {
        setKeyRestored(true)
        refreshState()
      }
      notify(
        `Restored ${result.added} bearer(s), skipped ${result.skipped}.`,
        NotifyKind.SUCCESS
      )
    } catch (err) {
      notify((err as Error).message, NotifyKind.ERROR)
    } finally {
      setBusy(false)
    }
  }

  const doForget = () => {
    forgetWallet()
    setConfirmForget(false)
    notify(
      'Wallet forgotten on this device - your bearer notes stay encrypted in local storage, restore the seed phrase to use them again.',
      NotifyKind.SUCCESS
    )
    navigate('/')
  }

  return (
    <div id="backup" class="page">
      <h2>Backup &amp; restore</h2>
      <Show when={state() === 'unlocked'}>
        <figure class="setup-card">
          <h4>Download backup</h4>
          <p>
            One JSON file with all {bearers().length} bearer note(s), exactly as
            they sit in local storage: AES-GCM ciphertext, never plaintext.
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
      <figure class="setup-card">
        <h4>Restore backup</h4>
        <p>
          Bearers from the file are merged into this wallet (already-present
          ones are skipped). They only decrypt with the same seed-derived key
          they were encrypted with - a backup made from a different seed stays
          unreadable until that seed is restored (see{' '}
          <A href="/setup">Restore from seed</A>).
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
            <IoFolderOpenSharp />
            &nbsp;Select backup file
          </button>
        </div>
        <Show when={keyRestored()}>
          <p class="warning">
            Linking key restored from the backup -{' '}
            <A href="/">unlock the wallet</A> with the password it was encrypted
            with.
          </p>
        </Show>
      </figure>
      <Show when={state() !== 'none'}>
        <figure class="setup-card">
          <h4>Forget this wallet</h4>
          <p>
            Removes the linking key from this device. Your bearer notes stay in
            local storage, still encrypted, untouched - restoring the same seed
            phrase (or a backup that includes the encrypted key) makes this
            device a wallet again, with everything it held before.
          </p>
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
              Are you sure? Without the seed phrase (or a backup carrying the
              encrypted key), this device's linking key cannot be recovered.
            </p>
            <div class="btns">
              <button onClick={doForget}>Yes, forget it</button>
              <button onClick={() => setConfirmForget(false)}>Cancel</button>
            </div>
          </Show>
        </figure>
      </Show>
    </div>
  )
}
export default Backup
