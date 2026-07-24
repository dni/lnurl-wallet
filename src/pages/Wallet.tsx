import type {Component} from 'solid-js'
import {Show, For, createSignal, createMemo} from 'solid-js'
import {A} from '@solidjs/router'
import {
  IoAddCircleSharp,
  IoQrCodeSharp,
  IoClipboardSharp,
  IoGitMergeSharp,
  IoLockOpenSharp
} from 'solid-icons/io'

import {useWallet, groupByServer} from '../WalletContext'
import {
  encodeCashToken,
  resolveCashInput,
  serverOf,
  fetchCashStatus,
  combineCash
} from '../lnurlcash'
import {notify, NotifyKind, msatToSats} from '../helpers'
import Hero from '../components/Hero'
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
  // combining only makes sense for 2+ bearers issued by the same server
  const combinable = createMemo(() => {
    const picked = selectedBearers()
    if (picked.length < 2) return false
    const server = serverOf(picked[0].url)
    return picked.every(b => serverOf(b.url) === server)
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

  const combine = async () => {
    const picked = selectedBearers()
    if (!combinable()) return
    setCombining(true)
    try {
      const [base, ...rest] = picked
      const newToken = await combineCash(
        base.url,
        rest.map(b => encodeCashToken(b.url))
      )
      const url = resolveCashInput(newToken)
      if (!url) throw new Error('Server returned an unusable token.')
      for (const bearer of picked) removeBearer(bearer.id)
      const status = await fetchCashStatus(url).catch(() => null)
      await addBearer(url, status?.amount ?? selectedTotal())
      setSelected(new Set<string>())
      notify(
        `Combined ${picked.length} bearers into one.`,
        NotifyKind.SUCCESS
      )
    } catch (err) {
      notify((err as Error).message, NotifyKind.ERROR)
    } finally {
      setCombining(false)
    }
  }

  return (
    <Show when={state() !== 'none'} fallback={<Hero mode="welcome" />}>
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
                    <IoLockOpenSharp />
                    &nbsp;Unlock
                  </button>
                </div>
              </form>
            </figure>
          </div>
        }
      >
        <Show when={bearers().length > 0} fallback={<Hero mode="empty" />}>
          <div id="wallet" class="page">
            <div class="page-header">
              <h2>
                Your LNURLcash&nbsp;·&nbsp;
                {msatToSats(bearers().reduce((sum, b) => sum + b.amount, 0))}{' '}
                sats
              </h2>
              <div class="wallet-actions">
                <A href="/mint" class="nav-link" title="Mint">
                  <IoAddCircleSharp />
                  &nbsp;Mint
                </A>
                <A href="/scan" class="nav-link" title="Scan">
                  <IoQrCodeSharp />
                  &nbsp;Scan
                </A>
                <A href="/paste" class="nav-link" title="Paste">
                  <IoClipboardSharp />
                  &nbsp;Paste
                </A>
              </div>
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
                      select 2+ bearers from the same server to combine
                    </span>
                  }
                >
                  <button disabled={combining()} onClick={combine}>
                    <IoGitMergeSharp />
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
                    {msatToSats(group.reduce((sum, b) => sum + b.amount, 0))}{' '}
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
