import {describe, expect, it} from 'vitest'

import {
  toBech32Lnurl,
  fromBech32Lnurl,
  isBech32Lnurl,
  fromLud17,
  toLud17w,
  resolveLnurlInput,
  resolveNoteInput,
  isValidNoteInput,
  noteK1,
  buildNoteUrl,
  withNewK1,
  noteIdUrl,
  serverOf,
  isPreimage
} from './lnurlcash'

const K1 = 'a'.repeat(64)
const NOTE_URL = `https://mint.example.com/withdraw?k1=${K1}`

describe('LUD-01 bech32', () => {
  it('round-trips a note URL', () => {
    const lnurl = toBech32Lnurl(NOTE_URL)
    expect(lnurl.startsWith('LNURL1')).toBe(true)
    expect(isBech32Lnurl(lnurl)).toBe(true)
    expect(fromBech32Lnurl(lnurl)).toBe(NOTE_URL)
    expect(fromBech32Lnurl(`  ${lnurl.toLowerCase()}  `)).toBe(NOTE_URL)
  })

  it('rejects malformed input', () => {
    expect(fromBech32Lnurl('LNURL1notbech32!!!')).toBeNull()
    expect(fromBech32Lnurl('https://x')).toBeNull()
  })
})

describe('LUD-17 schemes', () => {
  it('converts lnurlw:// to fetchable https and back', () => {
    expect(fromLud17(`lnurlw://mint.example.com/withdraw?k1=${K1}`)).toBe(
      NOTE_URL
    )
    expect(toLud17w(NOTE_URL)).toBe(
      `lnurlw://mint.example.com/withdraw?k1=${K1}`
    )
  })

  it('resolves insecure hosts to http', () => {
    expect(fromLud17('lnurlw://localhost:8000/withdraw')).toBe(
      'http://localhost:8000/withdraw'
    )
  })
})

describe('input resolution', () => {
  it('resolves bech32, scheme, address and plain URLs', () => {
    expect(resolveLnurlInput(toBech32Lnurl(NOTE_URL))).toBe(NOTE_URL)
    expect(resolveLnurlInput(`lnurlw://mint.example.com/withdraw?k1=${K1}`)).toBe(NOTE_URL)
    expect(resolveLnurlInput('mint@mint.example.com')).toBe(
      'https://mint.example.com/.well-known/lnurlp/mint'
    )
    expect(resolveLnurlInput(NOTE_URL)).toBe(NOTE_URL)
    expect(resolveLnurlInput('nonsense')).toBeNull()
  })

  it('only accepts a note when a k1 is present', () => {
    expect(resolveNoteInput(toBech32Lnurl(NOTE_URL))).toBe(NOTE_URL)
    expect(resolveNoteInput('https://mint.example.com/withdraw')).toBeNull()
    expect(isValidNoteInput(NOTE_URL)).toBe(true)
    expect(isValidNoteInput('you@example.com')).toBe(false)
  })
})

describe('note helpers', () => {
  it('extracts the k1 and host', () => {
    expect(noteK1(NOTE_URL)).toBe(K1)
    expect(noteK1('https://mint.example.com/withdraw')).toBeNull()
    expect(serverOf(NOTE_URL)).toBe('mint.example.com')
  })

  it('builds a note from withdrawLink + preimage', () => {
    expect(buildNoteUrl('https://mint.example.com/withdraw', K1)).toBe(
      NOTE_URL
    )
    expect(
      buildNoteUrl('lnurlw://mint.example.com/withdraw', K1.toUpperCase())
    ).toBe(NOTE_URL)
  })

  it('swaps the secret after rotate/split/merge', () => {
    const newK1 = 'b'.repeat(64)
    expect(noteK1(withNewK1(NOTE_URL, newK1))).toBe(newK1)
  })

  it('addresses a note by sha256(k1) for informational lookups', () => {
    // sha256 over the raw bytes (all 0xaa), not the hex string - matches
    // lnurl-mint's _note_id, which for a minted note is the payment hash
    const url = noteIdUrl(NOTE_URL)!
    const id = new URL(url).searchParams.get('id')
    expect(id).toBe(
      'e0e77a507412b120f6ede61f62295b1a7b2ff19d3dcc8f7253e51663470c888e'
    )
    expect(new URL(url).searchParams.get('k1')).toBeNull()
    // undefined for non-32-byte-hex secrets
    expect(noteIdUrl('https://mint.example.com/withdraw?k1=short')).toBeNull()
  })
})

describe('preimage', () => {
  it('is 32 bytes hex', () => {
    expect(isPreimage(K1)).toBe(true)
    expect(isPreimage(` ${K1.toUpperCase()} `)).toBe(true)
    expect(isPreimage('a'.repeat(63))).toBe(false)
    expect(isPreimage('z'.repeat(64))).toBe(false)
  })
})
