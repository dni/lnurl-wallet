import type {Component} from 'solid-js'
import {Show, For, createSignal, createMemo} from 'solid-js'
import {A} from '@solidjs/router'
import {
  IoAddCircleSharp,
  IoPaperPlaneSharp,
  IoArrowDownCircleSharp,
  IoLockOpenSharp,
  IoRefreshSharp,
  IoTrashSharp,
  IoReceiptSharp
} from 'solid-icons/io'

import {useWallet, groupByServer} from '../WalletContext'
import {serverOf} from '../lnurlcash'
import {notify, NotifyKind, msatToSats} from '../helpers'
import MintGroupCard from '../components/MintGroupCard'
import SendDialog from '../components/SendDialog'
import ReceiveDialog from '../components/ReceiveDialog'

const Wallet: Component = () => {
  const {state, bearers, unlock, removeBearer} = useWallet()
  const [password, setPassword] = createSignal('')
  const [unlocking, setUnlocking] = createSignal(false)
  const [selected, setSelected] = createSignal<Set<string>>(new Set())
  const [confirmClearSpent, setConfirmClearSpent] = createSignal(false)
  // mutually exclusive - opening one closes the other rather than letting
  // both dialogs be up (and independently mutating wallet state) at once
  const [openDialog, setOpenDialog] = createSignal<'send' | 'receive' | null>(
    null
  )
  const showSend = () => openDialog() === 'send'
  const showReceive = () => openDialog() === 'receive'

  // the hero's balance/mint count is always the spendable view (excludes
  // spent notes) - "Total balance" shouldn't count sats that aren't
  // actually yours to spend anymore. Per-mint spent visibility is handled
  // inside MintGroupCard instead of here (see its own showSpent signal)
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
  // groupByServer rebuilds its Map and every [server, group] tuple fresh on
  // each call, so keying <For> directly off its result would tear down and
  // remount every MintGroupCard (losing showNotes, etc.) on any bearer
  // change anywhere in the wallet, not just the affected group. Server
  // names are plain strings though - stable by value across calls - so
  // keying on those instead lets <For> recognize an unchanged mint as the
  // same row and just update its props, not recreate it. Grouped from all
  // bearers (not just spendable) so a mint holding only spent notes still
  // gets a card - its own showSpent toggle is what reveals them
  const serverNames = createMemo(() =>
    groupByServer(bearers()).map(([server]) => server)
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

  // a bulk version of BearerCard's own per-note Clear - each spent note is
  // just a local record at this point (see storage.ts's Bearer.spent), so
  // this is a plain local removal, not a service call
  const clearAllSpent = () => {
    const spent = spentBearers()
    for (const bearer of spent) removeBearer(bearer.id)
    setConfirmClearSpent(false)
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
                  autocomplete="current-password"
                  autocapitalize="off"
                  spellcheck={false}
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
                  <button
                    type="button"
                    class="hero-btn hero-btn-primary"
                    onClick={() => setOpenDialog('receive')}
                  >
                    <IoArrowDownCircleSharp />
                    &nbsp;Receive
                  </button>
                </div>
                <Show when={showReceive()}>
                  <ReceiveDialog onClose={() => setOpenDialog(null)} />
                </Show>
              </section>
            </div>
          }
        >
          <div id="wallet" class="page">
            <section class="wallet-hero">
              <div class="wallet-hero-header">
                <h2>Your LNURLcash</h2>
                <div class="wallet-hero-actions">
                  <A
                    href="/activity"
                    class="icon-btn"
                    title="Activity log - a history of every mint, split, combine, melt and transfer"
                  >
                    <IoReceiptSharp />
                  </A>
                  <Show when={spentCount() > 0}>
                    <button
                      class="icon-btn"
                      title={`Clear all ${spentCount()} spent note${spentCount() === 1 ? '' : 's'} from the wallet`}
                      onClick={() => setConfirmClearSpent(true)}
                    >
                      <IoTrashSharp />
                    </button>
                  </Show>
                </div>
              </div>
              <Show when={confirmClearSpent()}>
                <p class="warning">
                  Clear all {spentCount()} spent note
                  {spentCount() === 1 ? '' : 's'} from the wallet? If any of
                  them turn out not to have actually been spent, those sats are
                  gone unless you saved them elsewhere.
                </p>
                <div class="btns">
                  <button onClick={clearAllSpent}>Clear all</button>
                  <button onClick={() => setConfirmClearSpent(false)}>
                    Cancel
                  </button>
                </div>
              </Show>
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
              <div class="btns">
                <button type="button" onClick={() => setOpenDialog('receive')}>
                  <IoArrowDownCircleSharp />
                  &nbsp;Receive
                </button>
                <button type="button" onClick={() => setOpenDialog('send')}>
                  <IoPaperPlaneSharp />
                  &nbsp;Send
                </button>
              </div>
            </section>
            <Show when={showReceive()}>
              <ReceiveDialog onClose={() => setOpenDialog(null)} />
            </Show>
            <Show when={showSend()}>
              <SendDialog onClose={() => setOpenDialog(null)} />
            </Show>
            <For each={serverNames()}>
              {server => (
                <section class="server-group">
                  <MintGroupCard
                    server={server}
                    group={bearers().filter(b => serverOf(b.url) === server)}
                    selected={selected()}
                    onSelect={toggleSelect}
                    onSelectAll={selectMany}
                  />
                </section>
              )}
            </For>
          </div>
        </Show>
      </Show>
    </Show>
  )
}
export default Wallet
