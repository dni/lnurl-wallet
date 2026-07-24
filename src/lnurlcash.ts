import {bech32} from '@scure/base'
import {sha256} from '@noble/hashes/sha2.js'
import {bytesToHex, hexToBytes} from '@noble/hashes/utils.js'

// LUD-XX LNURLcash - bearer assets (draft, see luds/XX.md).
//
// A bearer note is an ordinary LUD-03 withdrawRequest link whose k1 *is*
// the asset: lnurlw://host/path?k1=<secret>, encodable as a plain bech32
// LNURL. No new endpoint, no new encoding. A GET on the note's LNURL is
// purely informational (never burns); every mutating operation goes to the
// `callback` URL from the withdrawRequest JSON:
//
//   callback?k1=X&pr=<bolt11>       melt: X burned, pr paid (plain LUD-03)
//   callback?k1=X&k1=Y&pr=<bolt11>  merged melt: all burned, pr of combined value paid
//   callback?k1=X                   rotate: X burned, {..., k1: X'} minted, same value
//   callback?k1=X&amount=<msat>     split: X burned, {..., k1, change} minted
//   callback?k1=X&k1=Y..            merge: all burned, {..., k1} worth their sum
//
// Minting: a LUD-06 payRequest may advertise `withdrawLink` (raw LUD-17
// URL of the withdraw endpoint) - the payment preimage of its paid invoice
// becomes a valid k1 there, so withdrawLink + ?k1=<preimage> is the note.

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

// input only qualifies as a bearer note if it resolves to a URL carrying k1
export const resolveNoteInput = (value: string): string | null => {
  const url = resolveLnurlInput(value)
  if (!url || !noteK1(url)) return null
  return url
}

export const isValidNoteInput = (value: string): boolean =>
  resolveNoteInput(value) !== null

// withdrawLink (raw LUD-17 URL of the withdraw endpoint) + a secret -> note
export const buildNoteUrl = (withdrawLink: string, k1: string): string => {
  const url = new URL(fromLud17(withdrawLink.trim()))
  url.searchParams.set('k1', k1.trim().toLowerCase())
  return url.toString()
}

// the same note with its secret swapped out - after rotate/split/merge
export const withNewK1 = (url: string, k1: string): string => {
  const newUrl = new URL(url)
  newUrl.searchParams.delete('id')
  newUrl.searchParams.set('k1', k1)
  return newUrl.toString()
}

// every k1 this scheme mints is 32 bytes hex (a payment preimage or the
// service's own urandom) - the id lookup below is only defined for those
const K1_HEX = /^[0-9a-f]{64}$/

// the same note addressed by hash instead of secret - the informational
// lookup that keeps the secret off the wire (SERVICE MAY support this).
// id = sha256 over the raw k1 *bytes* (for a minted note that is exactly
// the payment hash of the funding invoice). null when k1 isn't 32-byte hex.
export const noteIdUrl = (url: string): string | null => {
  const k1 = noteK1(url)
  if (!k1 || !K1_HEX.test(k1)) return null
  const idUrl = new URL(url)
  idUrl.searchParams.delete('k1')
  idUrl.searchParams.set('id', bytesToHex(sha256(hexToBytes(k1))))
  return idUrl.toString()
}

export const serverOf = (url: string): string => {
  try {
    return new URL(url).host
  } catch {
    return url
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
}

// the informational GET (LUD-03 step 1) - never burns, rotates or alters
// the note. `url` is the note's LNURL (?k1=) or its ?id= hash form.
export const fetchNoteInfo = async (
  url: string
): Promise<WithdrawRequestInfo> => {
  const body = await lnurlFetch(url)
  if (
    body?.tag !== 'withdrawRequest' ||
    typeof body.callback !== 'string' ||
    typeof body.maxWithdrawable !== 'number'
  ) {
    throw new Error('Not a withdrawRequest (unexpected response).')
  }
  return body as WithdrawRequestInfo
}

// prefers the ?id= hash lookup (secret never leaves the device) and only
// falls back to the plain ?k1= GET when the service rejects the id form -
// callers that keep holding the note after a k1 GET should rotate it, per
// the spec's exposure guidance
export const fetchNoteInfoSafe = async (
  url: string
): Promise<{info: WithdrawRequestInfo; secretExposed: boolean}> => {
  const idUrl = noteIdUrl(url)
  if (idUrl) {
    try {
      return {info: await fetchNoteInfo(idUrl), secretExposed: false}
    } catch {
      // service may not support the optional id lookup - fall through
    }
  }
  return {info: await fetchNoteInfo(url), secretExposed: true}
}

export type WithdrawSuccessResponse = {
  status: 'OK'
  k1?: string
  change?: string
}

const callbackRequest = async (
  callback: string,
  params: [string, string][]
): Promise<WithdrawSuccessResponse> => {
  const cbUrl = new URL(callback)
  // append (not set): merge and merged melt repeat the k1 param
  for (const [key, value] of params) cbUrl.searchParams.append(key, value)
  const body = await lnurlFetch(cbUrl)
  if (body?.status !== 'OK') {
    throw new Error('Operation was not confirmed by the service.')
  }
  return body as WithdrawSuccessResponse
}

// melt: burn the given note(s), the service pays `pr`. With several k1s the
// invoice must be of exactly their combined value - split first to melt less.
export const meltNotes = async (
  callback: string,
  k1s: string[],
  pr: string
): Promise<void> => {
  await callbackRequest(callback, [
    ...k1s.map((k1): [string, string] => ['k1', k1]),
    ['pr', pr.trim()]
  ])
}

// rotate: burn k1, get a fresh secret of the same value - closes the window
// in which any previous holder (or logged URL) could redeem the note
export const rotateNote = async (
  callback: string,
  k1: string
): Promise<string> => {
  const body = await callbackRequest(callback, [['k1', k1]])
  if (typeof body.k1 !== 'string') {
    throw new Error('Service did not return a replacement secret.')
  }
  return body.k1
}

// split: burn k1, mint one note worth `amountMsat` (response k1) and one
// carrying the remainder (response change)
export const splitNote = async (
  callback: string,
  k1: string,
  amountMsat: number
): Promise<{k1: string; change: string}> => {
  const body = await callbackRequest(callback, [
    ['k1', k1],
    ['amount', String(amountMsat)]
  ])
  if (typeof body.k1 !== 'string' || typeof body.change !== 'string') {
    throw new Error('Service did not return the split notes.')
  }
  return {k1: body.k1, change: body.change}
}

// merge: burn all given notes, mint one worth their sum
export const mergeNotes = async (
  callback: string,
  k1s: string[]
): Promise<string> => {
  const body = await callbackRequest(
    callback,
    k1s.map((k1): [string, string] => ['k1', k1])
  )
  if (typeof body.k1 !== 'string') {
    throw new Error('Service did not return a merged secret.')
  }
  return body.k1
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
