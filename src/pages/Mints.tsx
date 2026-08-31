import type {Component} from 'solid-js'
import {For, Show, createSignal} from 'solid-js'
import {
  IoAddCircleSharp,
  IoTrashSharp,
  IoLockClosedSharp,
  IoClipboardSharp,
  IoCloseSharp,
  IoReturnDownForwardSharp,
  IoRefreshSharp,
  IoGlobeSharp,
  IoOpenSharp
} from 'solid-icons/io'

import {useWallet} from '../WalletContext'
import type {TrustedMint, TrustedMintNodeInfo} from '../trustedMints'
import {
  trustedMints,
  addTrustedMint,
  removeTrustedMint,
  isMintTrusted,
  mintAddressCacheInfo,
  getTrustedMintAddress,
  confirmTrustedMintRekey,
  dismissTrustedMintRekey,
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
  pasteFromClipboard,
  mempoolNodeUrl
} from '../helpers'
import {offlineMode} from '../offlineMode'
import ScanToggle from '../components/ScanToggle'
import NfcToggle from '../components/NfcToggle'

const Mints: Component = () => {
  const {bearers} = useWallet()
  const [server, setServer] = createSignal('')
  const [pubkey, setPubkey] = createSignal('')
  const [confirmDelete, setConfirmDelete] = createSignal<string | null>(null)

  // computed straight from live bearer state rather than trusting
  // TrustedMint.locked - that flag is reconciled elsewhere (see
  // WalletContext's unlock effect) but is still a persisted, mutable field
  // several code paths touch; checking bearers() directly here means the
  // Remove button's visibility can never drift out of sync with what's
  // actually held
  const hasNotesFrom = (mintServer: string): boolean =>
    bearers().some(b => !b.spent && serverOf(b.url) === mintServer)

  // "add by address" - a best-effort automated alternative to the manual
  // form below: looks up a mint's own mint-address discovery endpoint (see
  // lnurlcash.ts's fetchMintAddress) and trusts whatever signing key it
  // advertises there, same source Mint.tsx's own lookup prefers for its
  // early trust prompt. Experimental (most mints won't have it yet) - a
  // mint that doesn't still needs the manual form, with a pubkey trusted
  // from elsewhere (its own site, a friend, etc).
  const [addressInput, setAddressInput] = createSignal('')
  const [addressBusy, setAddressBusy] = createSignal(false)
  // a looked-up mint this wallet has no entry for yet, awaiting an explicit
  // "trust this key" click before anything is pinned - the same posture as
  // Mint.tsx's own pendingTrust card: one scanned QR or typosquatted
  // address shouldn't silently pin a signing key the holder never saw
  const [pendingTrust, setPendingTrust] = createSignal<{
    server: string
    pubkey: string
    nodeInfo?: TrustedMintNodeInfo
  } | null>(null)
  // which trusted mint's own refresh button is currently in flight - only
  // used to put a spinner on the one card that was actually clicked;
  // addressBusy() above still gates every button on the page against a
  // second concurrent lookup, same single-flow-at-a-time rule the "add by
  // address" widget already follows
  const [refreshingServer, setRefreshingServer] = createSignal<string | null>(
    null
  )

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
      const nodeInfo = mintAddressCacheInfo(info, lightningAddressUsername(url))
      // a mint with no entry yet gets an explicit confirmation showing the
      // key before anything is pinned - already-trusted mints (including
      // every Refresh button below) skip straight to the upsert
      if (!isMintTrusted(mintServer)) {
        setPendingTrust({server: mintServer, pubkey: info.nodePubkey, nodeInfo})
        return
      }
      const result = addTrustedMint(mintServer, info.nodePubkey, nodeInfo)
      setAddressInput('')
      if (result === 'rekey-pending') {
        notify(
          `${mintServer} now advertises a different signing key than the one pinned - review it below before trusting "signed" notes from it.`,
          NotifyKind.ERROR
        )
      } else {
        notify(`${mintServer}'s cached info refreshed.`, NotifyKind.SUCCESS)
      }
    } catch (err) {
      notify((err as Error).message, NotifyKind.ERROR)
    } finally {
      setAddressBusy(false)
    }
  }

  const confirmTrust = () => {
    const pending = pendingTrust()
    if (!pending) return
    try {
      const result = addTrustedMint(
        pending.server,
        pending.pubkey,
        pending.nodeInfo
      )
      setPendingTrust(null)
      setAddressInput('')
      if (result === 'rekey-pending') {
        notify(
          `${pending.server} already has a different key pinned - the new one was staged for review below.`,
          NotifyKind.ERROR
        )
      } else {
        notify(
          `${pending.server} added to your trusted list.`,
          NotifyKind.SUCCESS
        )
      }
    } catch (err) {
      notify((err as Error).message, NotifyKind.ERROR)
    }
  }

  const cancelTrust = () => {
    setPendingTrust(null)
    notify('Mint not trusted - lookup cancelled.', NotifyKind.ERROR)
  }

  // the holder reviewed a mint's advertised new signing key (shown on its
  // card below) - these two are the ONLY paths that ever change a pinned
  // key or drop a staged candidate
  const rekey = (mintServer: string) => {
    confirmTrustedMintRekey(mintServer)
    notify(`${mintServer}'s new signing key is now pinned.`, NotifyKind.SUCCESS)
  }

  const dismissRekey = (mintServer: string) => {
    dismissTrustedMintRekey(mintServer)
    notify(
      `Keeping the original signing key for ${mintServer}.`,
      NotifyKind.SUCCESS
    )
  }

  const pasteAddress = async () => {
    const text = await pasteFromClipboard()
    if (text !== null) setAddressInput(text)
  }

  // re-runs the same mint-address lookup addByAddress does, against
  // whichever address this mint was last actually reached at (its cached
  // username, same convention Mint.tsx's own mintAddressFor uses) or the
  // "mint" username default if none was ever cached - the upsert refreshes
  // an already-trusted entry's alias/color/capacity/channels/peers, and if
  // the mint now advertises a DIFFERENT pubkey it gets staged for review on
  // its card below rather than replacing the pinned one
  const refreshMint = async (mint: TrustedMint) => {
    const address = getTrustedMintAddress(mint.server) || `mint@${mint.server}`
    setRefreshingServer(mint.server)
    try {
      await addByAddress(address)
    } finally {
      setRefreshingServer(null)
    }
  }

  const add = () => {
    try {
      const name = server().trim()
      const result = addTrustedMint(name, pubkey())
      if (result === 'rekey-pending') {
        notify(
          `${name} already has a different key pinned - the new one was staged for review below.`,
          NotifyKind.ERROR
        )
        return
      }
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
        Every signing key this wallet checks notes against lives here -
        remembered the moment you look up, mint from, refresh, or receive a note
        from a mint. One you already hold a bearer note from is trusted
        automatically and can't be removed; anything else was added manually and
        can be removed. If a mint advertises a different key, it's staged for
        review - the pinned key keeps deciding the "signed" badge until you
        confirm it.
      </p>
      <div class="two-columns">
        <div class="two-col">
          <h4>Trusted mints</h4>
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
                    {/* a pin that came from a backup or a stored note rather
                    than a live response (see TrustedMint.unconfirmed) - said
                    so plainly, since "signed" badges deliberately ignore it
                    until the mint advertises the same key online */}
                    <Show when={mint.unconfirmed}>
                      <p class="warning">
                        Restored from a backup or a stored note - not yet
                        confirmed against this mint live, so signatures are not
                        verified against it. Any refresh or mint lookup that
                        advertises the same key confirms it.
                      </p>
                    </Show>
                    {/* a staged key rotation (see trustedMints.ts): the mint
                    advertised a different signing key than the pinned one.
                    The pinned key above keeps deciding the "signed" badge
                    until the holder explicitly promotes the candidate here -
                    a silent swap would let a compromised mint sign unbacked
                    notes that still show as verified */}
                    <Show when={mint.pendingMintPubkey}>
                      <p class="warning">
                        This mint now advertises a different signing key - fine
                        if it announced a move to a new node, an attack
                        otherwise. Its new signatures currently do{' '}
                        <strong>not</strong> show as verified. Only trust the
                        new key if the mint itself announced the change:
                      </p>
                      <p class="mint-pubkey">{mint.pendingMintPubkey}</p>
                      <div class="btns">
                        <button onClick={() => rekey(mint.server)}>
                          Trust new key
                        </button>
                        <button onClick={() => dismissRekey(mint.server)}>
                          Keep current key
                        </button>
                      </div>
                    </Show>
                    <div class="btns">
                      <button
                        disabled={addressBusy() || offlineMode()}
                        title={
                          offlineMode()
                            ? 'Offline mode is on'
                            : "Refresh this mint's cached info"
                        }
                        onClick={() => refreshMint(mint)}
                      >
                        <IoRefreshSharp
                          classList={{spin: refreshingServer() === mint.server}}
                        />
                        &nbsp;Refresh
                      </button>
                      <a
                        class="icon-btn"
                        title="Open this mint"
                        href={`https://${mint.server}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <IoGlobeSharp />
                      </a>
                      <a
                        class="icon-btn icon-btn-gap"
                        title="Look up this Lightning node on mempool.space"
                        href={mempoolNodeUrl(mint.mintPubkey)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <IoOpenSharp />
                      </a>
                    </div>
                    <Show
                      when={!hasNotesFrom(mint.server)}
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
          <figure class="setup-card">
            <h4>Public mints</h4>
            <p>
              A small curated list, for a quick start - click one to look up and
              trust its signing key via its mint-address discovery endpoint
              (same as "Add a mint by address" below), or refresh it if it's
              already trusted. The globe icon opens the mint's own site instead,
              to look it up by hand first.
            </p>
            <div class="mint-picker">
              <For each={PUBLIC_MINTS}>
                {address => {
                  const url = resolveMintInput(address)
                  const alreadyTrusted = () =>
                    !!url && isMintTrusted(serverOf(url))
                  return (
                    <Show when={url}>
                      <span class="mint-picker-entry">
                        <button
                          disabled={addressBusy() || offlineMode()}
                          title={
                            offlineMode()
                              ? 'Offline mode is on'
                              : alreadyTrusted()
                                ? "Refresh this mint's cached info"
                                : 'Look up and trust this mint'
                          }
                          onClick={() => addByAddress(address)}
                        >
                          <Show when={alreadyTrusted()}>
                            <IoLockClosedSharp />
                            &nbsp;
                          </Show>
                          {address}
                        </button>
                        <a
                          class="icon-btn"
                          title="Open this mint's site"
                          href={`https://${serverOf(url!)}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          <IoGlobeSharp />
                        </a>
                      </span>
                    </Show>
                  )
                }}
              </For>
            </div>
          </figure>
          <Show when={pendingTrust()}>
            {pending => (
              <figure class="setup-card">
                <h4>Trust this mint?</h4>
                <p>
                  {pending().server} advertises the signing key below. It will
                  decide whether notes from this mint show the "signed" badge -
                  only trust it if you reached this address from the mint itself
                  (its own site, not a forwarded link).
                </p>
                <p class="mint-pubkey">{pending().pubkey}</p>
                <div class="btns">
                  <button onClick={confirmTrust}>Trust this key</button>
                  <button onClick={cancelTrust}>Cancel</button>
                </div>
              </figure>
            )}
          </Show>
          <figure class="paste-widget">
            <h4>Add a mint by address</h4>
            <p>
              Looks up a mint's LNURL, Lightning Address, or bare domain (e.g.
              "mint@host" or just "@host") via its mint-address discovery
              endpoint, and asks you to confirm the signing key it advertises
              before trusting it - experimental, so most mints won't have it
              yet. Falls back to the manual form below if it doesn't.
            </p>
            <div class="paste-input-row">
              <ScanToggle
                onScan={value => addByAddress(value)}
                accept={v => resolveMintInput(v) !== null}
              />
              <NfcToggle
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
