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
  // best-effort node identity/capacity, cached from the mint-address
  // discovery endpoint (see lnurlcash.ts's fetchMintAddress) purely for
  // display (Mints.tsx) - absent for a mint that doesn't support it, or one
  // trusted before this wallet learned to ask. Never used for anything
  // security-relevant; mintPubkey above remains the only thing a note's
  // signature is ever checked against.
  nodeAlias?: string
  nodeColor?: string
  nodeCapacityMsat?: number
  nodeNumChannels?: number
  nodeNumPeers?: number
  // the local-part this mint was actually reached at ("mint" out of
  // "mint@host" - see lnurlcash.ts's lightningAddressUsername), cached so a
  // later quick-select (Mint.tsx) can reconstruct the exact address instead
  // of guessing "mint@<server>" for a mint that uses a different one.
  // Absent for a mint only ever looked up as a bech32 LNURL, which has no
  // such concept.
  username?: string
}

// the subset of TrustedMint that's cacheable display metadata, as opposed
// to the server/mintPubkey/addedAt/locked fields every entry has regardless
export type TrustedMintNodeInfo = {
  nodeAlias?: string
  nodeColor?: string
  nodeCapacityMsat?: number
  nodeNumChannels?: number
  nodeNumPeers?: number
  username?: string
}

// A small curated list of known public mints, for a one-click quick start -
// unrelated to whether any given entry ends up in the trusted-mints
// registry above (appearing here says nothing about a mint's signing key or
// whether this wallet has ever used it). The bare "@domain" form (see
// lnurlcash.ts's isBareMintDomain) rather than spelling out "mint@domain" -
// still resolves to the exact same address, just how these mints tend to
// actually display their own.
export const PUBLIC_MINTS = [
  '@mint.600.wtf',
  '@lnurl.21mint.me',
  '@mint.forgesworn.dev',
  '@minty.exe.xyz'
]

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

// this mint's self-reported node color, for tinting its notes' background
// (see BearerCard) - purely cosmetic, absent whenever no mint-address
// lookup has ever cached one for this server
export const getTrustedMintNodeColor = (server: string): string | null =>
  trustedMints().find(m => m.server === server)?.nodeColor ?? null

// the exact Lightning Address this mint was last reached at (see
// TrustedMint.username), for a quick-select that reconstructs it instead of
// guessing "mint@<server>" - null for a mint with no cached username
// (looked up as a bech32 LNURL, or trusted before this wallet learned to
// remember one)
export const getTrustedMintAddress = (server: string): string | null => {
  const username = trustedMints().find(m => m.server === server)?.username
  return username ? `${username}@${server}` : null
}

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
// waiting on the result either way. `nodeInfo` is whatever the mint-address
// lookup (if any) turned up alongside this pubkey - optional, since a
// manual add (Mints.tsx) or a mint without that endpoint has none to give.
export const addTrustedMint = (
  server: string,
  mintPubkey: string,
  nodeInfo?: TrustedMintNodeInfo
): void => {
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
          m.server === trimmedServer ? {...m, mintPubkey: key, ...nodeInfo} : m
        )
      : [
          ...current,
          {
            server: trimmedServer,
            mintPubkey: key,
            addedAt: Date.now(),
            locked: false,
            ...nodeInfo
          }
        ]
  )
}

// refreshes just the cached display info (Mints.tsx) for a server already
// in the list - never touches mintPubkey/addedAt/locked, and no-ops for a
// server that isn't trusted yet (that's addTrustedMint's job, which takes
// the same info directly alongside the pubkey it's trusting for the first
// time). Called opportunistically whenever a lookup re-discovers a mint
// address for a mint this wallet already trusts, so the cache doesn't just
// freeze at whatever was known the moment trust was first established.
export const cacheTrustedMintNodeInfo = (
  server: string,
  nodeInfo: TrustedMintNodeInfo
): void => {
  const current = trustedMints()
  if (!current.some(m => m.server === server)) return
  persist(current.map(m => (m.server === server ? {...m, ...nodeInfo} : m)))
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
      locked: !!mint.locked,
      nodeAlias:
        typeof mint.nodeAlias === 'string' ? mint.nodeAlias : undefined,
      nodeColor:
        typeof mint.nodeColor === 'string' ? mint.nodeColor : undefined,
      nodeCapacityMsat:
        typeof mint.nodeCapacityMsat === 'number'
          ? mint.nodeCapacityMsat
          : undefined,
      nodeNumChannels:
        typeof mint.nodeNumChannels === 'number'
          ? mint.nodeNumChannels
          : undefined,
      nodeNumPeers:
        typeof mint.nodeNumPeers === 'number' ? mint.nodeNumPeers : undefined,
      username: typeof mint.username === 'string' ? mint.username : undefined
    })
    knownServers.add(mint.server)
    added++
  }
  if (added > 0) persist(merged)
  return added
}
