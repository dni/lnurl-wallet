import type {Component} from 'solid-js'
import {Show, For, createSignal, createMemo} from 'solid-js'
import {A} from '@solidjs/router'
import {
  IoAddCircleSharp,
  IoQrCodeSharp,
  IoClipboardSharp,
  IoGitMergeSharp,
  IoLockOpenSharp,
  IoRefreshSharp,
  IoBanSharp,
  IoTrashSharp
} from 'solid-icons/io'

import {useWallet, groupByServer} from '../WalletContext'
import {serverOf, noteK1, withNewK1, mergeNotes} from '../lnurlcash'
import {notify, NotifyKind, msatToSats} from '../helpers'
import BearerCard from '../components/BearerCard'
import MintGroupCard from '../components/MintGroupCard'

const Wallet: Component = () => {
  const {state, bearers, unlock, addBearer, removeBearer} = useWallet()
  const [password, setPassword] = createSignal('')
  const [unlocking, setUnlocking] = createSignal(false)
  const [selected, setSelected] = createSignal<Set<string>>(new Set())
  const [combining, setCombining] = createSignal(false)
  const [showSpent, setShowSpent] = createSignal(false)
  const [confirmClearSpent, setConfirmClearSpent] = createSignal(false)

  // the hero's balance/mint count is always the spendable view (excludes
  // spent notes), regardless of whether the toggle is currently revealing
  // them - otherwise "Total balance" would count sats that aren't actually
  // yours to spend anymore
  const spendableBearers = createMemo(() => bearers().filter(b => !b.spent))
  const spentBearers = createMemo(() => bearers().filter(b => b.spent))
  const spentCount = createMemo(() => spentBearers().length)
  const spendableTotal = createMemo(() =>
    spendableBearers().reduce((sum, b) => sum + b.amount, 0)
  )
  const spentTotal = createMemo(() =>
    spentBearers().reduce((sum, b) => sum + b.amount, 0)
  )
  const mintCount = createMemo(() => groupByServer(spendableBearers()).length)
  const visibleBearers = createMemo(() =>
    showSpent() ? bearers() : spendableBearers()
  )

  const selectedBearers = createMemo(() =>
    bearers().filter(b => selected().has(b.id))
  )
  // merging burns all selected notes in one callback request, so they must
  // share a service, each must have been verified (callback known), and
  // none can be locally locked as spent - the checkbox is disabled for a
  // spent note too, this is just a second guard
  const combinable = createMemo(() => {
    const picked = selectedBearers()
    if (picked.length < 2) return false
    const server = serverOf(picked[0].url)
    return picked.every(
      b => serverOf(b.url) === server && b.callback !== '' && !b.spent
    )
  })
  const selectedTotal = createMemo(() =>
    selectedBearers().reduce((sum, b) => sum + b.amount, 0)
  )

  const toggleSelect = (id: string, isSelected: boolean) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (isSelected) next.add(id)
      else next.delete(id)
      return next
    })
  }

  // bulk version for MintGroupCard's select/deselect all - one signal
  // write for the whole group instead of N individual toggleSelect calls
  const selectMany = (ids: string[], isSelected: boolean) => {
    setSelected(prev => {
      const next = new Set(prev)
      for (const id of ids) {
        if (isSelected) next.add(id)
        else next.delete(id)
      }
      return next
    })
  }

  const unlockWallet = async (e: Event) => {
    e.preventDefault()
    setUnlocking(true)
    try {
      await unlock(password())
      setPassword('')
    } catch {
      notify('Incorrect password.', NotifyKind.ERROR)
    } finally {
      setUnlocking(false)
    }
  }

  // LUD-XX merge: one callback request with every selected k1 - all burned,
  // one fresh note worth their sum comes back (value derived locally, as
  // the spec's response intentionally carries no amounts)
  const combine = async () => {
    const picked = selectedBearers()
    if (!combinable()) return
    setCombining(true)
    try {
      const [base] = picked
      const total = selectedTotal()
      const merged = await mergeNotes(
        base.callback,
        picked.map(b => noteK1(b.url)!)
      )
      for (const bearer of picked) removeBearer(bearer.id)
      await addBearer({
        url: withNewK1(base.url, merged.k1, total, merged.signature),
        callback: base.callback,
        amount: total,
        verified: true,
        mintPubkey: base.mintPubkey
      })
      setSelected(new Set<string>())
      notify(`Combined ${picked.length} notes into one.`, NotifyKind.SUCCESS)
    } catch (err) {
      notify((err as Error).message, NotifyKind.ERROR)
    } finally {
      setCombining(false)
    }
  }

  // a bulk version of BearerCard's own per-note Clear - each spent note is
  // just a local record at this point (see storage.ts's Bearer.spent), so
  // this is a plain local removal, not a service call
  const clearAllSpent = () => {
    const spent = spentBearers()
    for (const bearer of spent) removeBearer(bearer.id)
    setConfirmClearSpent(false)
    setShowSpent(false)
    notify(
      `Cleared ${spent.length} spent note${spent.length === 1 ? '' : 's'}.`,
      NotifyKind.SUCCESS
    )
  }

  return (
    <Show
      when={state() !== 'none'}
      fallback={
        <div id="wallet" class="page">
          <figure>
            <h2>No wallet on this device yet</h2>
            <p>Create one, or restore a seed phrase you already have.</p>
            <div class="btns">
              <A href="/setup" class="hero-btn hero-btn-primary">
                Create wallet
              </A>
            </div>
          </figure>
        </div>
      }
    >
      <Show
        when={state() === 'unlocked'}
        fallback={
          <div id="unlock" class="page">
            <figure>
              <h2>Unlock your wallet</h2>
              <p>
                Your linking key is stored encrypted - enter your password to
                decrypt it and your bearer tokens.
              </p>
              <form onSubmit={unlockWallet}>
                <input
                  type="password"
                  placeholder="Password"
                  value={password()}
                  onInput={e => setPassword(e.currentTarget.value)}
                />
                <div class="btns">
                  <button type="submit" disabled={unlocking() || !password()}>
                    <Show when={unlocking()} fallback={<IoLockOpenSharp />}>
                      <IoRefreshSharp class="spin" />
                    </Show>
                    &nbsp;Unlock
                  </button>
                </div>
              </form>
              <p>
                <A href="/setup?tab=restore">Forgot password?</A>
              </p>
            </figure>
          </div>
        }
      >
        <Show
          when={bearers().length > 0}
          fallback={
            <div id="wallet" class="page">
              <section class="hero-intro">
                <h1>No LNURLcash yet</h1>
                <p class="hero-subtitle">
                  Your wallet is ready but empty. Mint a fresh bearer note from
                  any LNURLcash mint, or bring one in by scanning or pasting a
                  note someone handed you.
                </p>
                <div class="hero-actions">
                  <A href="/mint" class="hero-btn hero-btn-primary">
                    <IoAddCircleSharp />
                    &nbsp;Mint
                  </A>
                  <A href="/scan" class="hero-btn hero-btn-primary">
                    <IoQrCodeSharp />
                    &nbsp;Scan
                  </A>
                  <A href="/paste" class="hero-btn hero-btn-primary">
                    <IoClipboardSharp />
                    &nbsp;Paste
                  </A>
                </div>
              </section>
            </div>
          }
        >
          <div id="wallet" class="page">
            <section class="wallet-hero">
              <h2>Your LNURLcash</h2>
              <div class="wallet-stats">
                <div class="wallet-stat">
                  <span class="wallet-stat-value">
                    {msatToSats(spendableTotal())} sats
                  </span>
                  <span class="wallet-stat-label">Total balance</span>
                </div>
                <div class="wallet-stat">
                  <span class="wallet-stat-value">{mintCount()}</span>
                  <span class="wallet-stat-label">
                    {mintCount() === 1 ? 'Mint' : 'Mints'}
                  </span>
                </div>
                <Show when={spentCount() > 0}>
                  <div class="wallet-stat">
                    <span class="wallet-stat-value">
                      {msatToSats(spentTotal())} sats
                    </span>
                    <span class="wallet-stat-label">
                      Spent&nbsp;·&nbsp;{spentCount()}
                    </span>
                  </div>
                </Show>
              </div>
              <Show when={spentCount() > 0}>
                <div class="btns">
                  <label
                    class="switch-control"
                    title="Spent notes are locally locked (melted, transferred, or marked by hand) - this just shows or hides them, it doesn't change anything about them"
                  >
                    <IoBanSharp />
                    <span>
                      Show spent
                      <Show when={!showSpent()}>&nbsp;({spentCount()})</Show>
                    </span>
                    <span class="switch">
                      <input
                        type="checkbox"
                        checked={showSpent()}
                        onChange={e => setShowSpent(e.currentTarget.checked)}
                      />
                      <span class="switch-track"></span>
                    </span>
                  </label>
                  <button onClick={() => setConfirmClearSpent(true)}>
                    <IoTrashSharp />
                    &nbsp;Clear all spent
                  </button>
                </div>
                <Show when={confirmClearSpent()}>
                  <p class="warning">
                    Clear all {spentCount()} spent note
                    {spentCount() === 1 ? '' : 's'} from the wallet? If any of
                    them turn out not to have actually been spent, those sats
                    are gone unless you saved them elsewhere.
                  </p>
                  <div class="btns">
                    <button onClick={clearAllSpent}>Clear all</button>
                    <button onClick={() => setConfirmClearSpent(false)}>
                      Cancel
                    </button>
                  </div>
                </Show>
              </Show>
            </section>
            <Show when={selectedBearers().length > 0}>
              <div class="combine-bar">
                <span>
                  {selectedBearers().length} selected&nbsp;·&nbsp;
                  {msatToSats(selectedTotal())} sats
                </span>
                <Show
                  when={combinable()}
                  fallback={
                    <span class="combine-hint">
                      select 2+ verified notes from the same service to combine
                    </span>
                  }
                >
                  <button disabled={combining()} onClick={combine}>
                    <Show when={combining()} fallback={<IoGitMergeSharp />}>
                      <IoRefreshSharp class="spin" />
                    </Show>
                    &nbsp;Combine
                  </button>
                </Show>
              </div>
            </Show>
            <Show
              when={visibleBearers().length > 0}
              fallback={
                <p class="bearer-hint">
                  Every note here is marked spent - toggle "Show spent" above to
                  see them.
                </p>
              }
            >
              <For each={groupByServer(visibleBearers())}>
                {([server, group]) => (
                  <section class="server-group">
                    <MintGroupCard
                      server={server}
                      group={group}
                      selected={selected()}
                      onSelectAll={selectMany}
                    />
                    <div class="bearer-list">
                      <For each={group}>
                        {bearer => (
                          <BearerCard
                            bearer={bearer}
                            selected={selected().has(bearer.id)}
                            onSelect={isSelected =>
                              toggleSelect(bearer.id, isSelected)
                            }
                          />
                        )}
                      </For>
                    </div>
                  </section>
                )}
              </For>
            </Show>
          </div>
        </Show>
      </Show>
    </Show>
  )
}
export default Wallet
