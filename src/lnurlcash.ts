import {bech32} from '@scure/base'
import {sha256} from '@noble/hashes/sha2.js'
import {secp256k1} from '@noble/curves/secp256k1.js'
import {bytesToHex, hexToBytes, utf8ToBytes} from '@noble/hashes/utils.js'
import {offlineMode} from './offlineMode'
import {msatToSats} from './helpers'

// LUD-25 LNURLcash - bearer assets. Draft spec:
// https://github.com/lnurl/luds/blob/lnurlcash/25.md
//
// A bearer note is an ordinary LUD-03 withdrawRequest link whose k1 *is*
// the asset. No new endpoint, no new encoding. A GET on the note's LNURL
// is purely informational (the authoritative value is always
// maxWithdrawable, never the URL's own `amount`); every mutating op goes
// to the `callback` from that response:
//
//   callback?k1=X&pr=<bolt11>              melt: X burned, pr (of exactly its value) paid
//   callback?k1=X&h=<sha256(X')>           rotate: X burned, a note keyed by h minted, same value
//   callback?k1=X..&amount=<msat>&h&h2     split: one or many k1s burned, notes keyed by h (amount) + h2 (change) minted
//   callback?k1=X&k1=Y..&h=<sha256(Z)>     merge: all burned, one note keyed by h minted, worth their sum
//
// `h`/`h2` are hashes of secrets this wallet generates itself, never
// SERVICE (see generateNoteSecret) - the response carries no new k1, just
// {"status":"OK"} (plus sig/sig2, see Offline verification below).
//
// Minting: a LUD-06 payRequest may advertise `withdrawLink` (raw LUD-17 URL
// of the withdraw endpoint) - the payment preimage of its paid invoice
// becomes a valid k1 there.
//
// A melt's {"status":"OK"} only means the payment is now in flight - the
// note isn't confirmed spent until it settles, and is restored to
// outstanding if it fails (see meltNote). Any other callback naming a k1
// that's mid-melt is rejected with {"status":"ERROR","reason":"pending"}
// until it resolves one way or the other. SERVICE MAY additionally prove a
// melt happened via a `pr`/`verify` melt proof (LUD-21-style), so its fate
// can be confirmed without re-probing the note with a rotate.

// ---- LUD-01 bech32 encoding ----

export const isBech32Lnurl = (data: string): boolean =>
  data.trim().toUpperCase().startsWith('LNURL1')

export const toBech32Lnurl = (url: string): string => {
  const bytes = new TextEncoder().encode(url)
  return bech32.encode('lnurl', bech32.toWords(bytes), 2048).toUpperCase()
}

export const fromBech32Lnurl = (data: string): string | null => {
  const safe = data.trim().toUpperCase()
  if (!safe.startsWith('LNURL1')) return null
  try {
    const decoded = bech32.decode(
      `LNURL1${safe.slice(6)}` as `${string}1${string}`,
      2048
    )
    return new TextDecoder().decode(bech32.fromWords(decoded.words))
  } catch {
    return null
  }
}

// ---- LUD-17 scheme URLs ----

// mirrors lnurl_server's INSECURE_HOSTS: these (plus .onion) resolve to
// http:// instead of https://
const INSECURE_HOSTS = ['127.0.0.1', '0.0.0.0', 'localhost']

const isInsecureHost = (host: string): boolean =>
  INSECURE_HOSTS.includes(host) || host.endsWith('.onion')

export const fromLud17 = (url: string): string => {
  const match = url.match(/^(?:lnurlw|lnurlp|lnurlc|keyauth):\/\/([^/]+)/i)
  if (!match) return url
  const scheme = isInsecureHost(match[1].split(':')[0]) ? 'http' : 'https'
  return url.replace(/^[a-z]+:\/\//i, `${scheme}://`)
}

export const toLud17w = (url: string): string =>
  url.replace(/^https?:\/\//, 'lnurlw://')

// LUD-16: a Lightning Address resolves to its .well-known payRequest URL
export const isLightningAddress = (value: string): boolean =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())

const lnAddressToUrl = (address: string): string => {
  const [name, domain] = address.trim().split('@')
  const scheme = isInsecureHost(domain) ? 'http' : 'https'
  return `${scheme}://${domain}/.well-known/lnurlp/${name}`
}

// a bare mint domain, with no local-part - either literally bare
// ("mint.600.wtf") or with a leading "@" the way some mints display their
// own address ("@mint.600.wtf", NIP-05-style), no scheme and no path. Not a
// general-purpose "guess a URL from a hostname" - specific to this wallet's
// own default mint@<domain> convention (see Mint.tsx's guessMintAddress,
// PUBLIC_MINTS below), the same "mint" username lnurl-mint itself defaults
// USERNAME to, so a mint that actually uses a different one still just
// fails normally and has to be typed out in full.
const isBareMintDomain = (value: string): boolean => {
  const trimmed = value.trim()
  return /^@?[^\s@/]+\.[^\s@/]+$/.test(trimmed) && !isLightningAddress(trimmed)
}

const bareMintDomainToUrl = (value: string): string =>
  lnAddressToUrl(`mint@${value.trim().replace(/^@/, '')}`)

// narrower than resolveLnurlInput below - a mint lookup accepts a bech32
// LNURL, a Lightning Address, or a bare mint domain (see isBareMintDomain),
// all of which point unambiguously at one payRequest with no guessing at
// scheme or path beyond the "mint" username default the bare form assumes
export const resolveMintInput = (value: string): string | null => {
  const trimmed = value.trim()
  if (!trimmed) return null
  if (isBech32Lnurl(trimmed)) return fromBech32Lnurl(trimmed)
  if (isLightningAddress(trimmed)) return lnAddressToUrl(trimmed)
  if (isBareMintDomain(trimmed)) return bareMintDomainToUrl(trimmed)
  return null
}

// matches the LUD-16 .well-known/lnurlp/{name} path any resolved payRequest
// URL follows - whether it got there via an actual Lightning Address
// (lnAddressToUrl above), a bech32 LNURL that happens to decode to the same
// convention, or a raw URL typed/scanned directly. Shared by mintAddressUrl
// and lightningAddressUsername below so neither has to re-derive it from
// the raw input text (which a bech32/scanned URL never carried in the
// first place) - the resolved URL's own path already has the answer.
const LNURLP_PATH_RE = /^(.*\/\.well-known\/)lnurlp\/([^/]+)$/

// LUD-25 mint address (theoretical/experimental - see lnurl-mint's README):
// the withdraw-side mirror of a payRequest URL, at .well-known/lnurlw/{name}
// instead of .../lnurlp/{name} - same username, same origin. Derived
// straight from the payRequest URL itself (whatever this wallet already
// resolved mint input to - see resolveMintInput), not guessed from the raw
// input: null for anything not at that conventional path, nothing to
// mirror.
export const mintAddressUrl = (payUrl: string): string | null => {
  let parsed: URL
  try {
    parsed = new URL(payUrl)
  } catch {
    return null
  }
  const match = parsed.pathname.match(LNURLP_PATH_RE)
  if (!match) return null
  return `${parsed.origin}${match[1]}lnurlw/${match[2]}`
}

// the username segment of a resolved payRequest URL ("mint" out of
// .../.well-known/lnurlp/mint) - null for a URL that isn't at that
// conventional path. Cached onto TrustedMint (see trustedMints.ts) so a
// later quick-select can reconstruct the exact address this mint was
// actually reached at, instead of guessing "mint@<server>" (see Mint.tsx's
// guessMintAddress) for a mint that uses a different one.
export const lightningAddressUsername = (payUrl: string): string | null => {
  try {
    return new URL(payUrl).pathname.match(LNURLP_PATH_RE)?.[2] ?? null
  } catch {
    return null
  }
}

// resolves arbitrary LNURL-ish input (bech32, LUD-17 scheme, Lightning
// Address, plain http(s)) down to a fetchable URL
export const resolveLnurlInput = (value: string): string | null => {
  const trimmed = value.trim()
  if (!trimmed) return null
  if (isBech32Lnurl(trimmed)) return fromBech32Lnurl(trimmed)
  if (/^(lnurlw|lnurlp|lnurlc|keyauth):\/\//i.test(trimmed)) {
    return fromLud17(trimmed)
  }
  if (isLightningAddress(trimmed)) return lnAddressToUrl(trimmed)
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  return null
}

// ---- bearer notes ----

// a note is its withdraw LNURL with the secret as k1 query param
export const noteK1 = (url: string): string | null => {
  try {
    return new URL(url).searchParams.get('k1')
  } catch {
    return null
  }
}

// like noteK1, but throws instead of returning null - a device-backed
// bearer's url deliberately never carries a real k1 (see withoutK1), so
// any call site about to use one for a mint mutation should call this
// instead: it fails loudly and specifically rather than silently sending
// a blank/wrong k1 to a mint
export const requireNoteK1 = (url: string): string => {
  const k1 = noteK1(url)
  if (!k1) {
    throw new Error(
      'This note has no secret in the browser - it may be device-backed.'
    )
  }
  return k1
}

// the amount a note *claims* to carry, straight from the URL - only a claim
// by whoever encoded it (SERVICE ignores it at the informational endpoint),
// safe to show before contacting SERVICE but not to be trusted without a
// matching signature (see verifyNoteSignature) or a fresh online GET
export const noteDeclaredAmount = (url: string): number | null => {
  try {
    const raw = new URL(url).searchParams.get('amount')
    if (raw === null) return null
    const n = Number(raw)
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}

export const noteSignature = (url: string): string | null => {
  try {
    return new URL(url).searchParams.get('sig')
  } catch {
    return null
  }
}

// input only qualifies as a bearer note if it resolves to a URL carrying k1
export const resolveNoteInput = (value: string): string | null => {
  const url = resolveLnurlInput(value)
  if (!url || !noteK1(url)) return null
  return url
}

export const isValidNoteInput = (value: string): boolean =>
  resolveNoteInput(value) !== null

// withdrawLink (raw LUD-17 URL of the withdraw endpoint) + a fresh secret
// -> note. `amountMsat` is the declared value (see noteDeclaredAmount) -
// omit it when the real value isn't known yet (e.g. claiming a preimage
// that arrived from outside this wallet, with no invoice request of our
// own to read it from): the spec has SERVICE ignore amount at this
// endpoint regardless, but some implementations validate it strictly, and
// a placeholder like 0 risks being rejected as invalid rather than ignored.
export const buildNoteUrl = (
  withdrawLink: string,
  k1: string,
  amountMsat?: number
): string => {
  const url = new URL(fromLud17(withdrawLink.trim()))
  url.searchParams.set('k1', k1.trim().toLowerCase())
  if (amountMsat !== undefined) {
    url.searchParams.set('amount', String(amountMsat))
  }
  return url.toString()
}

// the same note with its secret swapped out - after rotate/split/merge. A
// signature only carries over when the response actually returned a fresh
// one for this k1 (a rotate/split/merge without offline verification
// support drops any stale sig, since it no longer matches the new secret).
export const withNewK1 = (
  url: string,
  k1: string,
  amountMsat: number,
  signature?: string
): string => {
  const newUrl = new URL(url)
  newUrl.searchParams.set('k1', k1)
  newUrl.searchParams.set('amount', String(amountMsat))
  if (signature) newUrl.searchParams.set('sig', signature)
  else newUrl.searchParams.delete('sig')
  return newUrl.toString()
}

// like withNewK1, but deletes k1 instead of setting it - for re-deriving a
// device-backed bearer's blank-mirror url from an existing note's own url
// template (same host/path), after a rotate/split/merge whose fresh secret
// now lives on the device, not in this browser
export const withoutK1 = (
  url: string,
  amountMsat: number,
  signature?: string
): string => {
  const newUrl = new URL(url)
  newUrl.searchParams.delete('k1')
  newUrl.searchParams.set('amount', String(amountMsat))
  if (signature) newUrl.searchParams.set('sig', signature)
  else newUrl.searchParams.delete('sig')
  return newUrl.toString()
}

export const serverOf = (url: string): string => {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

// ---- offline verification (optional) ----

// Signed the same way LUD-13 signs its auth seed phrase - the standard
// Lightning node `signmessage` wrapping:
//   message = "LNURLcash:" || amount_msat (decimal ASCII) || ":" || hex(sha256(k1))
//   digest  = sha256(sha256("Lightning Signed Message:" || message))
const LIGHTNING_SIGNED_MESSAGE_PREFIX = utf8ToBytes('Lightning Signed Message:')

const hashK1 = (k1: string): string => bytesToHex(sha256(hexToBytes(k1)))

// LUD-25: for a rotate/split/merge, WALLET - not SERVICE - generates the
// replacement note's secret and discloses only its hash (h/h2 on the
// callback) - a fresh 32-byte value, the same size an actual Lightning
// payment preimage already is, though nothing is ever paid for it, it's
// just drawn at random. SERVICE never sees, generates, or persists it.
const generateNoteSecret = (): string =>
  bytesToHex(crypto.getRandomValues(new Uint8Array(32)))

const noteSignatureDigest = (k1: string, amountMsat: number): Uint8Array => {
  const message = utf8ToBytes(`LNURLcash:${amountMsat}:${hashK1(k1)}`)
  return sha256(
    sha256(new Uint8Array([...LIGHTNING_SIGNED_MESSAGE_PREFIX, ...message]))
  )
}

// recovers the signer's pubkey from (k1, amountMsat, signature) and checks
// it against `mintPubkey` - true only if both match. `signature` is 65
// bytes, but which end carries the recovery id varies by mint in practice:
// the spec text calls for r || s || recovery-id (trailing - the same
// layout raw BOLT-11 signatures use); lnurl-mint used to instead send its
// underlying Lightning node's signmessage RPC output unreordered -
// recovery-id || r || s (leading) - and has since fixed that, but other
// implementations may still get it wrong. Trying both candidate orderings
// costs nothing security-wise (recovering against the wrong one just
// yields an unrelated pubkey that won't match mintPubkey) and means a note
// verifies correctly regardless of which convention its issuer followed.
export const verifyNoteSignature = (
  k1: string,
  amountMsat: number,
  signatureHex: string,
  mintPubkeyHex: string
): boolean => {
  let wireSig: Uint8Array
  try {
    wireSig = hexToBytes(signatureHex)
  } catch {
    return false
  }
  if (wireSig.length !== 65) return false
  const digest = noteSignatureDigest(k1, amountMsat)
  const target = mintPubkeyHex.toLowerCase()
  const trailing = new Uint8Array([wireSig[64], ...wireSig.subarray(0, 64)])
  const leading = wireSig
  for (const candidate of [trailing, leading]) {
    try {
      // `digest` is already the final double-sha256 per the spec/LUD-13 -
      // @noble/curves' recoverPublicKey otherwise defaults to `prehash:
      // true` and hashes it again internally, which would make this
      // recover against a value nothing ever actually signed and never
      // match a real signer's key (masked in this repo's own tests before
      // this fix, since the mock signer there had the same bug the other
      // way - see lnurlcash.test.ts)
      const recovered = secp256k1.recoverPublicKey(candidate, digest, {
        prehash: false
      })
      if (bytesToHex(recovered) === target) return true
    } catch {
      // not a valid recovery under this ordering - try the other one
    }
  }
  return false
}

// ---- protocol requests ----

const lnurlFetch = async (url: string | URL): Promise<any> => {
  if (offlineMode()) {
    throw new Error(
      'Offline mode is on - turn it off in the nav to reach a service.'
    )
  }
  let res: Response
  try {
    res = await fetch(url.toString())
  } catch {
    throw new Error(
      'Failed to reach the service - it may be offline or not allow cross-origin requests.'
    )
  }
  const body = await res.json().catch(() => {
    throw new Error('Service returned an invalid response.')
  })
  if (body?.status === 'ERROR') {
    throw new Error(body.reason || 'Unknown service error.')
  }
  return body
}

export type WithdrawRequestInfo = {
  tag: 'withdrawRequest'
  callback: string
  k1: string
  minWithdrawable: number
  maxWithdrawable: number
  defaultDescription?: string
  mintPubkey?: string
}

// the informational GET (LUD-03 step 1) - never burns, rotates or alters
// the note. Per spec this puts k1 on the wire - callers that keep holding
// the note afterward SHOULD rotate it (see receive.ts / BearerCard's
// refresh).
export const fetchNoteInfo = async (
  url: string
): Promise<WithdrawRequestInfo> => {
  // `sig` (offline verification) is only meaningful to a holder inspecting
  // the note locally - the service already knows what it signed, so this
  // GET has no use for it and it's dropped before the request goes out
  // rather than sent along for nothing. `k1` (and `amount`, which the spec
  // has the service ignore here anyway) are left as-is.
  const reqUrl = new URL(url)
  reqUrl.searchParams.delete('sig')
  let body: any
  try {
    body = await lnurlFetch(reqUrl)
  } catch (err) {
    throw classifyNoteError((err as Error).message)
  }
  if (
    body?.tag !== 'withdrawRequest' ||
    typeof body.callback !== 'string' ||
    typeof body.k1 !== 'string' ||
    typeof body.maxWithdrawable !== 'number'
  ) {
    throw new Error('Not a withdrawRequest (unexpected response).')
  }
  // spec MUST: the response's k1 is the actual bearer secret, never a
  // derived/opaque id - a service returning something else for the k1 we
  // queried is non-compliant (or the note was rotated by someone else)
  const queried = noteK1(url)
  if (queried && body.k1 !== queried) {
    throw new Error(
      "Service echoed back a different k1 than queried - the note may have been redeemed elsewhere, or the service isn't spec-compliant."
    )
  }
  return body as WithdrawRequestInfo
}

// LUD-25 mint address (see mintAddressUrl above): the withdraw-side
// discovery response a mint MAY publish there - this mint's own node
// identity (alias/uri/color/capacity), the amount bounds a freshly minted
// note can actually fall into, and payLink back to the real payRequest.
// Unlike WithdrawRequestInfo there's no real k1 behind this - it's purely
// informational (this mint only ever custodies bearer notes, never
// per-user accounts, so there's no balance behind a username to withdraw),
// so it's typed and parsed separately rather than reusing that type with
// an optional k1: nothing here is ever safe to treat as spendable.
export type MintAddressInfo = {
  tag: 'withdrawRequest'
  callback: string
  minWithdrawable: number
  maxWithdrawable: number
  defaultDescription?: string
  // the wire field is still `mintPubkey` (LUD-25's term for a note's own
  // signing key) - renamed on this side to sit next to nodeAlias/nodeUri/
  // nodeColor, since at this endpoint it's never a note's key, always this
  // mint's own underlying node identity (see lnurl-mint's
  // _mint_address_response: derived straight from NodeInfo.uri)
  nodePubkey?: string
  payLink: string
  nodeAlias?: string
  nodeUri?: string
  nodeColor?: string
  nodeCapacityMsat?: number
  nodeNumChannels?: number
  nodeNumPeers?: number
}

// Best-effort discovery only: this endpoint is experimental (not part of
// any numbered LUD), so most mints - including ones this wallet otherwise
// works fine with - simply won't have it. Callers should treat a rejection
// here as "no extra info available" and fall back to the payRequest lookup
// (fetchPayRequest), which remains the only functional path to actually
// mint a note.
export const fetchMintAddress = async (
  url: string
): Promise<MintAddressInfo> => {
  const body = await lnurlFetch(url)
  if (
    body?.tag !== 'withdrawRequest' ||
    typeof body.callback !== 'string' ||
    typeof body.payLink !== 'string' ||
    typeof body.maxWithdrawable !== 'number'
  ) {
    throw new Error('Not a mint address response (unexpected shape).')
  }
  const {mintPubkey, ...rest} = body
  return {...rest, nodePubkey: mintPubkey} as MintAddressInfo
}

export type WithdrawSuccessResponse = {
  status: 'OK'
  sig?: string
  sig2?: string
  // LUD-25 melt proof (optional): only present on a melt's response, and
  // only when SERVICE advertises it - see meltNote
  pr?: string
  verify?: string
}

// thrown for the exact {"status":"ERROR","reason":"pending"} case (see
// meltNote) - distinct from any other Error so callers polling a mid-melt
// note (Melt.tsx) can tell "still in flight, try again shortly" apart from
// every other failure, which instead means the k1 is gone for good
export class PendingNoteError extends Error {
  constructor() {
    super(
      'This note has another operation in progress - try again in a moment.'
    )
    this.name = 'PendingNoteError'
  }
}

// thrown when SERVICE reports the k1 as unambiguously already spent (burned
// by a prior melt/rotate/split/merge, or replayed after one of those) -
// distinct from NoteUnknownError below because SERVICE is authoritative
// here: a wallet holding this k1 locally can safely lock it as spent
// without asking, the same as if it had just melted it itself
export class NoteSpentError extends Error {
  constructor(reason: string) {
    super(`This note has already been spent (service says: "${reason}").`)
    this.name = 'NoteSpentError'
  }
}

// thrown when SERVICE reports the k1 as never having been a valid note at
// all - never minted here, minted at a different service, or simply
// mistyped/corrupted. Distinct from NoteSpentError: nothing here proves
// this wallet's copy was ever real, so it's surfaced as an error rather
// than silently locked as spent
export class NoteUnknownError extends Error {
  constructor(reason: string) {
    super(
      `The service doesn't recognize this note (service says: "${reason}").`
    )
    this.name = 'NoteUnknownError'
  }
}

// SERVICE's own wording for "this k1 is dead" varies by implementation and
// by endpoint - the informational GET can afford to distinguish "Note
// already spent." from "Unknown note.", while the mutating callback (an
// atomic, possibly multi-k1 request) can only ever say something like
// "Invalid or already spent k1." since it can't tell which case applies to
// which k1. Classified here so every note-specific call site gets a
// consistent, typed error instead of each re-parsing raw reason text.
const classifyNoteError = (reason: string): Error => {
  if (/spent/i.test(reason)) return new NoteSpentError(reason)
  if (/unknown|not found/i.test(reason)) return new NoteUnknownError(reason)
  return new Error(reason)
}

const callbackRequest = async (
  callback: string,
  params: [string, string][]
): Promise<WithdrawSuccessResponse> => {
  const cbUrl = new URL(callback)
  // append (not set): merge repeats the k1 param
  for (const [key, value] of params) cbUrl.searchParams.append(key, value)
  let body: any
  try {
    body = await lnurlFetch(cbUrl)
  } catch (err) {
    // a k1 already mid-melt (see meltNote) rejects any other callback
    // naming it with this exact reason string, verbatim per spec
    if ((err as Error).message === 'pending') {
      throw new PendingNoteError()
    }
    throw classifyNoteError((err as Error).message)
  }
  if (body?.status !== 'OK') {
    throw new Error('Operation was not confirmed by the service.')
  }
  return body as WithdrawSuccessResponse
}

export type MeltResult = {
  // LUD-25 melt proof (optional): a LUD-21-style URL SERVICE MAY return,
  // proving this exact outgoing payment settled - see
  // fetchInvoiceVerification. Absent unless SERVICE advertises it
  // (lnurl-mint: only when VERIFY_ENABLED).
  verify?: string
}

// melt: burn a single note, the service pays `pr` of exactly its value -
// merge first to melt several notes in one payment (the spec dropped
// multi-k1 melt). `{"status":"OK"}` here only means the payment is now in
// flight, NOT that the note is confirmed spent: SERVICE pays pr
// asynchronously and only finalizes the burn once it settles, restoring
// the note to outstanding if the payment fails instead. Callers should
// treat this as "melt requested," not "melt done" - see BearerCard's melt
// action for how that plays out in the UI.
export const meltNote = async (
  callback: string,
  k1: string,
  pr: string
): Promise<MeltResult> => {
  const body = await callbackRequest(callback, [
    ['k1', k1],
    ['pr', pr.trim()]
  ])
  return {verify: body.verify}
}

// ---- hash-parameterized primitives ----
//
// The actual mint call behind rotate/split/merge, taking a hash the caller
// already has instead of generating one itself. This is what LNURLvault
// integration (see deviceOrchestration.ts) drives directly - a device's own
// new_secret/new_secret_pair produces `h`/`h2` there, not this browser's
// generateNoteSecret(). rotateNote/splitNote/mergeNotes below are just the
// browser-generates-its-own-secret case of these.

export type HashedMutationResult = {signature?: string}

export const rotateNoteWithHash = async (
  callback: string,
  k1: string,
  h: string
): Promise<HashedMutationResult> => {
  const body = await callbackRequest(callback, [
    ['k1', k1],
    ['h', h]
  ])
  return {signature: body.sig}
}

export type HashedSplitResult = {
  signature?: string
  changeSignature?: string
}

export const splitNoteWithHash = async (
  callback: string,
  k1s: string[],
  amountMsat: number,
  h: string,
  h2: string
): Promise<HashedSplitResult> => {
  const body = await callbackRequest(callback, [
    ...k1s.map((k1): [string, string] => ['k1', k1]),
    ['amount', String(amountMsat)],
    ['h', h],
    ['h2', h2]
  ])
  return {signature: body.sig, changeSignature: body.sig2}
}

export const mergeNotesWithHash = async (
  callback: string,
  k1s: string[],
  h: string
): Promise<HashedMutationResult> => {
  const body = await callbackRequest(callback, [
    ...k1s.map((k1): [string, string] => ['k1', k1]),
    ['h', h]
  ])
  return {signature: body.sig}
}

export type RotateResult = {k1: string; signature?: string}

// rotate: burn k1, get a fresh secret of the same value - closes the window
// in which any previous holder (or logged URL) could redeem the note. Also
// how a wallet obtains a compact, offline-verifiable copy of a note that
// doesn't have one yet (e.g. straight after minting). Per LUD-25, this
// wallet - not the service - generates that fresh secret and discloses
// only its hash (h): the service never sees, generates, or persists the
// replacement note's raw secret, closing the prior-holder exposure a
// server-generated one would otherwise reopen every time.
export const rotateNote = async (
  callback: string,
  k1: string
): Promise<RotateResult> => {
  const newK1 = generateNoteSecret()
  const result = await rotateNoteWithHash(callback, k1, hashK1(newK1))
  return {k1: newK1, signature: result.signature}
}

export type SplitResult = {
  k1: string
  signature?: string
  change: string
  changeSignature?: string
}

// split: burn one or many k1s (LUD-25: "one or many | no | yes"), mint one
// note worth `amountMsat` and one carrying the remainder of their combined
// value - both secrets wallet-generated per LUD-25 (see rotateNote),
// disclosed as h/h2. Splitting several notes at once needs no prior merge:
// this burns all of them in a single request, same as mergeNotes does
export const splitNote = async (
  callback: string,
  k1s: string[],
  amountMsat: number
): Promise<SplitResult> => {
  const newK1 = generateNoteSecret()
  const changeK1 = generateNoteSecret()
  const result = await splitNoteWithHash(
    callback,
    k1s,
    amountMsat,
    hashK1(newK1),
    hashK1(changeK1)
  )
  return {
    k1: newK1,
    signature: result.signature,
    change: changeK1,
    changeSignature: result.changeSignature
  }
}

// merge: burn all given notes, mint one worth their sum - wallet-generated
// secret per LUD-25 (see rotateNote), disclosed as h
export const mergeNotes = async (
  callback: string,
  k1s: string[]
): Promise<RotateResult> => {
  const newK1 = generateNoteSecret()
  const result = await mergeNotesWithHash(callback, k1s, hashK1(newK1))
  return {k1: newK1, signature: result.signature}
}

export type SettledNote = {
  k1: string
  amountMsat: number
  signature?: string
  callback: string
}

// resolves what a split's change note or a merge's result note is
// ACTUALLY worth, and rotates it before further use. Neither response
// carries its own amount (WithdrawSuccessResponse has none - the spec's
// only source of truth for a note's value is an informational GET), and a
// mint that charges fees (LUD-25) may have deducted some from a split's
// change, or refunded some into a merge's result - using the naively
// computed pre-fee amount instead pairs a wrong `amount` with a signature
// the mint actually issued for the true one, so the note looks unsigned
// even though it isn't. That GET necessarily puts k1 on the wire in turn,
// so - same as BearerCard's refresh() - a rotate immediately follows,
// best-effort: a mint that doesn't support it keeps the GET-exposed k1
// and its original signature rather than fail the whole operation over it.
export const settleNote = async (
  baseUrl: string,
  k1: string,
  expectedAmountMsat: number,
  signature: string | undefined
): Promise<SettledNote> => {
  const info = await fetchNoteInfo(
    withNewK1(baseUrl, k1, expectedAmountMsat, signature)
  )
  try {
    const rotated = await rotateNote(info.callback, k1)
    return {
      k1: rotated.k1,
      amountMsat: info.maxWithdrawable,
      signature: rotated.signature,
      callback: info.callback
    }
  } catch {
    return {
      k1,
      amountMsat: info.maxWithdrawable,
      signature,
      callback: info.callback
    }
  }
}

// ---- minting via LUD-06 payRequest ----

export type MintFee = {
  baseFeeMsat: number
  feePpm: number
}

export type PayRequestInfo = {
  tag: 'payRequest'
  callback: string
  minSendable: number
  maxSendable: number
  metadata: string
  // LUD-25: present when paying this mints a bearer note - the payment
  // preimage becomes a valid k1 at this (raw LUD-17) withdraw endpoint
  withdrawLink?: string
  // rarely present here in practice: a WALLET that pays the invoice can
  // recover SERVICE's node id straight from its own BOLT-11 signature, so
  // the spec only has SERVICE publish mintPubkey where there's no invoice
  // to recover it from - the withdrawRequest response, for rotated/split/
  // merged notes. Kept optional here too since nothing forbids a SERVICE
  // from including it anyway.
  mintPubkey?: string
  // LUD-25 (optional): parsed from metadata (see parseMintFee) - absent
  // means SERVICE didn't advertise one, which the spec says to read as
  // fee-free, not "unknown"
  mintFee?: MintFee
}

// LUD-25 mint fees (optional): SERVICE signals what it withholds on minting
// via an extra ["text/plain", "Mint fees: <base_fee_msat>,<fee_percent_ppm>"]
// entry in a payRequest's metadata array, so a WALLET can warn the payer up
// front that the note it ends up holding may be worth less than the invoice
// it paid. A SERVICE that omits the entry is assumed fee-free.
export const parseMintFee = (metadata: string): MintFee | null => {
  let entries: unknown
  try {
    entries = JSON.parse(metadata)
  } catch {
    return null
  }
  if (!Array.isArray(entries)) return null
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry[0] !== 'text/plain') continue
    const match =
      typeof entry[1] === 'string' &&
      entry[1].match(/^Mint fees:\s*(\d+)\s*,\s*(\d+)\s*$/)
    if (!match) continue
    const baseFeeMsat = Number(match[1])
    const feePpm = Number(match[2])
    if (!Number.isFinite(baseFeeMsat) || !Number.isFinite(feePpm)) continue
    // an explicit "Mint fees: 0,0" has the exact same effect as omitting
    // the entry entirely - treat it identically, so callers don't need to
    // special-case a fee that's technically present but withholds nothing
    if (baseFeeMsat === 0 && feePpm === 0) return null
    return {baseFeeMsat, feePpm}
  }
  return null
}

// the note value SERVICE is expected to credit after withholding its
// advertised fee - per the spec text, "amount - base_fee_msat - amount *
// fee_percent_ppm / 1_000_000". Floored since msat is necessarily an
// integer and SERVICE presumably can't credit a fractional one; this is
// only ever an estimate to display before paying - the authoritative value
// is always whatever the informational GET reports after claiming (see
// Mint.tsx's claim)
export const applyMintFee = (grossMsat: number, fee: MintFee): number =>
  Math.max(
    0,
    grossMsat - fee.baseFeeMsat - Math.floor((grossMsat * fee.feePpm) / 1e6)
  )

// the inverse: how big an invoice needs to be so the note it mints nets
// netMsat once SERVICE's fee comes out. The linear formula is only a
// starting estimate - flooring in applyMintFee means it can land either a
// hair short or a hair over, so this walks to the exact minimal gross
// amount that nets netMsat (applyMintFee is non-decreasing in gross with
// per-msat steps of 0 or 1, so that gross always exists and is unique)
export const grossUpForMintFee = (netMsat: number, fee: MintFee): number => {
  let gross = Math.round((netMsat + fee.baseFeeMsat) / (1 - fee.feePpm / 1e6))
  while (applyMintFee(gross, fee) < netMsat) gross++
  while (gross > 0 && applyMintFee(gross - 1, fee) >= netMsat) gross--
  return gross
}

// fee_percent_ppm is parts-per-million - /10_000 for a percent, then trim
// the trailing zeros toFixed leaves behind (2000 ppm -> "0.2000" -> "0.2")
export const formatFeePercent = (ppm: number): string =>
  (ppm / 10_000).toFixed(4).replace(/\.?0+$/, '')

// parseMintFee already collapses a fully-zero fee down to null, so by the
// time one reaches here at least one of the two components is set - only
// mention the one(s) that actually are
export const describeMintFee = (fee: MintFee): string =>
  [
    fee.baseFeeMsat > 0 ? `${msatToSats(fee.baseFeeMsat)} sat flat` : null,
    fee.feePpm > 0
      ? `${formatFeePercent(fee.feePpm)}% of the amount paid`
      : null
  ]
    .filter(Boolean)
    .join(' + ')

export const fetchPayRequest = async (url: string): Promise<PayRequestInfo> => {
  const body = await lnurlFetch(url)
  if (body?.tag !== 'payRequest' || typeof body.callback !== 'string') {
    throw new Error('Not a payRequest (unexpected response).')
  }
  const mintFee =
    typeof body.metadata === 'string' ? parseMintFee(body.metadata) : null
  return {...body, mintFee: mintFee ?? undefined} as PayRequestInfo
}

export type InvoiceResult = {
  pr: string
  // LUD-21 (optional): a URL to poll for this invoice's settlement status
  verify?: string
  // LUD-11: false means SERVICE wants the payRequest LNURL/Lightning
  // Address itself (not this one invoice, which is always spent once
  // paid regardless) kept around and reused - per spec, disposable being
  // null/absent MUST be read as true, so only an explicit `false` counts
  disposable: boolean
}

export const requestInvoice = async (
  payCallback: string,
  amountMsat: number
): Promise<InvoiceResult> => {
  const cbUrl = new URL(payCallback)
  cbUrl.searchParams.set('amount', String(amountMsat))
  const body = await lnurlFetch(cbUrl)
  if (typeof body?.pr !== 'string') {
    throw new Error('Service did not return an invoice.')
  }
  return {
    pr: body.pr,
    verify: typeof body.verify === 'string' ? body.verify : undefined,
    disposable: body.disposable !== false
  }
}

export type VerifyResult = {
  settled: boolean
  preimage: string | null
  pr: string
}

// LUD-21: polls whether an invoice from requestInvoice has settled, via the
// URL it optionally returned as `verify`. `preimage` is only ever populated
// by a service that chooses to return it - for lnurlcash specifically, the
// preimage IS the bearer secret, so a service SHOULD withhold it here (a
// verify GET proves nothing about who's asking, just that they know the
// payment hash embedded in the URL) and let the payer's own wallet be the
// only source of it. Treat a returned preimage as a convenience, never a
// guarantee that any given service provides one.
export const fetchInvoiceVerification = async (
  verifyUrl: string
): Promise<VerifyResult> => {
  const body = await lnurlFetch(verifyUrl)
  if (typeof body?.settled !== 'boolean' || typeof body?.pr !== 'string') {
    throw new Error('Service returned an unexpected verify response.')
  }
  return {
    settled: body.settled,
    preimage: typeof body.preimage === 'string' ? body.preimage : null,
    pr: body.pr
  }
}

// a payment preimage (the future k1): 32 bytes hex
export const isPreimage = (value: string): boolean =>
  /^[0-9a-fA-F]{64}$/.test(value.trim())

// a raw BOLT-11 invoice - loose shape check only (one of the known network
// prefixes, an optional amount, then the bech32 separator), same
// non-exhaustive spirit as isValidNoteInput. Anchored to actual bolt11
// prefixes (bc/tb/bcrt/...) rather than a bare "ln", which a bech32 LNURL
// ("lnurl1...") would also match.
export const isBolt11Invoice = (value: string): boolean =>
  /^ln(bc|tb|bcrt|tbs|sb)[0-9]*[munp]?1[a-z0-9]+$/.test(
    value.trim().toLowerCase()
  )

// per unit of the invoice's amount digits, relative to whole BTC (10^-3,
// 10^-6, 10^-9, 10^-12), converted straight to msat (1 BTC = 10^11 msat)
const BOLT11_AMOUNT_MSAT_PER_UNIT: Record<string, number> = {
  '': 100_000_000_000,
  m: 100_000_000,
  u: 100_000,
  n: 100,
  p: 0.1
}

// pulls just the amount out of a bolt11 invoice's human-readable part - no
// full bech32/TLV decode needed for that. The bech32 separator is the LAST
// '1' in the string (data characters can also be '1'); everything before it
// is "ln" + network + optional digits + optional multiplier. Null for a
// no-amount invoice or anything that doesn't parse as one.
export const decodeBolt11AmountMsat = (pr: string): number | null => {
  const trimmed = pr.trim().toLowerCase()
  const sep = trimmed.lastIndexOf('1')
  if (sep < 2) return null
  const hrp = trimmed.slice(0, sep)
  const match = hrp.match(/^ln(?:bc|tb|bcrt|tbs|sb)(\d+)?([munp])?$/)
  if (!match) return null
  const [, digits, multiplier] = match
  if (!digits) return null
  const msat = Number(digits) * BOLT11_AMOUNT_MSAT_PER_UNIT[multiplier || '']
  return Number.isInteger(msat) ? msat : null
}
