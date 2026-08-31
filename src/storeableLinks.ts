import {createSignal} from 'solid-js'

// LUD-11: a payRequest's second (invoice) callback response MAY set
// `disposable: false` to say the LNURL/Lightning Address that led here -
// not the invoice itself, which is always one-shot regardless - is meant
// to be kept around and reused. Per spec, absent/null/true means
// disposable (don't keep it); see lnurlcash.ts's requestInvoice for where
// that's parsed. Not a secret, just a convenience shortcut, so plain
// unencrypted localStorage, same as trustedMints.ts.
//
// Two separate registries, never merged: one for payRequests seen on the
// Mint page (places to mint FROM), one for MeltDialog's "pay to a
// Lightning Address" flow (places to melt/pay TO). A mint saying its own
// payRequest is storeable says nothing about whether it's also a sane
// melt destination, and vice versa - conflating them would surface a
// mint's minting address as a melt suggestion or the reverse.
export type StoreableLink = {
  address: string
  addedAt: number
}

const readStored = (key: string): StoreableLink[] => {
  const raw = localStorage.getItem(key)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    // shape-check every entry - a tampered/corrupt record must not plant
    // junk entries into the registry
    return parsed.filter(
      l => typeof l?.address === 'string' && typeof l?.addedAt === 'number'
    )
  } catch {
    return []
  }
}

const makeRegistry = (storageKey: string) => {
  const [links, setLinksSignal] = createSignal<StoreableLink[]>(
    readStored(storageKey)
  )

  const persist = (next: StoreableLink[]): void => {
    localStorage.setItem(storageKey, JSON.stringify(next))
    setLinksSignal(next)
  }

  const add = (address: string): void => {
    const trimmed = address.trim()
    if (!trimmed) return
    const current = links()
    if (current.some(l => l.address === trimmed)) return
    persist([...current, {address: trimmed, addedAt: Date.now()}])
  }

  const remove = (address: string): void => {
    persist(links().filter(l => l.address !== address))
  }

  const clear = (): void => {
    localStorage.removeItem(storageKey)
    setLinksSignal([])
  }

  return {links, add, remove, clear}
}

const mintRegistry = makeRegistry('lnurlcash_storeable_mints')
const meltRegistry = makeRegistry('lnurlcash_storeable_melt_addresses')

export const storeableMints = mintRegistry.links
export const addStoreableMint = mintRegistry.add
export const removeStoreableMint = mintRegistry.remove

export const storeableMeltAddresses = meltRegistry.links
export const addStoreableMeltAddress = meltRegistry.add
export const removeStoreableMeltAddress = meltRegistry.remove

// wipes both registries - part of forgetting a wallet (WalletContext's
// forgetWallet): nothing about a wallet's mints should linger after it
export const clearStoreableLinks = (): void => {
  mintRegistry.clear()
  meltRegistry.clear()
}
