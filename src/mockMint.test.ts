import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {sha256} from '@noble/hashes/sha2.js'
import {bytesToHex, hexToBytes} from '@noble/hashes/utils.js'

import {
  fetchPayRequest,
  requestInvoice,
  fetchInvoiceVerification,
  buildNoteUrl,
  fetchNoteInfo,
  fetchMintAddress,
  rotateNote,
  splitNote,
  mergeNotes,
  meltNote,
  settleNote,
  toBech32Lnurl,
  PendingNoteError,
  NoteSpentError,
  NoteUnknownError
} from './lnurlcash'
import {receiveNote} from './receive'

// Exercises the stateful multi-step flows Mint.tsx/Melt.tsx/SendDialog.tsx
// drive (mint -> rotate -> split -> merge -> melt, pending-note recovery,
// rotation-on-failure) against an in-memory mock of a LUD-25 SERVICE, so
// they're covered without a live lnurl-mint process (see integration.test.ts
// for that, opt-in via MINT_K1) and without rendering the SolidJS pages
// themselves (no component-testing setup in this repo yet). This drives the
// exact exported functions those pages call - only the fetch() layer is
// faked.

const BASE = 'https://mock-mint.test'
const PAY_URL = `${BASE}/pay`
const PAY_CALLBACK = `${BASE}/pay/cb`
const WITHDRAW_URL = `${BASE}/w`
const WITHDRAW_CALLBACK = `${BASE}/w/cb`
const MINT_ADDRESS_URL = `${BASE}/mintaddress`
const MINT_ADDRESS_BAD_URL = `${BASE}/mintaddress-bad`
const MINT_ADDRESS_UNKNOWN_URL = `${BASE}/mintaddress-unknown`

const randomHex = (bytes: number): string =>
  bytesToHex(crypto.getRandomValues(new Uint8Array(bytes)))

// same digest lnurlcash.ts's own hashK1 uses - k1 is hex bytes, hashed raw
const hashK1 = (k1: string): string => bytesToHex(sha256(hexToBytes(k1)))

const idFromVerifyUrl = (url: string): string => url.split('/').pop()!

type Note = {amountMsat: number; pending: boolean}
type Invoice = {amountMsat: number; preimage: string; settled: boolean}
type Melt = {noteHash: string; settled: boolean}

// A minimal in-memory LUD-25 SERVICE: just enough of LUD-03/06/17/21/25 to
// drive this wallet's own protocol orchestration. Notes are keyed by
// sha256(k1) throughout, exactly as a real SERVICE must - it never learns
// the raw secret of a rotated/split/merged note, only the hash the wallet
// discloses as h/h2.
class MockMint {
  private notes = new Map<string, Note>()
  // hashes of notes once outstanding but since burned (rotate/split/merge
  // input, or a settled melt) - kept around, like the real lnurl-mint keeps
  // spent=1 rows rather than deleting them, so GET /w can tell "this was
  // spent" apart from "this was never a note at all"
  private spent = new Set<string>()
  private invoices = new Map<string, Invoice>()
  private melts = new Map<string, Melt>()
  private invoiceCounter = 0
  private meltCounter = 0
  // when set, every rotate request fails without touching state - models a
  // transient SERVICE hiccup to exercise the wallet's rotate-and-fall-back
  // path (see settleNote)
  rotateFails = false

  seed(k1: string, amountMsat: number): void {
    this.notes.set(hashK1(k1), {amountMsat, pending: false})
  }

  isOutstanding(k1: string): boolean {
    return this.notes.has(hashK1(k1))
  }

  // simulates the wallet's own Lightning node paying an invoice this mock
  // issued: settles it and credits the preimage as an outstanding note,
  // per LUD-25's minting flow
  settleInvoice(invoiceId: string): void {
    const invoice = this.invoices.get(invoiceId)
    if (!invoice) throw new Error('no such invoice')
    invoice.settled = true
    this.notes.set(hashK1(invoice.preimage), {
      amountMsat: invoice.amountMsat,
      pending: false
    })
  }

  // simulates the outgoing payment behind a melt settling for good
  settleMelt(meltId: string): void {
    const melt = this.melts.get(meltId)
    if (!melt) throw new Error('no such melt')
    melt.settled = true
    this.spent.add(melt.noteHash)
    this.notes.delete(melt.noteHash)
  }

  // simulates that outgoing payment failing - per spec, the note is
  // restored to outstanding exactly as before the attempt
  failMelt(meltId: string): void {
    const melt = this.melts.get(meltId)
    if (!melt) throw new Error('no such melt')
    const note = this.notes.get(melt.noteHash)
    if (note) note.pending = false
  }

  private respond(body: object): Promise<Response> {
    return Promise.resolve({json: async () => body} as unknown as Response)
  }

  private error(reason: string): Promise<Response> {
    return this.respond({status: 'ERROR', reason})
  }

  private ok(body: object = {}): Promise<Response> {
    return this.respond({status: 'OK', ...body})
  }

  fetch = async (input: string | URL): Promise<Response> => {
    const url = new URL(input.toString())
    const params = url.searchParams

    if (url.pathname === '/pay') {
      return this.respond({
        tag: 'payRequest',
        callback: PAY_CALLBACK,
        minSendable: 1000,
        maxSendable: 100_000_000,
        metadata: JSON.stringify([['text/plain', 'mock mint']]),
        withdrawLink: WITHDRAW_URL
      })
    }

    if (url.pathname === '/pay/cb') {
      const amountMsat = Number(params.get('amount'))
      const id = String(this.invoiceCounter++)
      this.invoices.set(id, {
        amountMsat,
        preimage: randomHex(32),
        settled: false
      })
      return this.respond({
        pr: `lnbcmock${id}`,
        verify: `${BASE}/verify/pay/${id}`,
        disposable: true
      })
    }

    // LUD-25 mint address (experimental) - the withdraw-side discovery
    // response fetchMintAddress parses (see lnurlcash.ts)
    if (url.pathname === '/mintaddress') {
      return this.respond({
        tag: 'withdrawRequest',
        callback: WITHDRAW_URL,
        minWithdrawable: 1000,
        maxWithdrawable: 100_000_000,
        payLink: PAY_URL,
        mintPubkey: 'deadbeef',
        nodeAlias: 'mock node',
        nodeUri: 'deadbeef@127.0.0.1:9735',
        nodeColor: '#3399ff',
        nodeCapacityMsat: 750_000_000,
        nodeNumChannels: 3,
        nodeNumPeers: 5
      })
    }
    if (url.pathname === '/mintaddress-bad') {
      // missing payLink/maxWithdrawable - not a well-formed mint address
      return this.respond({tag: 'withdrawRequest', callback: WITHDRAW_URL})
    }
    if (url.pathname === '/mintaddress-unknown') {
      return this.error('Unknown user.')
    }

    const payVerify = url.pathname.match(/^\/verify\/pay\/(.+)$/)
    if (payVerify) {
      const invoice = this.invoices.get(payVerify[1])
      if (!invoice) return this.error('unknown invoice')
      return this.respond({
        settled: invoice.settled,
        preimage: invoice.settled ? invoice.preimage : null,
        pr: `lnbcmock${payVerify[1]}`
      })
    }

    const meltVerify = url.pathname.match(/^\/verify\/melt\/(.+)$/)
    if (meltVerify) {
      const melt = this.melts.get(meltVerify[1])
      if (!melt) return this.error('unknown melt')
      return this.respond({
        settled: melt.settled,
        preimage: null,
        pr: 'lnbcmockmelt'
      })
    }

    if (url.pathname === '/w') {
      const k1 = params.get('k1')
      if (!k1) return this.error('missing k1')
      const hash = hashK1(k1)
      const note = this.notes.get(hash)
      if (!note) {
        return this.error(
          this.spent.has(hash) ? 'Note already spent.' : 'Unknown note.'
        )
      }
      return this.respond({
        tag: 'withdrawRequest',
        callback: WITHDRAW_CALLBACK,
        k1,
        minWithdrawable: note.amountMsat,
        maxWithdrawable: note.amountMsat
      })
    }

    if (url.pathname === '/w/cb') {
      const k1s = params.getAll('k1')
      const pr = params.get('pr')
      const amount = params.get('amount')
      const h = params.get('h')
      const h2 = params.get('h2')

      if (k1s.length === 0) return this.error('missing k1')
      const hashes = k1s.map(hashK1)
      const notes = hashes.map(hash => this.notes.get(hash))
      if (notes.some(n => !n)) return this.error('not found')
      if (notes.some(n => n!.pending)) return this.error('pending')

      // melt: LUD-03 semantics untouched - single k1, pr, no h
      if (pr && k1s.length === 1 && !h) {
        const hash = hashes[0]
        this.notes.get(hash)!.pending = true
        const meltId = String(this.meltCounter++)
        this.melts.set(meltId, {noteHash: hash, settled: false})
        return this.ok({pr, verify: `${BASE}/verify/melt/${meltId}`})
      }

      // rotate: single k1, h only
      if (h && !h2 && !amount && !pr && k1s.length === 1) {
        if (this.rotateFails) return this.error('simulated failure')
        const total = notes.reduce((sum, n) => sum + n!.amountMsat, 0)
        for (const hash of hashes) {
          this.spent.add(hash)
          this.notes.delete(hash)
        }
        this.notes.set(h, {amountMsat: total, pending: false})
        return this.ok()
      }

      // split: one or many k1s, amount + h + h2, no pr (LUD-25)
      if (amount && h && h2 && !pr) {
        const target = Number(amount)
        const total = notes.reduce((sum, n) => sum + n!.amountMsat, 0)
        const change = total - target
        if (change < 0) return this.error('insufficient value')
        for (const hash of hashes) {
          this.spent.add(hash)
          this.notes.delete(hash)
        }
        this.notes.set(h, {amountMsat: target, pending: false})
        this.notes.set(h2, {amountMsat: change, pending: false})
        return this.ok()
      }

      // merge: many k1s, h only, no amount/pr
      if (h && !h2 && !amount && !pr && k1s.length > 1) {
        const total = notes.reduce((sum, n) => sum + n!.amountMsat, 0)
        for (const hash of hashes) {
          this.spent.add(hash)
          this.notes.delete(hash)
        }
        this.notes.set(h, {amountMsat: total, pending: false})
        return this.ok()
      }

      return this.error('bad request')
    }

    return this.error('not found')
  }
}

let mint: MockMint

beforeEach(() => {
  mint = new MockMint()
  vi.stubGlobal('fetch', mint.fetch as unknown as typeof fetch)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('LUD-25 mint address (experimental)', () => {
  it('parses node identity/capacity and mint limits', async () => {
    const info = await fetchMintAddress(MINT_ADDRESS_URL)
    expect(info.tag).toBe('withdrawRequest')
    expect(info.payLink).toBe(PAY_URL)
    expect(info.callback).toBe(WITHDRAW_URL)
    expect(info.minWithdrawable).toBe(1000)
    expect(info.maxWithdrawable).toBe(100_000_000)
    // the wire field is still `mintPubkey` (mocked above) - fetchMintAddress
    // renames it to nodePubkey (see MintAddressInfo)
    expect(info.nodePubkey).toBe('deadbeef')
    expect(info.nodeAlias).toBe('mock node')
    expect(info.nodeUri).toBe('deadbeef@127.0.0.1:9735')
    expect(info.nodeColor).toBe('#3399ff')
    expect(info.nodeCapacityMsat).toBe(750_000_000)
    expect(info.nodeNumChannels).toBe(3)
    expect(info.nodeNumPeers).toBe(5)
  })

  it('rejects a response missing payLink/maxWithdrawable', async () => {
    await expect(fetchMintAddress(MINT_ADDRESS_BAD_URL)).rejects.toThrow(
      'Not a mint address response'
    )
  })

  it('surfaces the service error for an unknown username', async () => {
    await expect(fetchMintAddress(MINT_ADDRESS_UNKNOWN_URL)).rejects.toThrow(
      'Unknown user.'
    )
  })
})

describe('mint -> rotate -> split -> merge -> melt', () => {
  it('carries one note through the full LUD-25 lifecycle', async () => {
    const payInfo = await fetchPayRequest(PAY_URL)
    expect(payInfo.withdrawLink).toBe(WITHDRAW_URL)

    const invoice = await requestInvoice(payInfo.callback, 21000)
    expect(invoice.verify).toBeDefined()
    expect((await fetchInvoiceVerification(invoice.verify!)).settled).toBe(
      false
    )

    mint.settleInvoice(idFromVerifyUrl(invoice.verify!))
    const verification = await fetchInvoiceVerification(invoice.verify!)
    expect(verification.settled).toBe(true)
    const preimage = verification.preimage!

    // claim: informational GET settles the note's authoritative value
    const noteUrl = buildNoteUrl(payInfo.withdrawLink!, preimage, 21000)
    const info = await fetchNoteInfo(noteUrl)
    expect(info.maxWithdrawable).toBe(21000)
    expect(info.k1).toBe(preimage)

    // rotate: the preimage was just on the wire (that GET), so it's burned
    // in favor of a fresh, wallet-only secret
    const rotated = await rotateNote(info.callback, preimage)
    expect(rotated.k1).not.toBe(preimage)
    expect(mint.isOutstanding(preimage)).toBe(false)
    expect(mint.isOutstanding(rotated.k1)).toBe(true)
    await expect(fetchNoteInfo(noteUrl)).rejects.toBeInstanceOf(NoteSpentError)
    await expect(fetchNoteInfo(noteUrl)).rejects.toThrow(/spent/i)

    // split: one k1, one piece + change (LUD-25 also allows many at once,
    // covered by the "one or many k1s" test below)
    const parts = await splitNote(info.callback, [rotated.k1], 6000)
    expect(mint.isOutstanding(rotated.k1)).toBe(false)
    expect(mint.isOutstanding(parts.k1)).toBe(true)
    expect(mint.isOutstanding(parts.change)).toBe(true)
    const partInfo = await fetchNoteInfo(
      buildNoteUrl(WITHDRAW_URL, parts.k1, 6000)
    )
    const changeInfo = await fetchNoteInfo(
      buildNoteUrl(WITHDRAW_URL, parts.change, 15000)
    )
    expect(partInfo.maxWithdrawable).toBe(6000)
    expect(changeInfo.maxWithdrawable).toBe(15000)

    // merge: back into one 21-sat note
    const merged = await mergeNotes(info.callback, [parts.k1, parts.change])
    expect(mint.isOutstanding(parts.k1)).toBe(false)
    expect(mint.isOutstanding(parts.change)).toBe(false)
    const mergedInfo = await fetchNoteInfo(
      buildNoteUrl(WITHDRAW_URL, merged.k1, 21000)
    )
    expect(mergedInfo.maxWithdrawable).toBe(21000)

    // melt: {"status":"OK"} only means the payment is in flight - the note
    // is neither burned nor spendable elsewhere until it settles
    const meltResult = await meltNote(info.callback, merged.k1, 'lnbcmockpay')
    expect(meltResult.verify).toBeDefined()
    expect(mint.isOutstanding(merged.k1)).toBe(true)
    await expect(rotateNote(info.callback, merged.k1)).rejects.toBeInstanceOf(
      PendingNoteError
    )

    mint.settleMelt(idFromVerifyUrl(meltResult.verify!))
    expect((await fetchInvoiceVerification(meltResult.verify!)).settled).toBe(
      true
    )
    expect(mint.isOutstanding(merged.k1)).toBe(false)
    await expect(
      fetchNoteInfo(buildNoteUrl(WITHDRAW_URL, merged.k1, 21000))
    ).rejects.toThrow(/spent/i)
  })

  it('splits one or many k1s in a single request (LUD-25)', async () => {
    const a = randomHex(32)
    const b = randomHex(32)
    mint.seed(a, 10000)
    mint.seed(b, 5000)

    const parts = await splitNote(WITHDRAW_CALLBACK, [a, b], 9000)
    expect(mint.isOutstanding(a)).toBe(false)
    expect(mint.isOutstanding(b)).toBe(false)
    expect(
      (await fetchNoteInfo(buildNoteUrl(WITHDRAW_URL, parts.k1, 9000)))
        .maxWithdrawable
    ).toBe(9000)
    expect(
      (await fetchNoteInfo(buildNoteUrl(WITHDRAW_URL, parts.change, 6000)))
        .maxWithdrawable
    ).toBe(6000)
  })
})

describe('pending-note recovery', () => {
  it('rejects every other op on a k1 mid-melt, then finalizes on settlement', async () => {
    const k1 = randomHex(32)
    mint.seed(k1, 10000)

    const melt = await meltNote(WITHDRAW_CALLBACK, k1, 'lnbcmockpay')

    // any other mutating op on the same k1 is rejected while it's pending -
    // per spec, regardless of which operation is attempted
    await expect(rotateNote(WITHDRAW_CALLBACK, k1)).rejects.toBeInstanceOf(
      PendingNoteError
    )
    await expect(
      splitNote(WITHDRAW_CALLBACK, [k1], 5000)
    ).rejects.toBeInstanceOf(PendingNoteError)

    // the informational GET is unaffected - only callback mutations are
    // blocked while pending
    expect(
      (await fetchNoteInfo(buildNoteUrl(WITHDRAW_URL, k1, 10000)))
        .maxWithdrawable
    ).toBe(10000)

    mint.settleMelt(idFromVerifyUrl(melt.verify!))
    await expect(
      fetchNoteInfo(buildNoteUrl(WITHDRAW_URL, k1, 10000))
    ).rejects.toThrow(/spent/i)
  })

  it('restores the note to outstanding if the outgoing payment fails', async () => {
    const k1 = randomHex(32)
    mint.seed(k1, 5000)

    const melt = await meltNote(WITHDRAW_CALLBACK, k1, 'lnbcmockpay')
    mint.failMelt(idFromVerifyUrl(melt.verify!))

    // no longer pending - a normal op on it succeeds again, as if the melt
    // never happened
    const rotated = await rotateNote(WITHDRAW_CALLBACK, k1)
    expect(mint.isOutstanding(rotated.k1)).toBe(true)
  })
})

describe('spent vs. unknown note classification', () => {
  it('reports a never-issued k1 as unknown, not spent', async () => {
    const neverIssued = randomHex(32)
    await expect(
      fetchNoteInfo(buildNoteUrl(WITHDRAW_URL, neverIssued, 1000))
    ).rejects.toBeInstanceOf(NoteUnknownError)
    await expect(
      fetchNoteInfo(buildNoteUrl(WITHDRAW_URL, neverIssued, 1000))
    ).rejects.toThrow(/unknown/i)
  })

  it('reports a burned k1 as spent once it has actually been redeemed', async () => {
    const k1 = randomHex(32)
    mint.seed(k1, 1000)
    await rotateNote(WITHDRAW_CALLBACK, k1)
    await expect(
      fetchNoteInfo(buildNoteUrl(WITHDRAW_URL, k1, 1000))
    ).rejects.toBeInstanceOf(NoteSpentError)
  })

  it('a mutating callback naming an unknown k1 is also classified, even from its generic wording', async () => {
    const neverIssued = randomHex(32)
    await expect(
      rotateNote(WITHDRAW_CALLBACK, neverIssued)
    ).rejects.toBeInstanceOf(NoteUnknownError)
  })
})

describe('receiveNote surfaces a definitive spent/unknown report', () => {
  it('throws instead of silently storing an already-spent note as unverified', async () => {
    const k1 = randomHex(32)
    mint.seed(k1, 1000)
    await rotateNote(WITHDRAW_CALLBACK, k1) // burns k1

    const url = buildNoteUrl(WITHDRAW_URL, k1, 1000)
    await expect(receiveNote(toBech32Lnurl(url), [])).rejects.toBeInstanceOf(
      NoteSpentError
    )
  })

  it('throws for a note the service never issued', async () => {
    const neverIssued = randomHex(32)
    const url = buildNoteUrl(WITHDRAW_URL, neverIssued, 1000)
    await expect(receiveNote(toBech32Lnurl(url), [])).rejects.toBeInstanceOf(
      NoteUnknownError
    )
  })

  it('still falls back to an unverified note when the service is unreachable', async () => {
    vi.stubGlobal('fetch', (() => {
      throw new Error('network down')
    }) as unknown as typeof fetch)
    const k1 = randomHex(32)
    const url = buildNoteUrl(WITHDRAW_URL, k1, 1000)
    const received = await receiveNote(toBech32Lnurl(url), [])
    expect(received.verified).toBe(false)
    expect(received.amount).toBe(1000)
  })
})

describe('rotation-on-failure', () => {
  it('settleNote falls back to the pre-rotation note when rotate fails', async () => {
    const k1 = randomHex(32)
    mint.seed(k1, 8000)
    mint.rotateFails = true

    const settled = await settleNote(WITHDRAW_URL, k1, 8000, undefined)

    // rotate never went through - the original secret is still the live
    // one, exactly as before the attempt, and settleNote reports it back
    // rather than a rotated secret it doesn't have
    expect(settled.k1).toBe(k1)
    expect(settled.amountMsat).toBe(8000)
    expect(mint.isOutstanding(k1)).toBe(true)

    // SERVICE recovers - the very same note rotates cleanly afterward
    mint.rotateFails = false
    const rotated = await rotateNote(WITHDRAW_CALLBACK, k1)
    expect(mint.isOutstanding(rotated.k1)).toBe(true)
  })
})
