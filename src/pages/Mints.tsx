import type {Component} from 'solid-js'
import {For, Show, createSignal} from 'solid-js'
import {
  IoAddCircleSharp,
  IoTrashSharp,
  IoLockClosedSharp,
  IoClipboardSharp,
  IoCloseSharp,
  IoReturnDownForwardSharp,
  IoRefreshSharp
} from 'solid-icons/io'

import {
  trustedMints,
  addTrustedMint,
  removeTrustedMint,
  isMintTrusted,
  mintAddressCacheInfo,
  PUBLIC_MINTS
} from '../trustedMints'
import {
  resolveMintInput,
  mintAddressUrl,
  fetchMintAddress,
  lightningAddressUsername,
  serverOf
} from '../lnurlcash'
import {
  notify,
  NotifyKind,
  formatDate,
  msatToSats,
  pasteFromClipboard
} from '../helpers'
import {offlineMode} from '../offlineMode'
import ScanToggle from '../components/ScanToggle'

const Mints: Component = () => {
  const [server, setServer] = createSignal('')
  const [pubkey, setPubkey] = createSignal('')
  const [confirmDelete, setConfirmDelete] = createSignal<string | null>(null)

  // "add by address" - a best-effort automated alternative to the manual
  // form below: looks up a mint's own mint-address discovery endpoint (see
  // lnurlcash.ts's fetchMintAddress) and trusts whatever signing key it
  // advertises there, same source Mint.tsx's own lookup prefers for its
  // early trust prompt. Experimental (most mints won't have it yet) - a
  // mint that doesn't still needs the manual form, with a pubkey trusted
  // from elsewhere (its own site, a friend, etc).
  const [addressInput, setAddressInput] = createSignal('')
  const [addressBusy, setAddressBusy] = createSignal(false)

  const addByAddress = async (value?: string) => {
    const raw = value ?? addressInput()
    const url = resolveMintInput(raw)
    if (!url) {
      notify(
        'Enter a mint LNURL, Lightning Address, or bare domain.',
        NotifyKind.ERROR
      )
      return
    }
    const addressUrl = mintAddressUrl(url)
    if (!addressUrl) {
      notify(
        "This mint's address isn't at the usual .well-known/lnurlp/{name} path - nothing to look up automatically. Add it manually below instead.",
        NotifyKind.ERROR
      )
      return
    }
    setAddressBusy(true)
    try {
      const info = await fetchMintAddress(addressUrl)
      if (!info.nodePubkey) {
        notify(
          "This mint doesn't advertise a signing key at its mint-address endpoint - add it manually below with a pubkey you trust from elsewhere.",
          NotifyKind.ERROR
        )
        return
      }
      const mintServer = serverOf(url)
      addTrustedMint(
        mintServer,
        info.nodePubkey,
        mintAddressCacheInfo(info, lightningAddressUsername(url))
      )
      setAddressInput('')
      notify(`${mintServer} added to your trusted list.`, NotifyKind.SUCCESS)
    } catch (err) {
      notify((err as Error).message, NotifyKind.ERROR)
    } finally {
      setAddressBusy(false)
    }
  }

  const pasteAddress = async () => {
    const text = await pasteFromClipboard()
    if (text !== null) setAddressInput(text)
  }

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
      <div class="two-columns">
        <div class="two-col">
          <figure class="setup-card">
            <h4>Public mints</h4>
            <p>
              A small curated list, for a quick start - opens the mint's own
              site in a new tab so you can look it up before trusting it
              manually below.
            </p>
            <div class="mint-picker">
              {/* opens the mint's site rather than fetching its payRequest
              and auto-trusting whatever signing key came back (the previous
              behavior here): per LUD-25, a mintPubkey is only guaranteed at
              the withdraw endpoint used for a rotated/split/merged note, not
              necessarily the payRequest a bare address resolves to - a
              perfectly spec-compliant mint could 404 there with a confusing
              "does not publish a signing key" error. Mint.tsx's own lookup
              already handles that correctly (it only offers a trust prompt
              when a pubkey is actually present); this list just points at
              the site instead of guessing. */}
              <For each={PUBLIC_MINTS}>
                {address => {
                  const url = resolveMintInput(address)
                  const alreadyTrusted = () =>
                    !!url && isMintTrusted(serverOf(url))
                  return (
                    <Show when={url}>
                      <a
                        class="link-btn"
                        href={`https://${serverOf(url!)}`}
                        target="_blank"
                        rel="noreferrer"
                        title={
                          alreadyTrusted()
                            ? 'Already in your trusted list - opens its site'
                            : "Open this mint's site"
                        }
                      >
                        <Show when={alreadyTrusted()}>
                          <IoLockClosedSharp />
                          &nbsp;
                        </Show>
                        {address}
                      </a>
                    </Show>
                  )
                }}
              </For>
            </div>
          </figure>
          <h4>Trusted mints</h4>
          <p>
            Every signing key this wallet actually checks notes against - added
            above, looked up manually, or picked up automatically the moment you
            hold a note from that mint.
          </p>
          <Show
            when={trustedMints().length > 0}
            fallback={<p>No trusted mints yet.</p>}
          >
            <div class="mint-list">
              <For each={trustedMints()}>
                {mint => (
                  <figure class="mint-card">
                    <h4>
                      <Show when={mint.nodeColor}>
                        <span
                          class="mint-color-dot"
                          style={{'background-color': mint.nodeColor!}}
                        />
                      </Show>
                      {mint.nodeAlias || mint.server}
                    </h4>
                    {/* h4 above already reads as mint.server when there's no
                    alias to show instead - this line only adds anything new
                    when there's an alias (so the bare hostname still needs
                    showing somewhere) or a cached username (so it's worth
                    spelling out the full address, not just the host) */}
                    <Show when={mint.nodeAlias || mint.username}>
                      <p class="mint-date">
                        {mint.username
                          ? `${mint.username}@${mint.server}`
                          : mint.server}
                      </p>
                    </Show>
                    <Show when={mint.nodeCapacityMsat !== undefined}>
                      <p class="mint-date">
                        Channel capacity: {msatToSats(mint.nodeCapacityMsat!)}{' '}
                        sats
                      </p>
                    </Show>
                    <Show
                      when={
                        mint.nodeNumChannels !== undefined ||
                        mint.nodeNumPeers !== undefined
                      }
                    >
                      <p class="mint-date">
                        <Show when={mint.nodeNumChannels !== undefined}>
                          {mint.nodeNumChannels} channels
                        </Show>
                        <Show
                          when={
                            mint.nodeNumChannels !== undefined &&
                            mint.nodeNumPeers !== undefined
                          }
                        >
                          &nbsp;·&nbsp;
                        </Show>
                        <Show when={mint.nodeNumPeers !== undefined}>
                          {mint.nodeNumPeers} peers
                        </Show>
                      </p>
                    </Show>
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
                            <button
                              onClick={() => setConfirmDelete(mint.server)}
                            >
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
        <div class="two-col">
          <figure class="paste-widget">
            <h4>Add a mint by address</h4>
            <p>
              Looks up a mint's LNURL, Lightning Address, or bare domain (e.g.
              "mint@host" or just "@host") via its mint-address discovery
              endpoint, and trusts whatever signing key it advertises there -
              experimental, so most mints won't have it yet. Falls back to the
              manual form below if it doesn't.
            </p>
            <div class="paste-input-row">
              <ScanToggle
                onScan={value => addByAddress(value)}
                accept={v => resolveMintInput(v) !== null}
              />
              <button
                type="button"
                class="icon-btn paste-icon-btn"
                title="Paste from clipboard"
                onClick={pasteAddress}
              >
                <IoClipboardSharp />
              </button>
              <div class="paste-input-wrapper">
                <input
                  type="text"
                  class="paste-input"
                  placeholder="lnurl1... or mint@example.com"
                  value={addressInput()}
                  onInput={e => setAddressInput(e.currentTarget.value)}
                  onKeyDown={e => e.key === 'Enter' && addByAddress()}
                />
                <Show when={addressInput() !== ''}>
                  <button
                    type="button"
                    class="icon-btn paste-clear-btn"
                    title="Clear"
                    onClick={() => setAddressInput('')}
                  >
                    <IoCloseSharp />
                  </button>
                </Show>
              </div>
              <button
                type="button"
                class="icon-btn paste-confirm-btn"
                title={offlineMode() ? 'Offline mode is on' : 'Look up mint'}
                disabled={
                  addressBusy() || addressInput() === '' || offlineMode()
                }
                onClick={() => addByAddress()}
              >
                <Show
                  when={addressBusy()}
                  fallback={<IoReturnDownForwardSharp />}
                >
                  <IoRefreshSharp class="spin" />
                </Show>
              </button>
            </div>
          </figure>
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
        </div>
      </div>
    </div>
  )
}
export default Mints
