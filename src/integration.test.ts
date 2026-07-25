import {describe, expect, it} from 'vitest'

import {toBech32Lnurl, buildNoteUrl, noteK1, fetchNoteInfo, splitNote, mergeNotes, meltNote} from './lnurlcash'
import {receiveNote, secureReceivedNote} from './receive'

// Integration run against a locally running lnurl-mint holding a seeded
// note - skipped unless MINT_K1 is set, since it needs the live service
// (and burns the note it is given):
//
//   cd ../lnurl-mint && DATABASE_PATH=/tmp/mint.db \
//     uv run python -m uvicorn lnurl_mint.server:app --port 8137
//   # seed: INSERT INTO notes (id, amount_msat) VALUES (sha256(k1), 21000)
//   MINT_K1=<k1> npm test
//
// Note: lnurl-mint currently implements an earlier draft of LUD-XX (it
// still accepts the now-removed ?id= hash lookup and multi-k1 melt, and
// doesn't return `amount`/`signature`/`mintPubkey`) - this test only
// exercises what the current spec and this wallet actually use, which
// remains a subset the mint still serves correctly.
declare const process: {env: Record<string, string | undefined>}

const K1 = process.env.MINT_K1!
const WITHDRAW = 'http://localhost:8137/withdraw'

describe.runIf(!!process.env.MINT_K1)('against a live lnurl-mint', () => {
  it('receive -> rotate -> split -> merge, spec-compliantly', async () => {
    const url = buildNoteUrl(WITHDRAW, K1, 21000)

    // receive: resolves the bech32 form, verifies via the informational GET
    // (k1 echoed back verbatim, per the current spec's MUST)
    const received = await receiveNote(toBech32Lnurl(url), [])
    expect(received.verified).toBe(true)
    expect(received.amount).toBe(21000)
    expect(received.callback).toBe('http://localhost:8137/withdraw/cb')

    // rotate-on-receive: burns the handed-over secret
    const rotatedUrl = await secureReceivedNote(received)
    const rotatedK1 = noteK1(rotatedUrl)!
    expect(rotatedK1).not.toBe(K1)
    // old secret is spent now
    await expect(fetchNoteInfo(url)).rejects.toThrow(/spent/i)
    // fresh secret verifies at the same value
    const rotatedInfo = await fetchNoteInfo(rotatedUrl)
    expect(rotatedInfo.maxWithdrawable).toBe(21000)

    // split 6 sats off
    const parts = await splitNote(received.callback, rotatedK1, 6000)
    const partInfo = await fetchNoteInfo(buildNoteUrl(WITHDRAW, parts.k1, 6000))
    const changeInfo = await fetchNoteInfo(
      buildNoteUrl(WITHDRAW, parts.change, 15000)
    )
    expect(partInfo.maxWithdrawable).toBe(6000)
    expect(changeInfo.maxWithdrawable).toBe(15000)

    // merge them back into one 21-sat note
    const merged = await mergeNotes(received.callback, [
      parts.k1,
      parts.change
    ])
    const mergedInfo = await fetchNoteInfo(
      buildNoteUrl(WITHDRAW, merged.k1, 21000)
    )
    expect(mergedInfo.maxWithdrawable).toBe(21000)

    // melt fails cleanly without a funding source, note stays outstanding
    await expect(
      meltNote(received.callback, merged.k1, 'lnbc210n1invalid')
    ).rejects.toThrow()
    expect(
      (await fetchNoteInfo(buildNoteUrl(WITHDRAW, merged.k1, 21000)))
        .maxWithdrawable
    ).toBe(21000)
  })
})
