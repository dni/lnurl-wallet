import {describe, expect, it} from 'vitest'

import {claimLinkToNoteInput, claimParamsFromHref} from './claimLink'
import {noteK1, serverOf} from './lnurlcash'

const K1 = 'a'.repeat(64)
const params = (query: string) => new URLSearchParams(query)

describe('claimLinkToNoteInput', () => {
  it('turns a vault claim link into a note URL', () => {
    const note = claimLinkToNoteInput(
      params(`u=mint.example&k1=${K1}&a=21000`)
    )!
    expect(note).not.toBeNull()
    expect(noteK1(note)).toBe(K1)
    expect(serverOf(note)).toBe('mint.example')
    expect(note).toContain('amount=21000')
  })

  it('accepts a mint on a path, which is what host means here', () => {
    const note = claimLinkToNoteInput(params(`u=mint.example/w&k1=${K1}`))!
    expect(note).toContain('/w')
    expect(noteK1(note)).toBe(K1)
  })

  // The amount is advisory - the mint is asked for the real value on
  // receive. A junk one must not sink an otherwise good note.
  it('drops a malformed amount rather than refusing the note', () => {
    const note = claimLinkToNoteInput(params(`u=mint.example&k1=${K1}&a=lots`))!
    expect(note).not.toBeNull()
    expect(note).not.toContain('amount')
  })

  it('refuses a link with no secret, and one with no mint', () => {
    expect(claimLinkToNoteInput(params('u=mint.example'))).toBeNull()
    expect(claimLinkToNoteInput(params(`k1=${K1}`))).toBeNull()
  })

  // Everything here comes off a scanned QR. A k1 that is not a 32-byte hex
  // preimage is not a note, and must not reach a fetch.
  it('refuses a secret that is not a preimage', () => {
    expect(claimLinkToNoteInput(params('u=mint.example&k1=nope'))).toBeNull()
    expect(
      claimLinkToNoteInput(params(`u=mint.example&k1=${'a'.repeat(63)}`))
    ).toBeNull()
  })

  it('refuses a mint that is not a URL at all', () => {
    expect(claimLinkToNoteInput(params(`u=%20&k1=${K1}`))).toBeNull()
  })

  // http:// to a clearnet host is refused upstream by resolveNoteInput - a
  // crafted link must not be able to downgrade the connection its note is
  // fetched over.
  it('does not let a scanned link choose plain http on the clearnet', () => {
    expect(
      claimLinkToNoteInput(params(`u=http://mint.example&k1=${K1}`))
    ).toBeNull()
  })
})

describe('claimParamsFromHref', () => {
  it('reads params from the fragment, not the query', () => {
    const found = claimParamsFromHref(
      `https://wallet.example/#/claim?u=mint.example&k1=${K1}`
    )!
    expect(found.get('u')).toBe('mint.example')
    expect(found.get('k1')).toBe(K1)
  })

  it('is null when there is nothing to read', () => {
    expect(claimParamsFromHref('https://wallet.example/')).toBeNull()
    expect(claimParamsFromHref('https://wallet.example/#/claim')).toBeNull()
  })

  it('gives a bare dev host the scheme it is actually served on', () => {
    // The vault writes the mint endpoint schemeless, so a note from the local
    // dev mint arrives as "u=localhost:8111/w". Forcing https on it produced a
    // URL nothing serves - every other bare host in this wallet asks
    // defaultSchemeFor, and now so does this one.
    const params = new URLSearchParams({
      u: 'localhost:8111/w',
      k1: K1,
      a: '21000'
    })
    expect(claimLinkToNoteInput(params)).toBe(
      `http://localhost:8111/w?k1=${K1}&amount=21000`
    )
    const clearnet = new URLSearchParams({
      u: 'mint.example.com/w',
      k1: K1,
      a: '21000'
    })
    expect(claimLinkToNoteInput(clearnet)).toBe(
      `https://mint.example.com/w?k1=${K1}&amount=21000`
    )
  })
})
