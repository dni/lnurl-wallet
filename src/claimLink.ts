import {resolveNoteInput} from './lnurlcash'

// The link a vault puts in the QR code when a note is handed over in person
// (lnurl-vault src/proto/note_url.c, NOTE_URL_CLAIM).
//
// It exists because lnurlw:// does not open on a stock phone (issue #26):
// the codes render and cameras decode them, and no handler picks them up. An
// ordinary https link into this wallet does, at the cost of one QR version.
//
//   https://wallet.lnurlcash.com/#/claim?u=<mint>&k1=<64 hex>&a=<msat>
//
// Everything after the '#' is a fragment, so the secret is never in a request
// line, a referrer or a server log. This wallet is a hash-router SPA, so that
// is also just its normal route shape.
//
// Params are short (`u`, `a`) because eleven characters is most of a QR
// version at this length.

// Reads the fragment params into the note URL the rest of the wallet already
// understands, or null if this is not a claim link. Everything here arrives
// off a scanned QR, so nothing is trusted: the result goes through
// resolveNoteInput, the same check the paste field and scanner use, and a
// link that does not survive it is refused rather than fetched.
export const claimLinkToNoteInput = (
  params: URLSearchParams
): string | null => {
  const mint = params.get('u')?.trim()
  const k1 = params.get('k1')?.trim()
  if (!mint || !k1) return null

  // A bare host is what the vault sends. Anything already carrying a scheme
  // is passed through so a mint on a non-default path or an onion/localhost
  // host still works - resolveNoteInput applies the https-only policy.
  const base = /^[a-z]+:\/\//i.test(mint) ? mint : `https://${mint}`

  let url: URL
  try {
    url = new URL(base)
  } catch {
    return null
  }
  url.searchParams.set('k1', k1)

  const amount = params.get('a')?.trim()
  // Advisory only - the mint is the authority on what a note is worth, and
  // receiveNote asks it. A junk amount must not sink an otherwise good note,
  // so it is dropped rather than rejected.
  if (amount && /^\d+$/.test(amount)) {
    url.searchParams.set('amount', amount)
  }

  return resolveNoteInput(url.toString())
}

// The claim route puts its params after the hash (see above), so they are not
// in location.search. Solid's router hands the route its own query, but a
// caller with only a raw href needs this.
export const claimParamsFromHref = (href: string): URLSearchParams | null => {
  const hash = href.indexOf('#')
  if (hash === -1) return null
  const fragment = href.slice(hash + 1)
  const query = fragment.indexOf('?')
  if (query === -1) return null
  return new URLSearchParams(fragment.slice(query + 1))
}
