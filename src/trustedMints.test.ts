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
    // pre-staged "key change" - locks re-establish from held bearers
    expect(entry?.locked).toBe(false)
    expect(entry?.pendingMintPubkey).toBeUndefined()
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
    expect(mod.getTrustedMintPubkey('new.example')).toBe(KEY_C)
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
