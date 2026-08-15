import {createSignal} from 'solid-js'

// A mint's signing key (LUD-25 Offline verification's `mintPubkey`) - not a
// secret, just a public identity, so this is plain unencrypted localStorage,
// unlike bearer notes. A module-level signal (not wrapped behind
// WalletContext) so plain utility code - receive.ts in particular - can
// touch it too, not just UI components.
export type TrustedMint = {
  server: string
  mintPubkey: string
  addedAt: number
  // true once a bearer is held from this server - trust then follows
  // holding funds there, not a standalone opinion, so it can't be revoked
  // by deleting it here (see removeTrustedMint)
  locked: boolean
}

// A small curated list of known public mints, for a one-click quick start -
// unrelated to whether any given entry ends up in the trusted-mints
// registry above (appearing here says nothing about a mint's signing key or
// whether this wallet has ever used it).
export const PUBLIC_MINTS = ['mint@mint.600.wtf', 'mint@lnurl.21mint.me']

const STORAGE_KEY = 'lnurlcash_trusted_mints'

// 33-byte compressed secp256k1 pubkey, hex
const PUBKEY_PATTERN = /^[0-9a-f]{66}$/

const readStored = (): TrustedMint[] => {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

const [trustedMints, setTrustedMintsSignal] =
  createSignal<TrustedMint[]>(readStored())
export {trustedMints}

const persist = (mints: TrustedMint[]): void => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(mints))
  setTrustedMintsSignal(mints)
}

export const isMintTrusted = (server: string): boolean =>
  trustedMints().some(m => m.server === server)

export const getTrustedMintPubkey = (server: string): string | null =>
  trustedMints().find(m => m.server === server)?.mintPubkey ?? null

// Called whenever this wallet ends up holding (or already holds) a bearer
// from `server` - minting, receiving, splitting, merging, refreshing all
// route through WalletContext's addBearer/updateBearer, which is where
// this gets called from. Per "a mint you have a bearer from is trusted by
// default", this never asks and can't be refused - it silently trusts (or
// upgrades an already-trusted-but-unlocked entry) and locks it against
// removal.
export const lockTrustedMint = (server: string, mintPubkey: string): void => {
  const key = mintPubkey.trim().toLowerCase()
  if (!server || !PUBKEY_PATTERN.test(key)) return
  const current = trustedMints()
  const existing = current.find(m => m.server === server)
  if (existing?.mintPubkey === key && existing.locked) return
  persist(
    existing
      ? current.map(m =>
          m.server === server ? {...m, mintPubkey: key, locked: true} : m
        )
      : [
          ...current,
          {server, mintPubkey: key, addedAt: Date.now(), locked: true}
        ]
  )
}

// Manual add from the Mints page, or a user-confirmed first encounter (see
// Mint.tsx's lookup) - unlocked, since no bearer necessarily backs it yet.
// Validates and throws instead of silently no-op'ing, since a human is
// waiting on the result either way.
export const addTrustedMint = (server: string, mintPubkey: string): void => {
  const trimmedServer = server.trim()
  const key = mintPubkey.trim().toLowerCase()
  if (!trimmedServer) {
    throw new Error('Enter a server.')
  }
  if (!PUBKEY_PATTERN.test(key)) {
    throw new Error(
      'Signing key must be a 33-byte compressed pubkey (66 hex characters).'
    )
  }
  const current = trustedMints()
  const existing = current.find(m => m.server === trimmedServer)
  persist(
    existing
      ? current.map(m =>
          m.server === trimmedServer ? {...m, mintPubkey: key} : m
        )
      : [
          ...current,
          {
            server: trimmedServer,
            mintPubkey: key,
            addedAt: Date.now(),
            locked: false
          }
        ]
  )
}

// only succeeds for entries not backed by a held bearer - see
// TrustedMint.locked
export const removeTrustedMint = (server: string): void => {
  const entry = trustedMints().find(m => m.server === server)
  if (!entry) return
  if (entry.locked) {
    throw new Error("Can't remove - you hold a bearer note from this mint.")
  }
  persist(trustedMints().filter(m => m.server !== server))
}

// merges a backup's trusted mints in by server - a server already known on
// this device keeps its own current entry rather than being overwritten by
// the backup's (possibly stale) copy
export const mergeTrustedMints = (incoming: TrustedMint[]): number => {
  const current = trustedMints()
  const knownServers = new Set(current.map(m => m.server))
  const merged = [...current]
  let added = 0
  for (const mint of incoming) {
    if (
      typeof mint?.server !== 'string' ||
      typeof mint?.mintPubkey !== 'string' ||
      typeof mint?.addedAt !== 'number' ||
      !PUBKEY_PATTERN.test(mint.mintPubkey.toLowerCase())
    ) {
      continue
    }
    if (knownServers.has(mint.server)) continue
    merged.push({
      server: mint.server,
      mintPubkey: mint.mintPubkey.toLowerCase(),
      addedAt: mint.addedAt,
      locked: !!mint.locked
    })
    knownServers.add(mint.server)
    added++
  }
  if (added > 0) persist(merged)
  return added
}
