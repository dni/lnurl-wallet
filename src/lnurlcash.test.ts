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
  isLightningAddress,
  resolveMintInput,
  resolveNoteInput,
  isValidNoteInput,
  noteK1,
  noteDeclaredAmount,
  noteSignature,
  buildNoteUrl,
  withNewK1,
  serverOf,
  noteEndpointOf,
  verifyNoteSignature,
  isPreimage,
  isBolt11Invoice,
  decodeBolt11AmountMsat,
  parseMintFee,
  applyMintFee,
  grossUpForMintFee,
  mintAddressUrl,
  lightningAddressUsername,
  isAllowedServiceUrl,
  sameInvoice,
  canUseMintComment,
  generateNoteSecret,
  hashK1,
  MIN_COMMENT_LENGTH_FOR_SECRET,
  type PayRequestInfo
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

describe('service URL policy', () => {
  it('admits https anywhere, http only for the insecure hosts', () => {
    expect(isAllowedServiceUrl('https://mint.example.com/w')).toBe(true)
    expect(isAllowedServiceUrl('http://localhost:8000/w')).toBe(true)
    expect(isAllowedServiceUrl('http://127.0.0.1/w')).toBe(true)
    expect(isAllowedServiceUrl('http://someservice.onion/w')).toBe(true)
    expect(isAllowedServiceUrl('http://mint.example.com/w')).toBe(false)
    // userinfo tricks: the hostname is what matters
    expect(isAllowedServiceUrl('http://evil.com@localhost/w')).toBe(true)
    expect(isAllowedServiceUrl('http://localhost@evil.com/w')).toBe(false)
    expect(isAllowedServiceUrl('data:application/json,{}')).toBe(false)
    expect(isAllowedServiceUrl('file:///etc/passwd')).toBe(false)
    expect(isAllowedServiceUrl('javascript:alert(1)')).toBe(false)
    expect(isAllowedServiceUrl('not a url')).toBe(false)
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
    // wallets hand LNURLs over behind the scheme (LUD-01); only the
    // clipboard path stripped it, so a scanned one was rejected
    expect(resolveLnurlInput(`lightning:${toBech32Lnurl(NOTE_URL)}`)).toBe(
      NOTE_URL
    )
    expect(resolveLnurlInput(`LIGHTNING:${toBech32Lnurl(NOTE_URL)}`)).toBe(
      NOTE_URL
    )
  })

  it('only accepts a note when a k1 is present', () => {
    expect(resolveNoteInput(toBech32Lnurl(NOTE_URL))).toBe(NOTE_URL)
    expect(resolveNoteInput(`lightning:${toBech32Lnurl(NOTE_URL)}`)).toBe(
      NOTE_URL
    )
    expect(resolveNoteInput('https://mint.example.com/withdraw')).toBeNull()
    expect(isValidNoteInput(NOTE_URL)).toBe(true)
    expect(isValidNoteInput('you@example.com')).toBe(false)
  })

  it('only accepts a note when its k1 is well-formed 32-byte hex', () => {
    // a non-hex k1 would crash sha256-based hashing later (offline signature
    // verification during render), so it's rejected at the door
    expect(
      resolveNoteInput('https://mint.example.com/withdraw?k1=zz')
    ).toBeNull()
    expect(
      resolveNoteInput(`https://mint.example.com/withdraw?k1=${'a'.repeat(63)}`)
    ).toBeNull()
    expect(
      isValidNoteInput(
        `https://mint.example.com/withdraw?k1=${K1.toUpperCase()}`
      )
    ).toBe(true)
  })

  it('normalizes k1 case - it is bytes, not text', () => {
    expect(noteK1(`https://mint.example.com/w?k1=${K1.toUpperCase()}`)).toBe(K1)
  })

  it('resolves insecure dev hosts to http, ports included', () => {
    expect(resolveMintInput('localhost:8000')).toBe(
      'http://localhost:8000/.well-known/lnurlp/mint'
    )
    expect(resolveMintInput('mint@127.0.0.1:8000')).toBe(
      'http://127.0.0.1:8000/.well-known/lnurlp/mint'
    )
  })

  it('resolves a dot-less dev host with a local-part - the mint picker builds one', () => {
    // Mint.tsx's quick-select prepends "mint@" to a stored server, so this
    // is the exact string clicking a trusted mint produces. It used to come
    // back null: the domain has no dot, so it was not a Lightning Address,
    // and it has an "@", so it was not a bare mint domain either. A mint
    // trusted at localhost could be typed and not clicked.
    //
    // 127.0.0.1 is why the case above never caught it - it has dots.
    expect(resolveMintInput('mint@localhost:8111')).toBe(
      'http://localhost:8111/.well-known/lnurlp/mint'
    )
    expect(resolveMintInput('mint@localhost')).toBe(
      'http://localhost/.well-known/lnurlp/mint'
    )
    // every server the picker can hold, run through the same "mint@" it
    // prepends, so none of them can regress into being unclickable
    for (const server of [
      'localhost:8111',
      '127.0.0.1:8111',
      '0.0.0.0:8111',
      'mint.example.com'
    ]) {
      expect(resolveMintInput(`mint@${server}`)).not.toBeNull()
    }
  })

  it('does not accept a dot-less domain that is not a dev host', () => {
    // the whole point of requiring a dot: a name with none cannot resolve on
    // the public internet, and an https fetch at it would go nowhere. Only
    // the hosts this wallet is allowed to reach over http are exempt.
    expect(isLightningAddress('mint@intranet')).toBe(false)
    expect(resolveMintInput('mint@intranet')).toBeNull()
    expect(isLightningAddress('mint@localhost')).toBe(true)
    // ...and the shape rules still hold
    expect(isLightningAddress('mint@')).toBe(false)
    expect(isLightningAddress('@mint.example.com')).toBe(false)
    expect(isLightningAddress('a@b@mint.example.com')).toBe(false)
    expect(isLightningAddress('mint mint@mint.example.com')).toBe(false)
    expect(isLightningAddress('mint@mint.example.com')).toBe(true)
  })

  it('rejects non-https URLs and clearnet http, even bech32-encoded', () => {
    // a data: URL would otherwise answer its own informational GET - a
    // self-contained fake "verified" note
    const fake = `data:application/json,{"tag":"withdrawRequest"}?k1=${K1}`
    expect(resolveLnurlInput(toBech32Lnurl(fake))).toBeNull()
    expect(resolveNoteInput(toBech32Lnurl(fake))).toBeNull()
    expect(resolveMintInput(toBech32Lnurl(fake))).toBeNull()
    // cleartext http is for the deliberate insecure dev hosts only
    expect(
      resolveLnurlInput(`http://mint.example.com/withdraw?k1=${K1}`)
    ).toBeNull()
    expect(
      resolveLnurlInput(
        toBech32Lnurl(`http://mint.example.com/withdraw?k1=${K1}`)
      )
    ).toBeNull()
    expect(resolveLnurlInput(`http://localhost:8000/withdraw?k1=${K1}`)).toBe(
      `http://localhost:8000/withdraw?k1=${K1}`
    )
    expect(
      resolveLnurlInput(
        toBech32Lnurl(`http://localhost:8000/withdraw?k1=${K1}`)
      )
    ).toBe(`http://localhost:8000/withdraw?k1=${K1}`)
    // a LUD-17 authority that only prefix-matches an insecure host must not
    // downgrade: localhost:80@evil.com's real host is evil.com
    expect(
      resolveLnurlInput(`lnurlw://localhost:80@evil.com/withdraw?k1=${K1}`)
    ).toBeNull()
    expect(
      resolveLnurlInput(toBech32Lnurl(`file:///etc/passwd?k1=${K1}`))
    ).toBeNull()
  })

  it('mirrors a resolved payRequest URL onto its withdraw-side mint address', () => {
    // derived from the resolved URL's own path, not the raw input - works
    // identically whether that URL came from a Lightning Address...
    expect(mintAddressUrl(resolveLnurlInput('mint@mint.example.com')!)).toBe(
      'https://mint.example.com/.well-known/lnurlw/mint'
    )
    // ...or a bare URL that already happens to follow the same convention
    expect(
      mintAddressUrl('https://mint.example.com/.well-known/lnurlp/mint')
    ).toBe('https://mint.example.com/.well-known/lnurlw/mint')
    // only a URL at that conventional path has an "other side" to mirror
    expect(mintAddressUrl(NOTE_URL)).toBeNull()
    expect(mintAddressUrl('https://mint.example.com/pay')).toBeNull()
    expect(mintAddressUrl('nonsense')).toBeNull()
  })

  it('extracts a payRequest URL username, cacheable onto TrustedMint', () => {
    expect(
      lightningAddressUsername(resolveLnurlInput('mint@mint.example.com')!)
    ).toBe('mint')
    expect(
      lightningAddressUsername(
        'https://mint.example.com/.well-known/lnurlp/mint'
      )
    ).toBe('mint')
    expect(lightningAddressUsername(NOTE_URL)).toBeNull()
    expect(lightningAddressUsername('nonsense')).toBeNull()
  })

  it('resolves a bare mint domain to the default mint@<domain> address', () => {
    // literally bare...
    expect(resolveMintInput('mint.example.com')).toBe(
      'https://mint.example.com/.well-known/lnurlp/mint'
    )
    // ...or with the leading "@" some mints display their own address as
    // (see PUBLIC_MINTS) - both are shorthand for the same address
    expect(resolveMintInput('@mint.example.com')).toBe(
      'https://mint.example.com/.well-known/lnurlp/mint'
    )
    // an actual Lightning Address still takes precedence - not reinterpreted
    // as a bare domain missing its "@"
    expect(resolveMintInput('mint@mint.example.com')).toBe(
      'https://mint.example.com/.well-known/lnurlp/mint'
    )
    // a scheme or path disqualifies it as "bare" - resolveMintInput has no
    // guess for those, same as before this existed
    expect(resolveMintInput('https://mint.example.com')).toBeNull()
    expect(resolveMintInput('mint.example.com/p')).toBeNull()
    expect(resolveMintInput('nonsense')).toBeNull()
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

  it('keeps the path when naming the endpoint a note is rebuilt from', () => {
    // LUD-25: "lnurlw://mint.example/w?k1=<P>&amount=<msat> *is* the bearer
    // note". Drop the /w and there is nothing left to GET. serverOf is for
    // display and does drop it, which is why these are separate functions.
    expect(noteEndpointOf('lnurlw://mint.example/w')).toBe('mint.example/w')
    expect(noteEndpointOf('https://mint.example/w')).toBe('mint.example/w')
    expect(noteEndpointOf(NOTE_URL)).toBe('mint.example.com/withdraw')
    expect(noteEndpointOf('lnurlw://localhost:8000/w')).toBe('localhost:8000/w')
    // a deeper path is not special-cased away either
    expect(noteEndpointOf('https://mint.example/lnurl/w')).toBe(
      'mint.example/lnurl/w'
    )
    // a root endpoint contributes no segment, so the note is host?k1=...
    expect(noteEndpointOf('https://mint.example/')).toBe('mint.example')
    expect(noteEndpointOf('https://mint.example')).toBe('mint.example')
    // and it is never the bare host for a path-bearing endpoint
    expect(noteEndpointOf('https://mint.example/w')).not.toBe('mint.example')
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

describe('bolt11 invoice', () => {
  it('compares invoices case-insensitively (bech32)', () => {
    expect(sameInvoice('  LNBC21N1ABC  ', 'lnbc21n1abc')).toBe(true)
    expect(sameInvoice('lnbc21n1abc', 'lnbc21n1abd')).toBe(false)
  })

  it('recognizes mainnet/testnet/regtest prefixes with and without an amount', () => {
    expect(isBolt11Invoice('lnbc1p0examplebech32data')).toBe(true)
    expect(isBolt11Invoice('lnbc210n1p0examplebech32data')).toBe(true)
    expect(isBolt11Invoice('lntb1p0examplebech32data')).toBe(true)
    expect(isBolt11Invoice('lnbcrt1p0examplebech32data')).toBe(true)
    expect(isBolt11Invoice(`  ${'LNBC1P0EXAMPLEBECH32DATA'}  `)).toBe(true)
  })

  it('rejects LNURLs and unrelated strings despite the ln prefix', () => {
    expect(isBolt11Invoice(toBech32Lnurl(NOTE_URL))).toBe(false)
    expect(isBolt11Invoice('not an invoice')).toBe(false)
    expect(isBolt11Invoice('')).toBe(false)
  })

  it('decodes the amount from each multiplier, and null without one', () => {
    // '1' never appears in bech32 data (it's the reserved separator), so
    // these use only charset-safe filler after the real separator
    expect(decodeBolt11AmountMsat('lnbc1u1p0examplebech32data')).toBe(100_000)
    expect(decodeBolt11AmountMsat('lnbc10m1p0examplebech32data')).toBe(
      1_000_000_000
    )
    expect(decodeBolt11AmountMsat('lnbc250n1p0examplebech32data')).toBe(25_000)
    expect(decodeBolt11AmountMsat('lnbc10p1p0examplebech32data')).toBe(1)
    // digits with no multiplier suffix means whole BTC
    expect(decodeBolt11AmountMsat('lnbc11p0examplebech32data')).toBe(
      100_000_000_000
    )
    // network prefix runs straight into the separator - no amount at all
    expect(decodeBolt11AmountMsat('lnbc1p0examplebech32data')).toBeNull()
    expect(decodeBolt11AmountMsat('lntb1p0examplenoamount')).toBeNull()
    expect(decodeBolt11AmountMsat('not an invoice')).toBeNull()
  })
})

describe('LUD-25 mint fees', () => {
  it('parses the flat and ppm components from a metadata entry', () => {
    const metadata = JSON.stringify([
      ['text/plain', 'a mint'],
      ['text/plain', 'Mint fees: 1000,2000']
    ])
    expect(parseMintFee(metadata)).toEqual({baseFeeMsat: 1000, feePpm: 2000})
  })

  it('is null for metadata with no fee entry, or invalid JSON', () => {
    expect(parseMintFee(JSON.stringify([['text/plain', 'a mint']]))).toBeNull()
    expect(parseMintFee('not json')).toBeNull()
    expect(parseMintFee('{}')).toBeNull()
  })

  it('treats an explicit 0,0 fee the same as no fee entry at all', () => {
    const metadata = JSON.stringify([['text/plain', 'Mint fees: 0,0']])
    expect(parseMintFee(metadata)).toBeNull()
  })

  it('still parses a fee with only one of the two components set', () => {
    expect(
      parseMintFee(JSON.stringify([['text/plain', 'Mint fees: 1000,0']]))
    ).toEqual({baseFeeMsat: 1000, feePpm: 0})
    expect(
      parseMintFee(JSON.stringify([['text/plain', 'Mint fees: 0,2000']]))
    ).toEqual({baseFeeMsat: 0, feePpm: 2000})
  })

  it('applies a flat fee plus a percentage of the gross amount', () => {
    const fee = {baseFeeMsat: 1000, feePpm: 2000} // 1 sat + 0.2%
    expect(applyMintFee(100_000, fee)).toBe(100_000 - 1000 - 200)
    expect(applyMintFee(0, fee)).toBe(0) // never goes negative
  })

  it('grosses up so the net amount survives the fee exactly', () => {
    const fees = [
      {baseFeeMsat: 1000, feePpm: 2000},
      {baseFeeMsat: 0, feePpm: 500_000}, // 50%, no flat component
      {baseFeeMsat: 5000, feePpm: 0}, // flat-only, no percentage
      {baseFeeMsat: 0, feePpm: 0} // no fee at all - gross-up is a no-op
    ]
    for (const fee of fees) {
      for (const net of [1, 1000, 21_000, 1_000_000]) {
        const gross = grossUpForMintFee(net, fee)
        expect(applyMintFee(gross, fee)).toBe(net)
        // and it's the *smallest* such gross - anything above it is the
        // payer handing the mint a larger fee for no extra value
        expect(applyMintFee(gross - 1, fee)).toBeLessThan(net)
      }
    }
    // the no-fee case specifically shouldn't inflate the amount at all
    expect(grossUpForMintFee(21_000, {baseFeeMsat: 0, feePpm: 0})).toBe(21_000)
  })

  it('rejects a >= 100% fee outright instead of hanging the gross-up walk', () => {
    // applyMintFee floors at 0 for these, so grossUpForMintFee's walk would
    // never reach a positive target - a hostile mint could freeze the page
    expect(
      parseMintFee(JSON.stringify([['text/plain', 'Mint fees: 0,1000000']]))
    ).toBeNull()
    expect(
      parseMintFee(JSON.stringify([['text/plain', 'Mint fees: 0,10000000']]))
    ).toBeNull()
    // just under the boundary still parses and grosses up fine
    const fee = {baseFeeMsat: 0, feePpm: 999_999}
    expect(
      parseMintFee(JSON.stringify([['text/plain', 'Mint fees: 0,999999']]))
    ).toEqual(fee)
    expect(applyMintFee(grossUpForMintFee(1000, fee), fee)).toBe(1000)
  })
})

describe('LUD-12 comment protection (LUD-25 preimage-race mitigation)', () => {
  const payInfo = (commentAllowed?: number): PayRequestInfo => ({
    tag: 'payRequest',
    callback: 'https://mint.example.com/pay/cb',
    minSendable: 1000,
    maxSendable: 100_000_000,
    metadata: '[]',
    withdrawLink: 'https://mint.example.com/w',
    commentAllowed
  })

  it('requires commentAllowed to fit a hex-encoded 32-byte hash', () => {
    expect(MIN_COMMENT_LENGTH_FOR_SECRET).toBe(64)
    expect(canUseMintComment(payInfo(64))).toBe(true)
    expect(canUseMintComment(payInfo(128))).toBe(true)
    expect(canUseMintComment(payInfo(63))).toBe(false)
    expect(canUseMintComment(payInfo(0))).toBe(false)
    expect(canUseMintComment(payInfo(undefined))).toBe(false)
  })

  it('ignores a malformed commentAllowed rather than trusting it', () => {
    expect(canUseMintComment({...payInfo(), commentAllowed: '64' as any})).toBe(
      false
    )
  })

  it('generateNoteSecret + hashK1 produce exactly a 64-char hex comment', () => {
    const secret = generateNoteSecret()
    expect(isPreimage(secret)).toBe(true)
    const comment = hashK1(secret)
    expect(comment).toMatch(/^[0-9a-f]{64}$/)
    expect(comment.length).toBe(MIN_COMMENT_LENGTH_FOR_SECRET)
    // deterministic - SERVICE must be able to key its note by the same
    // hash WALLET discloses up front
    expect(hashK1(secret)).toBe(comment)
  })
})

describe('LUD-25 mint fee arithmetic at the edges', () => {
  // the fee is SERVICE's to choose, so both of these are reachable on
  // purpose by a mint that wants them to be
  it('grosses up minimally even at a fee just under 100%', () => {
    const fee = {baseFeeMsat: 3, feePpm: 999_999}
    const gross = grossUpForMintFee(1, fee)
    expect(gross).toBe(3_000_001)
    expect(applyMintFee(gross, fee)).toBe(1)
    expect(applyMintFee(gross - 1, fee)).toBe(0)
  })

  it('is minimal across a sweep of hostile fees, not just near ones', () => {
    for (const feePpm of [1, 999, 500_000, 990_000, 999_000, 999_999]) {
      for (const baseFeeMsat of [0, 1, 3, 1000]) {
        const fee = {baseFeeMsat, feePpm}
        for (const net of [1, 2, 999, 21_000, 1_000_000]) {
          const gross = grossUpForMintFee(net, fee)
          expect(applyMintFee(gross, fee)).toBeGreaterThanOrEqual(net)
          expect(applyMintFee(gross - 1, fee)).toBeLessThan(net)
        }
      }
    }
  })

  it('takes no fee off a zero amount, and grosses zero up to zero', () => {
    const fee = {baseFeeMsat: 1000, feePpm: 2000}
    expect(applyMintFee(0, fee)).toBe(0)
    expect(grossUpForMintFee(0, fee)).toBe(0)
  })

  it('keeps the proportional cut exact past 2^53', () => {
    // gross * ppm leaves the safe-integer range around 100 BTC at a
    // realistic ppm, and a rounded product floors to the wrong msat.
    // BigInt is the oracle - it does the same arithmetic without losing
    // anything
    const exact = (gross: bigint, base: bigint, ppm: bigint): bigint => {
      const net = gross - base - (gross * ppm) / 1_000_000n
      return net < 0n ? 0n : net
    }
    const amounts = [
      9_990_000_000_000, // ~99.9 BTC
      12_345_678_901_234,
      100_000_000_000_000, // 1000 BTC
      2_100_000_000_000_000 // the whole supply, in msat
    ]
    for (const gross of amounts) {
      for (const feePpm of [1, 999, 100_000, 999_999]) {
        const fee = {baseFeeMsat: 0, feePpm}
        expect(applyMintFee(gross, fee)).toBe(
          Number(exact(BigInt(gross), 0n, BigInt(feePpm)))
        )
      }
    }
  })

  it('grosses up minimally at those amounts too', () => {
    const fee = {baseFeeMsat: 1000, feePpm: 100_000}
    for (const net of [9_990_000_000_000, 100_000_000_000_000]) {
      const gross = grossUpForMintFee(net, fee)
      expect(applyMintFee(gross, fee)).toBe(net)
      expect(applyMintFee(gross - 1, fee)).toBeLessThan(net)
    }
  })
})

describe('offline signature verification', () => {
  // signed the same way LUD-13 signs its auth seed phrase - the standard
  // Lightning `signmessage` double-sha256 wrapping, over a message that
  // embeds the amount as decimal ASCII (not binary) and sha256(k1) as hex
  // (not raw bytes)
  const signAsMint = (
    priv: Uint8Array,
    k1: string,
    amountMsat: number
  ): string => {
    const k1Hash = bytesToHex(sha256(hexToBytes(k1)))
    const message = utf8ToBytes(`LNURLcash:${amountMsat}:${k1Hash}`)
    const digest = sha256(
      sha256(
        new Uint8Array([
          ...utf8ToBytes('Lightning Signed Message:'),
          ...message
        ])
      )
    )
    // library's 'recovered' format is empirically recovery-id-first (rec ||
    // r || s) - the spec's wire format is r || s || recovery-id, so reorder.
    // prehash:false: `digest` is already the final hash a real signer
    // (lnd/cln's signmessage) signs directly - the default prehash:true
    // would hash it again, producing a signature nothing downstream (this
    // wallet's own verifyNoteSignature, or a real mint) could ever recover
    // against a real signer's key
    const libSig = secp256k1.sign(digest, priv, {
      format: 'recovered',
      prehash: false
    })
    return bytesToHex(new Uint8Array([...libSig.subarray(1), libSig[0]]))
  }

  it('verifies a signature made per the LUD-25 Lightning-signmessage scheme', () => {
    const priv = secp256k1.utils.randomSecretKey()
    const pubHex = bytesToHex(secp256k1.getPublicKey(priv, true))
    const amountMsat = 21000
    const sigHex = signAsMint(priv, K1, amountMsat)

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

  it('also verifies the recovery-id-leading layout some mints still send', () => {
    // lnurl-mint used to forward its Lightning node's signmessage RPC
    // output unreordered (recovery-id || r || s) rather than the spec
    // text's r || s || recovery-id, and has since fixed that - kept here
    // as a real-world-interop regression guard in case another
    // implementation (or a not-yet-updated lnurl-mint) gets it wrong
    const priv = secp256k1.utils.randomSecretKey()
    const pubHex = bytesToHex(secp256k1.getPublicKey(priv, true))
    const amountMsat = 6000
    const k1Hash = bytesToHex(sha256(hexToBytes(K1)))
    const message = utf8ToBytes(`LNURLcash:${amountMsat}:${k1Hash}`)
    const digest = sha256(
      sha256(
        new Uint8Array([
          ...utf8ToBytes('Lightning Signed Message:'),
          ...message
        ])
      )
    )
    const leadingSigHex = bytesToHex(
      secp256k1.sign(digest, priv, {format: 'recovered', prehash: false})
    )
    expect(verifyNoteSignature(K1, amountMsat, leadingSigHex, pubHex)).toBe(
      true
    )
  })

  it('rejects garbage signatures without throwing', () => {
    expect(verifyNoteSignature(K1, 1000, 'not-hex', 'ab'.repeat(33))).toBe(
      false
    )
    // wrong length (not 65 bytes)
    expect(
      verifyNoteSignature(K1, 1000, 'ab'.repeat(10), 'ab'.repeat(33))
    ).toBe(false)
  })

  it('rejects a malformed k1 without throwing', () => {
    // a stored note with a non-hex k1 must not crash the digest - "not
    // signed", never an exception escaping into render
    const priv = secp256k1.utils.randomSecretKey()
    const pubHex = bytesToHex(secp256k1.getPublicKey(priv, true))
    const sigHex = signAsMint(priv, K1, 1000)
    expect(verifyNoteSignature('zz', 1000, sigHex, pubHex)).toBe(false)
    expect(verifyNoteSignature('a'.repeat(63), 1000, sigHex, pubHex)).toBe(
      false
    )
  })
})
