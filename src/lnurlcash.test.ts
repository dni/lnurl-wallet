import {describe, expect, it} from 'vitest'
import {secp256k1} from '@noble/curves/secp256k1.js'
import {sha256} from '@noble/hashes/sha2.js'
import {bytesToHex, hexToBytes, utf8ToBytes} from '@noble/hashes/utils.js'

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
  noteDeclaredAmount,
  noteSignature,
  buildNoteUrl,
  withNewK1,
  serverOf,
  verifyNoteSignature,
  isPreimage
} from './lnurlcash'

const K1 = 'a'.repeat(64)
const NOTE_URL = `https://mint.example.com/withdraw?k1=${K1}&amount=21000`

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
    expect(
      fromLud17(`lnurlw://mint.example.com/withdraw?k1=${K1}&amount=21000`)
    ).toBe(NOTE_URL)
    expect(toLud17w(NOTE_URL)).toBe(
      `lnurlw://mint.example.com/withdraw?k1=${K1}&amount=21000`
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
    expect(
      resolveLnurlInput(
        `lnurlw://mint.example.com/withdraw?k1=${K1}&amount=21000`
      )
    ).toBe(NOTE_URL)
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
  it('extracts k1, declared amount, sig and host', () => {
    expect(noteK1(NOTE_URL)).toBe(K1)
    expect(noteK1('https://mint.example.com/withdraw')).toBeNull()
    expect(noteDeclaredAmount(NOTE_URL)).toBe(21000)
    expect(
      noteDeclaredAmount('https://mint.example.com/withdraw?k1=x')
    ).toBeNull()
    expect(noteSignature(NOTE_URL)).toBeNull()
    expect(serverOf(NOTE_URL)).toBe('mint.example.com')
  })

  it('builds a note from withdrawLink + preimage + amount', () => {
    expect(buildNoteUrl('https://mint.example.com/withdraw', K1, 21000)).toBe(
      NOTE_URL
    )
    expect(
      buildNoteUrl(
        'lnurlw://mint.example.com/withdraw',
        K1.toUpperCase(),
        21000
      )
    ).toBe(NOTE_URL)
  })

  it('omits amount entirely when the value is not yet known', () => {
    // claiming a preimage that arrived from outside this wallet, with no
    // invoice request of our own to read a value from - some services
    // validate a declared amount strictly, so a placeholder like 0 risks
    // rejection where an absent param is simply ignored
    const url = buildNoteUrl('https://mint.example.com/withdraw', K1)
    expect(noteDeclaredAmount(url)).toBeNull()
    expect(new URL(url).searchParams.has('amount')).toBe(false)
  })

  it('swaps k1/amount and sets or clears sig after rotate/split/merge', () => {
    const newK1 = 'b'.repeat(64)
    const rotated = withNewK1(NOTE_URL, newK1, 15000)
    expect(noteK1(rotated)).toBe(newK1)
    expect(noteDeclaredAmount(rotated)).toBe(15000)
    expect(noteSignature(rotated)).toBeNull()

    const signed = withNewK1(NOTE_URL, newK1, 15000, 'deadbeef')
    expect(noteSignature(signed)).toBe('deadbeef')
    // rotating again without a signature drops the stale one
    const reRotated = withNewK1(signed, 'c'.repeat(64), 15000)
    expect(noteSignature(reRotated)).toBeNull()
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

describe('offline signature verification', () => {
  it('verifies a signature made over LNURLcash/note || amount || sha256(k1)', () => {
    const priv = secp256k1.utils.randomSecretKey()
    const pubHex = bytesToHex(secp256k1.getPublicKey(priv, true))

    // sign exactly the message verifyNoteSignature reconstructs, using the
    // library's 'recovered' format - empirically recovery-id-first (rec ||
    // r || s), matching the spec's byte order
    const amountMsat = 21000
    const view = new DataView(new ArrayBuffer(8))
    view.setBigUint64(0, BigInt(amountMsat), false)
    const msg = sha256(
      new Uint8Array([
        ...utf8ToBytes('LNURLcash/note'),
        ...new Uint8Array(view.buffer),
        ...sha256(hexToBytes(K1))
      ])
    )
    const sigHex = bytesToHex(secp256k1.sign(msg, priv, {format: 'recovered'}))

    expect(verifyNoteSignature(K1, amountMsat, sigHex, pubHex)).toBe(true)
    expect(verifyNoteSignature(K1, amountMsat + 1, sigHex, pubHex)).toBe(false)
    expect(
      verifyNoteSignature('b'.repeat(64), amountMsat, sigHex, pubHex)
    ).toBe(false)
    const otherPub = bytesToHex(
      secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true)
    )
    expect(verifyNoteSignature(K1, amountMsat, sigHex, otherPub)).toBe(false)
  })

  it('rejects garbage signatures without throwing', () => {
    expect(verifyNoteSignature(K1, 1000, 'not-hex', 'ab'.repeat(33))).toBe(
      false
    )
  })
})
