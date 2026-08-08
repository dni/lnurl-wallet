import type {Component} from 'solid-js'
import {For, Show, createSignal} from 'solid-js'
import {IoAddCircleSharp, IoTrashSharp, IoLockClosedSharp} from 'solid-icons/io'

import {
  trustedMints,
  addTrustedMint,
  removeTrustedMint,
  isMintTrusted,
  PUBLIC_MINTS
} from '../trustedMints'
import {resolveMintInput, fetchPayRequest, serverOf} from '../lnurlcash'
import {notify, NotifyKind, formatDate} from '../helpers'
import {offlineMode} from '../offlineMode'

const Mints: Component = () => {
  const [server, setServer] = createSignal('')
  const [pubkey, setPubkey] = createSignal('')
  const [confirmDelete, setConfirmDelete] = createSignal<string | null>(null)
  const [trusting, setTrusting] = createSignal<string | null>(null)

  const add = () => {
    try {
      addTrustedMint(server(), pubkey())
      setServer('')
      setPubkey('')
      notify('Mint added to your trusted list.', NotifyKind.SUCCESS)
    } catch (err) {
      notify((err as Error).message, NotifyKind.ERROR)
    }
  }

  const remove = (mintServer: string) => {
    try {
      removeTrustedMint(mintServer)
      setConfirmDelete(null)
      notify('Mint removed from your trusted list.', NotifyKind.SUCCESS)
    } catch (err) {
      notify((err as Error).message, NotifyKind.ERROR)
    }
  }

  // looks the address up to fetch its published signing key, same as
  // Mint.tsx's own lookup - this list is just addresses, not server+pubkey
  // pairs, so there's no key to trust until this call comes back
  const trustPublicMint = async (address: string) => {
    setTrusting(address)
    try {
      const url = resolveMintInput(address)
      if (!url) throw new Error('Could not resolve this mint address.')
      const info = await fetchPayRequest(url)
      if (!info.mintPubkey) {
        throw new Error('This mint does not publish a signing key.')
      }
      addTrustedMint(serverOf(url), info.mintPubkey)
      notify('Mint added to your trusted list.', NotifyKind.SUCCESS)
    } catch (err) {
      notify((err as Error).message, NotifyKind.ERROR)
    } finally {
      setTrusting(null)
    }
  }

  return (
    <div id="mints" class="page">
      <h2>Trusted mints</h2>
      <p>
        Whenever this wallet sees a mint's signing key - looking one up,
        minting, refreshing or receiving a note - it's remembered here. This is
        what a note's "signed" badge is checked against. A mint you already hold
        a bearer note from is trusted automatically and can't be removed;
        anything else here you added yourself, and can remove again.
      </p>
      <figure class="setup-card">
        <h4>Add a mint manually</h4>
        <label>Server</label>
        <input
          type="text"
          placeholder="mint.example.com"
          value={server()}
          onInput={e => setServer(e.currentTarget.value)}
        />
        <label>Signing key (33-byte compressed pubkey, hex)</label>
        <input
          type="text"
          placeholder="02..."
          value={pubkey()}
          onInput={e => setPubkey(e.currentTarget.value)}
        />
        <div class="btns">
          <button onClick={add}>
            <IoAddCircleSharp />
            &nbsp;Add mint
          </button>
        </div>
      </figure>
      <figure class="setup-card">
        <h4>Public mints</h4>
        <p>
          A small curated list, for a quick start - looks up and trusts the
          mint's published signing key in one step.
        </p>
        <div class="mint-picker">
          <For each={PUBLIC_MINTS}>
            {address => {
              const url = resolveMintInput(address)
              const alreadyTrusted = () => !!url && isMintTrusted(serverOf(url))
              return (
                <button
                  disabled={
                    trusting() === address || alreadyTrusted() || offlineMode()
                  }
                  title={
                    offlineMode()
                      ? 'Offline mode is on'
                      : alreadyTrusted()
                        ? 'Already in your trusted list'
                        : ''
                  }
                  onClick={() => trustPublicMint(address)}
                >
                  <Show when={alreadyTrusted()}>
                    <IoLockClosedSharp />
                    &nbsp;
                  </Show>
                  {address}
                </button>
              )
            }}
          </For>
        </div>
      </figure>
      <Show
        when={trustedMints().length > 0}
        fallback={<p>No trusted mints yet.</p>}
      >
        <div class="mint-list">
          <For each={trustedMints()}>
            {mint => (
              <figure class="mint-card">
                <h4>{mint.server}</h4>
                <p class="mint-pubkey">{mint.mintPubkey}</p>
                <p class="mint-date">added {formatDate(mint.addedAt)}</p>
                <Show
                  when={!mint.locked}
                  fallback={
                    <p class="mint-locked">
                      <IoLockClosedSharp />
                      &nbsp;trusted - you hold a bearer note from here
                    </p>
                  }
                >
                  <Show
                    when={confirmDelete() === mint.server}
                    fallback={
                      <div class="btns">
                        <button onClick={() => setConfirmDelete(mint.server)}>
                          <IoTrashSharp />
                          &nbsp;Remove
                        </button>
                      </div>
                    }
                  >
                    <p class="warning">
                      Remove this mint? Its notes will no longer show as
                      offline-verified.
                    </p>
                    <div class="btns">
                      <button onClick={() => remove(mint.server)}>
                        Yes, remove
                      </button>
                      <button onClick={() => setConfirmDelete(null)}>
                        Cancel
                      </button>
                    </div>
                  </Show>
                </Show>
              </figure>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}
export default Mints
