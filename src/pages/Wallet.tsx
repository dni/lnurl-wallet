import type {Component} from 'solid-js'
import {Show, For, createSignal, createMemo} from 'solid-js'
import {A} from '@solidjs/router'
import {
  IoAddCircleSharp,
  IoQrCodeSharp,
  IoClipboardSharp,
  IoGitMergeSharp,
  IoLockOpenSharp,
  IoRefreshSharp
} from 'solid-icons/io'

import {useWallet, groupByServer} from '../WalletContext'
import {serverOf, noteK1, withNewK1, mergeNotes} from '../lnurlcash'
import {notify, NotifyKind, msatToSats} from '../helpers'
import BearerCard from '../components/BearerCard'

const Wallet: Component = () => {
  const {state, bearers, unlock, addBearer, removeBearer} = useWallet()
  const [password, setPassword] = createSignal('')
  const [unlocking, setUnlocking] = createSignal(false)
  const [selected, setSelected] = createSignal<Set<string>>(new Set())
  const [combining, setCombining] = createSignal(false)

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
            <div class="page-header">
              <h2>
                Your LNURLcash&nbsp;·&nbsp;
                {msatToSats(
                  bearers().reduce((sum, b) => sum + b.amount, 0)
                )}{' '}
                sats
              </h2>
            </div>
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
            <For each={groupByServer(bearers())}>
              {([server, group]) => (
                <section class="server-group">
                  <h4>
                    {server}&nbsp;·&nbsp;
                    {msatToSats(
                      group.reduce((sum, b) => sum + b.amount, 0)
                    )}{' '}
                    sats
                  </h4>
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
          </div>
        </Show>
      </Show>
    </Show>
  )
}
export default Wallet
