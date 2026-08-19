import {describe, expect, it, beforeEach, vi} from 'vitest'

// devicePinning.ts reads/writes localStorage; node's test environment has
// none, so an in-memory stand-in goes in before anything touches it (same
// approach as trustedMints.test.ts).
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
import {ed25519} from '@noble/curves/ed25519.js'
import {bytesToHex} from '@noble/hashes/utils.js'

import {
  identityChallenge,
  identityMessage,
  verifyIdentity,
  judgeIdentity,
  identityWarning,
  readPinnedIdentity,
  pinIdentity,
  forgetPinnedIdentity,
  NONCE_BYTES
} from './devicePinning'

// Stand-ins for two vaults. The firmware derives its key from a stored seed
// exactly this way (src/vault/identity.c).
const seedA = new Uint8Array(32).fill(0x11)
const seedB = new Uint8Array(32).fill(0x22)
const pubkeyOf = (seed: Uint8Array) => bytesToHex(ed25519.getPublicKey(seed))
const signWith = (seed: Uint8Array, nonceHex: string) =>
  bytesToHex(ed25519.sign(identityMessage(nonceHex), seed))

const NONCE = 'a'.repeat(64)

beforeEach(() => forgetPinnedIdentity())

describe('identityChallenge', () => {
  it('is 32 bytes of hex', () => {
    expect(identityChallenge()).toMatch(
      new RegExp(`^[0-9a-f]{${NONCE_BYTES * 2}}$`)
    )
  })

  // A fixed nonce turns the whole exchange into a recording anything can
  // replay, which is the one way to get this wrong.
  it('is different every time', () => {
    const seen = new Set(Array.from({length: 20}, identityChallenge))
    expect(seen.size).toBe(20)
  })
})

describe('identityMessage', () => {
  // Must match the firmware byte for byte, or nothing verifies. Domain
  // separation is why an identity challenge can't be replayed as an OTA
  // approval.
  it('is the domain, a 0x00 separator, then the nonce', () => {
    const message = identityMessage('00ff')
    const text = new TextDecoder().decode(message.slice(0, 16))
    expect(text).toBe('lnurlvault-id-v1')
    expect(message[16]).toBe(0x00)
    expect(Array.from(message.slice(17))).toEqual([0x00, 0xff])
  })
})

describe('verifyIdentity', () => {
  it('accepts a genuine answer', () => {
    expect(
      verifyIdentity(pubkeyOf(seedA), NONCE, signWith(seedA, NONCE))
    ).toBe(true)
  })

  it('rejects another device answering', () => {
    expect(
      verifyIdentity(pubkeyOf(seedA), NONCE, signWith(seedB, NONCE))
    ).toBe(false)
  })

  // The property that makes this a challenge rather than a password.
  it('rejects an answer to a different nonce', () => {
    const old = signWith(seedA, 'b'.repeat(64))
    expect(verifyIdentity(pubkeyOf(seedA), NONCE, old)).toBe(false)
  })

  it('rejects malformed input instead of throwing', () => {
    expect(verifyIdentity('nope', NONCE, signWith(seedA, NONCE))).toBe(false)
    expect(verifyIdentity(pubkeyOf(seedA), NONCE, 'nope')).toBe(false)
    expect(verifyIdentity('', '', '')).toBe(false)
  })
})

describe('judgeIdentity', () => {
  const good = () => ({pubkey: pubkeyOf(seedA), sig: signWith(seedA, NONCE)})

  it('calls a first sighting new', () => {
    expect(judgeIdentity(good(), NONCE, null)).toEqual({
      kind: 'new',
      pubkey: pubkeyOf(seedA)
    })
  })

  it('calls the same key known', () => {
    expect(judgeIdentity(good(), NONCE, pubkeyOf(seedA)).kind).toBe('known')
  })

  // The verdict this whole file exists for.
  it('calls a different vault changed, and says what was pinned', () => {
    const verdict = judgeIdentity(good(), NONCE, pubkeyOf(seedB))
    expect(verdict).toEqual({
      kind: 'changed',
      pubkey: pubkeyOf(seedA),
      pinned: pubkeyOf(seedB)
    })
  })

  // A device that claims a pinned key but can't sign for it is worse than an
  // unknown one, and must never be waved through as 'known'.
  it('calls an unverifiable answer invalid, whatever key it claims', () => {
    const forged = {pubkey: pubkeyOf(seedA), sig: signWith(seedB, NONCE)}
    expect(judgeIdentity(forged, NONCE, pubkeyOf(seedA)).kind).toBe('invalid')
  })

  it('calls firmware with no identity unsupported, not a fault', () => {
    expect(judgeIdentity(null, NONCE, pubkeyOf(seedA)).kind).toBe('unsupported')
  })

  it('is case-insensitive about a stored key', () => {
    const verdict = judgeIdentity(good(), NONCE, pubkeyOf(seedA).toUpperCase())
    expect(verdict.kind).toBe('changed')
  })
})

describe('identityWarning', () => {
  it('warns on a changed vault without calling it an attack', () => {
    const text = identityWarning({
      kind: 'changed',
      pubkey: 'a',
      pinned: 'b'
    })!
    expect(text).toMatch(/different identity key/i)
    // A wipe destroys the key on purpose, so "this is a different vault" is
    // the honest reading and the owner is the one who knows if it should be.
    expect(text).toMatch(/wiped/i)
  })

  it('warns hard on an answer that does not check out', () => {
    expect(identityWarning({kind: 'invalid'})).toMatch(/untrusted/i)
  })

  it('says nothing for known, new or unsupported', () => {
    expect(identityWarning({kind: 'known', pubkey: 'a'})).toBeNull()
    expect(identityWarning({kind: 'new', pubkey: 'a'})).toBeNull()
    expect(identityWarning({kind: 'unsupported'})).toBeNull()
  })
})

describe('pin storage', () => {
  it('round-trips, lowercased', () => {
    pinIdentity(pubkeyOf(seedA).toUpperCase())
    expect(readPinnedIdentity()).toBe(pubkeyOf(seedA))
  })

  it('ignores a stored value that is not a key', () => {
    localStorage.setItem('lnurlvault.pinnedIdentity', 'tampered')
    expect(readPinnedIdentity()).toBeNull()
  })

  it('forgets on request', () => {
    pinIdentity(pubkeyOf(seedA))
    forgetPinnedIdentity()
    expect(readPinnedIdentity()).toBeNull()
  })
})
