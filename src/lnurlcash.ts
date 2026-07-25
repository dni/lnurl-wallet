import {bech32} from '@scure/base'
import {sha256} from '@noble/hashes/sha2.js'
import {secp256k1} from '@noble/curves/secp256k1.js'
import {bytesToHex, hexToBytes, utf8ToBytes} from '@noble/hashes/utils.js'

// LUD-XX LNURLcash - bearer assets (draft, see luds/XX.md).
//
// A bearer note is an ordinary LUD-03 withdrawRequest link whose k1 *is*
// the asset: lnurlw://host/path?k1=<secret>&amount=<msat>, encodable as a
// plain bech32 LNURL. No new endpoint, no new encoding. A GET on the note's
// LNURL is purely informational (never burns; `amount` is ignored there -
// it's a claim by whoever encoded the note, the authoritative value is
// always maxWithdrawable). Every mutating operation goes to the `callback`
// URL from the withdrawRequest JSON:
//
//   callback?k1=X&pr=<bolt11>    melt: X burned, pr (of exactly its value) paid
//   callback?k1=X                rotate: X burned, {..., k1: X'} minted, same value
//   callback?k1=X&amount=<msat>  split: X burned, {..., k1, change} minted
//   callback?k1=X&k1=Y..         merge: all burned, {..., k1} worth their sum
//
// (multiple k1 + pr - "merged melt" - was removed from the spec: merge
// first to melt several notes in one payment.)
//
// Minting: a LUD-06 payRequest may advertise `withdrawLink` (raw LUD-17 URL
// of the withdraw endpoint) - the payment preimage of its paid invoice
// becomes a valid k1 there, so withdrawLink?k1=<preimage>&amount=<msat> is
// the note.
//
// Offline verification (optional): a SERVICE MAY publish a `mintPubkey`
// (33-byte compressed secp256k1, hex) and sign rotated/split/merged notes,
// letting a holder verify issuer+amount without contacting SERVICE. See
// verifyNoteSignature below.

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
const isEmail = (value: string): boolean =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)

const lnAddressToUrl = (address: string): string => {
  const [name, domain] = address.trim().split('@')
  const scheme = isInsecureHost(domain) ? 'http' : 'https'
  return `${scheme}://${domain}/.well-known/lnurlp/${name}`
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
  if (isEmail(trimmed)) return lnAddressToUrl(trimmed)
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
// -> note. `amountMsat` is the declared value (see noteDeclaredAmount).
export const buildNoteUrl = (
  withdrawLink: string,
  k1: string,
  amountMsat: number
): string => {
  const url = new URL(fromLud17(withdrawLink.trim()))
  url.searchParams.set('k1', k1.trim().toLowerCase())
  url.searchParams.set('amount', String(amountMsat))
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

export const serverOf = (url: string): string => {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

// ---- offline verification (optional) ----

// msg = sha256("LNURLcash/note" || uint64_be(amount_msat) || sha256(k1))
const NOTE_SIG_DOMAIN = utf8ToBytes('LNURLcash/note')

const uint64be = (n: number): Uint8Array => {
  const bytes = new Uint8Array(8)
  new DataView(bytes.buffer).setBigUint64(0, BigInt(n), false)
  return bytes
}

const noteSignatureMessage = (k1: string, amountMsat: number): Uint8Array =>
  sha256(
    new Uint8Array([
      ...NOTE_SIG_DOMAIN,
      ...uint64be(amountMsat),
      ...sha256(hexToBytes(k1))
    ])
  )

// recovers the signer's pubkey from (k1, amountMsat, signature) and checks
// it against `mintPubkey` - true only if both match. `signature` is the
// spec's 65-byte recoverable form (recovery id || r || s, hex).
export const verifyNoteSignature = (
  k1: string,
  amountMsat: number,
  signatureHex: string,
  mintPubkeyHex: string
): boolean => {
  try {
    const msg = noteSignatureMessage(k1, amountMsat)
    const recovered = secp256k1.recoverPublicKey(
      hexToBytes(signatureHex),
      msg
    )
    return bytesToHex(recovered) === mintPubkeyHex.toLowerCase()
  } catch {
    return false
  }
}

// ---- protocol requests ----

const lnurlFetch = async (url: string | URL): Promise<any> => {
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
// the note. Per spec this always exposes k1 on the wire now (the optional
// hash-based lookup was dropped) - callers that keep holding the note
// afterward SHOULD rotate it (see receive.ts / BearerCard's refresh).
export const fetchNoteInfo = async (
  url: string
): Promise<WithdrawRequestInfo> => {
  const body = await lnurlFetch(url)
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

export type WithdrawSuccessResponse = {
  status: 'OK'
  k1?: string
  change?: string
  signature?: string
  changeSignature?: string
}

const callbackRequest = async (
  callback: string,
  params: [string, string][]
): Promise<WithdrawSuccessResponse> => {
  const cbUrl = new URL(callback)
  // append (not set): merge repeats the k1 param
  for (const [key, value] of params) cbUrl.searchParams.append(key, value)
  const body = await lnurlFetch(cbUrl)
  if (body?.status !== 'OK') {
    throw new Error('Operation was not confirmed by the service.')
  }
  return body as WithdrawSuccessResponse
}

// melt: burn a single note, the service pays `pr` of exactly its value -
// merge first to melt several notes in one payment (the spec dropped
// multi-k1 melt).
export const meltNote = async (
  callback: string,
  k1: string,
  pr: string
): Promise<void> => {
  await callbackRequest(callback, [
    ['k1', k1],
    ['pr', pr.trim()]
  ])
}

export type RotateResult = {k1: string; signature?: string}

// rotate: burn k1, get a fresh secret of the same value - closes the window
// in which any previous holder (or logged URL) could redeem the note. Also
// how a wallet obtains a compact, offline-verifiable copy of a note that
// doesn't have one yet (e.g. straight after minting).
export const rotateNote = async (
  callback: string,
  k1: string
): Promise<RotateResult> => {
  const body = await callbackRequest(callback, [['k1', k1]])
  if (typeof body.k1 !== 'string') {
    throw new Error('Service did not return a replacement secret.')
  }
  return {k1: body.k1, signature: body.signature}
}

export type SplitResult = {
  k1: string
  signature?: string
  change: string
  changeSignature?: string
}

// split: burn k1, mint one note worth `amountMsat` (response k1) and one
// carrying the remainder (response change)
export const splitNote = async (
  callback: string,
  k1: string,
  amountMsat: number
): Promise<SplitResult> => {
  const body = await callbackRequest(callback, [
    ['k1', k1],
    ['amount', String(amountMsat)]
  ])
  if (typeof body.k1 !== 'string' || typeof body.change !== 'string') {
    throw new Error('Service did not return the split notes.')
  }
  return {
    k1: body.k1,
    signature: body.signature,
    change: body.change,
    changeSignature: body.changeSignature
  }
}

// merge: burn all given notes, mint one worth their sum
export const mergeNotes = async (
  callback: string,
  k1s: string[]
): Promise<RotateResult> => {
  const body = await callbackRequest(
    callback,
    k1s.map((k1): [string, string] => ['k1', k1])
  )
  if (typeof body.k1 !== 'string') {
    throw new Error('Service did not return a merged secret.')
  }
  return {k1: body.k1, signature: body.signature}
}

// ---- minting via LUD-06 payRequest ----

export type PayRequestInfo = {
  tag: 'payRequest'
  callback: string
  minSendable: number
  maxSendable: number
  metadata: string
  // LUD-XX: present when paying this mints a bearer note - the payment
  // preimage becomes a valid k1 at this (raw LUD-17) withdraw endpoint
  withdrawLink?: string
  mintPubkey?: string
}

export const fetchPayRequest = async (url: string): Promise<PayRequestInfo> => {
  const body = await lnurlFetch(url)
  if (body?.tag !== 'payRequest' || typeof body.callback !== 'string') {
    throw new Error('Not a payRequest (unexpected response).')
  }
  return body as PayRequestInfo
}

export const requestInvoice = async (
  payCallback: string,
  amountMsat: number
): Promise<string> => {
  const cbUrl = new URL(payCallback)
  cbUrl.searchParams.set('amount', String(amountMsat))
  const body = await lnurlFetch(cbUrl)
  if (typeof body?.pr !== 'string') {
    throw new Error('Service did not return an invoice.')
  }
  return body.pr
}

// a payment preimage (the future k1): 32 bytes hex
export const isPreimage = (value: string): boolean =>
  /^[0-9a-fA-F]{64}$/.test(value.trim())
