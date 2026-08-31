import {beforeEach, describe, expect, it, vi} from 'vitest'

// trustedMints.ts reads localStorage once at import time (its module-level
// signal initializes from it), so an in-memory stand-in has to be in place
// before the module is imported - and each test re-imports fresh via
// vi.resetModules so no state leaks between cases
const store = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, String(value)),
  removeItem: (key: string) => void store.delete(key),
  clear: () => store.clear(),
  key: () => null,
  get length() {
    return store.size
  }
})

const KEY_A = `02${'a'.repeat(64)}`
const KEY_B = `03${'b'.repeat(64)}`
const KEY_C = `02${'c'.repeat(64)}`

let mod: typeof import('./trustedMints')

beforeEach(async () => {
  store.clear()
  vi.resetModules()
  mod = await import('./trustedMints')
})

describe('lockTrustedMint', () => {
  it('trusts and locks a first-seen mint', () => {
    expect(mod.lockTrustedMint('mint.example', KEY_A)).toBe('added')
    const entry = mod.trustedMints().find(m => m.server === 'mint.example')
    expect(entry?.mintPubkey).toBe(KEY_A)
    expect(entry?.locked).toBe(true)
  })

  it('is a no-op for the same key, but locks an unlocked entry', () => {
    mod.addTrustedMint('mint.example', KEY_A)
    expect(mod.lockTrustedMint('mint.example', KEY_A)).toBe('unchanged')
    expect(
      mod.trustedMints().find(m => m.server === 'mint.example')?.locked
    ).toBe(true)
    expect(mod.lockTrustedMint('mint.example', KEY_A)).toBe('unchanged')
    expect(mod.trustedMints()).toHaveLength(1)
  })

  it('never silently replaces a differing advertised key - it stages it', () => {
    mod.lockTrustedMint('mint.example', KEY_A)
    expect(mod.lockTrustedMint('mint.example', KEY_B)).toBe('rekey-pending')
    const entry = mod.trustedMints().find(m => m.server === 'mint.example')
    expect(entry?.mintPubkey).toBe(KEY_A) // the pin is untouched
    expect(entry?.pendingMintPubkey).toBe(KEY_B)
    // the offline-verification lookup must keep answering the pinned key
    expect(mod.getTrustedMintPubkey('mint.example')).toBe(KEY_A)
    // re-seeing the same candidate is idempotent
    expect(mod.lockTrustedMint('mint.example', KEY_B)).toBe('rekey-pending')
    expect(mod.trustedMints()).toHaveLength(1)
  })

  it('ignores keys that are not 33-byte compressed pubkeys', () => {
    expect(mod.lockTrustedMint('mint.example', 'not-a-key')).toBe('unchanged')
    expect(mod.lockTrustedMint('', KEY_A)).toBe('unchanged')
    expect(mod.trustedMints()).toHaveLength(0)
  })
})

describe('rekey review', () => {
  it('confirm promotes the staged key to the pin', () => {
    mod.lockTrustedMint('mint.example', KEY_A)
    mod.lockTrustedMint('mint.example', KEY_B)
    mod.confirmTrustedMintRekey('mint.example')
    const entry = mod.trustedMints().find(m => m.server === 'mint.example')
    expect(entry?.mintPubkey).toBe(KEY_B)
    expect(entry?.pendingMintPubkey).toBeUndefined()
    expect(mod.getTrustedMintPubkey('mint.example')).toBe(KEY_B)
    // the lock survives the rotation
    expect(entry?.locked).toBe(true)
  })

  it('dismiss drops the candidate and keeps the original pin', () => {
    mod.lockTrustedMint('mint.example', KEY_A)
    mod.lockTrustedMint('mint.example', KEY_B)
    mod.dismissTrustedMintRekey('mint.example')
    const entry = mod.trustedMints().find(m => m.server === 'mint.example')
    expect(entry?.mintPubkey).toBe(KEY_A)
    expect(entry?.pendingMintPubkey).toBeUndefined()
    // a fresh detection can be staged again afterwards
    expect(mod.lockTrustedMint('mint.example', KEY_C)).toBe('rekey-pending')
    expect(
      mod.trustedMints().find(m => m.server === 'mint.example')
        ?.pendingMintPubkey
    ).toBe(KEY_C)
  })

  it('confirm/dismiss are no-ops without a staged candidate', () => {
    mod.lockTrustedMint('mint.example', KEY_A)
    mod.confirmTrustedMintRekey('mint.example')
    mod.dismissTrustedMintRekey('mint.example')
    expect(
      mod.trustedMints().find(m => m.server === 'mint.example')?.mintPubkey
    ).toBe(KEY_A)
  })
})

describe('addTrustedMint', () => {
  it('adds a new mint unlocked', () => {
    expect(mod.addTrustedMint('mint.example', KEY_A)).toBe('added')
    const entry = mod.trustedMints().find(m => m.server === 'mint.example')
    expect(entry?.locked).toBe(false)
  })

  it('refreshes node info on the same key, untouched otherwise', () => {
    mod.addTrustedMint('mint.example', KEY_A)
    expect(
      mod.addTrustedMint('mint.example', KEY_A, {nodeAlias: 'Better Mint'})
    ).toBe('unchanged')
    const entry = mod.trustedMints().find(m => m.server === 'mint.example')
    expect(entry?.nodeAlias).toBe('Better Mint')
    expect(entry?.pendingMintPubkey).toBeUndefined()
  })

  it('stages a differing key for review instead of overwriting the pin', () => {
    mod.addTrustedMint('mint.example', KEY_A)
    expect(mod.addTrustedMint('mint.example', KEY_B, {nodeAlias: 'x'})).toBe(
      'rekey-pending'
    )
    const entry = mod.trustedMints().find(m => m.server === 'mint.example')
    expect(entry?.mintPubkey).toBe(KEY_A)
    expect(entry?.pendingMintPubkey).toBe(KEY_B)
    expect(entry?.nodeAlias).toBe('x') // display info still refreshed
  })

  it('validates its inputs and throws', () => {
    expect(() => mod.addTrustedMint('', KEY_A)).toThrow()
    expect(() => mod.addTrustedMint('mint.example', 'nope')).toThrow()
    expect(mod.trustedMints()).toHaveLength(0)
  })
})

describe('mergeTrustedMints (backup restore)', () => {
  it('never imports locks or staged rekeys from a file', () => {
    const added = mod.mergeTrustedMints([
      {
        server: 'mint.example',
        mintPubkey: KEY_A,
        addedAt: 1,
        locked: true,
        pendingMintPubkey: KEY_B
      } as never
    ])
    expect(added).toBe(1)
    const entry = mod.trustedMints().find(m => m.server === 'mint.example')
    // a crafted backup must not be able to plant an irremovable entry or a
    // pre-staged "key change" - locks re-establish from held bearers - and
    // the pin sits out of signature verification until corroborated live
    expect(entry?.locked).toBe(false)
    expect(entry?.pendingMintPubkey).toBeUndefined()
    expect(entry?.unconfirmed).toBe(true)
  })

  it('skips invalid entries and never overwrites a known server', () => {
    mod.lockTrustedMint('mint.example', KEY_A)
    const added = mod.mergeTrustedMints([
      {server: 'mint.example', mintPubkey: KEY_B, addedAt: 2, locked: false},
      {server: 'evil.example', mintPubkey: 'zz', addedAt: 1, locked: false},
      {server: 'new.example', mintPubkey: KEY_C, addedAt: 1, locked: true}
    ] as never[])
    expect(added).toBe(1)
    expect(mod.getTrustedMintPubkey('mint.example')).toBe(KEY_A)
    expect(mod.isMintTrusted('evil.example')).toBe(false)
    // the merged entry lands unconfirmed: present in the list, but kept out
    // of signature verification until a live response advertises the key
    expect(mod.isMintTrusted('new.example')).toBe(true)
    expect(mod.getTrustedMintPubkey('new.example')).toBeNull()
  })
})

describe('unconfirmed (file-sourced) pins', () => {
  it('stays out of signature verification until corroborated live', () => {
    mod.mergeTrustedMints([
      {server: 'mint.example', mintPubkey: KEY_A, addedAt: 1, locked: false}
    ] as never[])
    expect(mod.isMintTrusted('mint.example')).toBe(true)
    expect(mod.isMintUnconfirmed('mint.example')).toBe(true)
    expect(mod.getTrustedMintPubkey('mint.example')).toBeNull()
    // a live response advertising the SAME key corroborates the pin
    expect(mod.lockTrustedMint('mint.example', KEY_A)).toBe('unchanged')
    expect(mod.isMintUnconfirmed('mint.example')).toBe(false)
    expect(mod.getTrustedMintPubkey('mint.example')).toBe(KEY_A)
  })

  it('a differing live key is staged for review, not confirmed in place', () => {
    mod.mergeTrustedMints([
      {server: 'mint.example', mintPubkey: KEY_A, addedAt: 1, locked: false}
    ] as never[])
    expect(mod.lockTrustedMint('mint.example', KEY_B)).toBe('rekey-pending')
    expect(mod.isMintUnconfirmed('mint.example')).toBe(true)
    expect(mod.getTrustedMintPubkey('mint.example')).toBeNull()
    // explicitly confirming the rekey both promotes and corroborates
    mod.confirmTrustedMintRekey('mint.example')
    expect(mod.getTrustedMintPubkey('mint.example')).toBe(KEY_B)
    expect(mod.isMintUnconfirmed('mint.example')).toBe(false)
  })

  it('a user-driven lookup (addTrustedMint) with the same key corroborates', () => {
    mod.mergeTrustedMints([
      {server: 'mint.example', mintPubkey: KEY_A, addedAt: 1, locked: false}
    ] as never[])
    expect(mod.addTrustedMint('mint.example', KEY_A)).toBe('unchanged')
    expect(mod.getTrustedMintPubkey('mint.example')).toBe(KEY_A)
  })
})

describe('grandfatherTrustedMint (unlock-time)', () => {
  it('adds unknown servers unlocked and unconfirmed', () => {
    expect(mod.grandfatherTrustedMint('mint.example', KEY_A)).toBe('added')
    const entry = mod.trustedMints().find(m => m.server === 'mint.example')
    expect(entry?.locked).toBe(false)
    expect(entry?.unconfirmed).toBe(true)
    // a storage-sourced claim never decides the "signed" badge
    expect(mod.getTrustedMintPubkey('mint.example')).toBeNull()
  })

  it('never locks or confirms an existing entry, but stages a differing claim', () => {
    mod.lockTrustedMint('mint.example', KEY_A)
    expect(mod.grandfatherTrustedMint('mint.example', KEY_A)).toBe('unchanged')
    expect(
      mod.trustedMints().find(m => m.server === 'mint.example')?.locked
    ).toBe(true)
    expect(mod.grandfatherTrustedMint('mint.example', KEY_B)).toBe(
      'rekey-pending'
    )
    expect(
      mod.trustedMints().find(m => m.server === 'mint.example')?.mintPubkey
    ).toBe(KEY_A)
  })
})

describe('removeTrustedMint', () => {
  it('removes unlocked entries but refuses locked ones', () => {
    mod.addTrustedMint('open.example', KEY_A)
    mod.lockTrustedMint('held.example', KEY_B)
    expect(() => mod.removeTrustedMint('held.example')).toThrow()
    mod.removeTrustedMint('open.example')
    expect(mod.isMintTrusted('open.example')).toBe(false)
  })
})

describe('unlockTrustedMint', () => {
  it('clears the lock so a mint with no notes left can be removed', () => {
    mod.lockTrustedMint('held.example', KEY_A)
    expect(() => mod.removeTrustedMint('held.example')).toThrow()
    mod.unlockTrustedMint('held.example')
    expect(
      mod.trustedMints().find(m => m.server === 'held.example')?.locked
    ).toBe(false)
    mod.removeTrustedMint('held.example')
    expect(mod.isMintTrusted('held.example')).toBe(false)
  })

  it('is a no-op for an already-unlocked or unknown server', () => {
    mod.addTrustedMint('open.example', KEY_A)
    mod.unlockTrustedMint('open.example') // already unlocked
    expect(
      mod.trustedMints().find(m => m.server === 'open.example')?.locked
    ).toBe(false)
    mod.unlockTrustedMint('nowhere.example') // not trusted at all
    expect(mod.trustedMints()).toHaveLength(1)
  })

  it('leaves the pinned key and other fields untouched', () => {
    mod.lockTrustedMint('held.example', KEY_A)
    mod.unlockTrustedMint('held.example')
    const entry = mod.trustedMints().find(m => m.server === 'held.example')
    expect(entry?.mintPubkey).toBe(KEY_A)
    // holding another bearer from this mint re-locks it the same as the
    // first time
    expect(mod.lockTrustedMint('held.example', KEY_A)).toBe('unchanged')
    expect(
      mod.trustedMints().find(m => m.server === 'held.example')?.locked
    ).toBe(true)
  })
})
