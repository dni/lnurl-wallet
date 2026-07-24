import {bech32} from '@scure/base'

// LNURLcash: a bearer token is - in LUD-01 spirit - just a bech32-encoded
// URL, prefixed `lnurlcash1`. The URL embeds the bearer secret in its path
// (https://server/lnurlcash/{secret}); whoever holds the token controls the
// balance behind it. Every operation is a GET on that URL:
//
//   GET url                                  -> {tag: 'cashRequest', amount, pending?}
//   GET url?action=melt&pr={bolt11}          -> {status: 'OK'}
//   GET url?action=split&amount={msat}       -> {tokens: [t1, t2]}
//   GET url?action=transfer                  -> {token}   (rotates the secret)
//   GET url?action=combine&tokens={t2,t3..}  -> {token}   (same server only)
//   GET {server}/lnurlcash/mint?amount=msat  -> {token, pr}
//
// Errors follow LNURL convention: {status: 'ERROR', reason}.

const HRP = 'lnurlcash'
const PREFIX = 'LNURLCASH1'

export const isCashToken = (data: string): boolean =>
  data.trim().toUpperCase().startsWith(PREFIX)

export const encodeCashToken = (url: string): string => {
  const bytes = new TextEncoder().encode(url)
  return bech32.encode(HRP, bech32.toWords(bytes), 2048).toUpperCase()
}

export const decodeCashToken = (token: string): string | null => {
  const safe = token.trim().toUpperCase()
  if (!safe.startsWith(PREFIX)) return null
  try {
    const decoded = bech32.decode(
      `${PREFIX}${safe.slice(PREFIX.length)}` as `${string}1${string}`,
      2048
    )
    return new TextDecoder().decode(bech32.fromWords(decoded.words))
  } catch {
    return null
  }
}

// mirrors lnurl_server's INSECURE_HOSTS: these (plus .onion) resolve to
// http:// instead of https:// for raw scheme input
const INSECURE_HOSTS = ['127.0.0.1', '0.0.0.0', 'localhost']

const isInsecureHost = (host: string): boolean =>
  INSECURE_HOSTS.includes(host) || host.endsWith('.onion')

// resolves arbitrary input - bech32 lnurlcash1 token, LUD-17-style
// lnurlcash:// URL, or a plain http(s) URL - to the fetchable token URL
export const resolveCashInput = (value: string): string | null => {
  const trimmed = value.trim()
  if (isCashToken(trimmed)) return decodeCashToken(trimmed)
  const lud17 = trimmed.match(/^lnurlcash:\/\/([^/]+)(\/.*)?$/i)
  if (lud17) {
    const scheme = isInsecureHost(lud17[1].split(':')[0]) ? 'http' : 'https'
    return trimmed.replace(/^lnurlcash:\/\//i, `${scheme}://`)
  }
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  return null
}

export const isValidCashInput = (value: string): boolean =>
  resolveCashInput(value) !== null

export const serverOf = (url: string): string => {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

export type CashStatus = {
  tag: 'cashRequest'
  amount: number
  pending?: boolean
}

const cashFetch = async (url: string | URL): Promise<any> => {
  let res: Response
  try {
    res = await fetch(url.toString())
  } catch {
    throw new Error(
      'Failed to reach the server - it may be offline or not allow cross-origin requests.'
    )
  }
  const body = await res.json().catch(() => {
    throw new Error('Server returned an invalid response.')
  })
  if (body?.status === 'ERROR') {
    throw new Error(body.reason || 'Unknown server error.')
  }
  return body
}

// balance / validity check - the token URL's plain GET response
export const fetchCashStatus = async (url: string): Promise<CashStatus> => {
  const body = await cashFetch(url)
  if (body?.tag !== 'cashRequest' || typeof body.amount !== 'number') {
    throw new Error('Not an LNURLcash token (unexpected response).')
  }
  return body as CashStatus
}

// asks a server to mint a fresh bearer of `amountMsat`: the returned token
// exists immediately but stays pending until the returned bolt11 is paid
export const mintCash = async (
  server: string,
  amountMsat: number
): Promise<{token: string; pr: string}> => {
  const base = /^https?:\/\//i.test(server)
    ? server
    : `${isInsecureHost(server.split(':')[0]) ? 'http' : 'https'}://${server}`
  const mintUrl = new URL(`${base.replace(/\/$/, '')}/lnurlcash/mint`)
  mintUrl.searchParams.set('amount', String(amountMsat))
  const body = await cashFetch(mintUrl)
  if (typeof body?.token !== 'string' || typeof body?.pr !== 'string') {
    throw new Error('Server did not return a token and invoice.')
  }
  return {token: body.token, pr: body.pr}
}

// melts the bearer into a bolt11 payment - the server pays `pr` and the
// token is spent
export const meltCash = async (url: string, pr: string): Promise<void> => {
  const cbUrl = new URL(url)
  cbUrl.searchParams.set('action', 'melt')
  cbUrl.searchParams.set('pr', pr.trim())
  const body = await cashFetch(cbUrl)
  if (body?.status !== 'OK') {
    throw new Error('Melt was not confirmed by the server.')
  }
}

// splits the bearer in two: one of `amountMsat`, one with the remainder -
// both fresh tokens, the original is invalidated
export const splitCash = async (
  url: string,
  amountMsat: number
): Promise<string[]> => {
  const cbUrl = new URL(url)
  cbUrl.searchParams.set('action', 'split')
  cbUrl.searchParams.set('amount', String(amountMsat))
  const body = await cashFetch(cbUrl)
  if (!Array.isArray(body?.tokens) || body.tokens.length < 2) {
    throw new Error('Server did not return the split tokens.')
  }
  return body.tokens as string[]
}

// rotates the bearer secret: the returned fresh token replaces this one,
// which becomes invalid - hand the new token to the recipient
export const transferCash = async (url: string): Promise<string> => {
  const cbUrl = new URL(url)
  cbUrl.searchParams.set('action', 'transfer')
  const body = await cashFetch(cbUrl)
  if (typeof body?.token !== 'string') {
    throw new Error('Server did not return a new token.')
  }
  return body.token
}

// merges other bearers of the same server into this one - all inputs are
// invalidated, one fresh token with the combined amount comes back
export const combineCash = async (
  url: string,
  otherTokens: string[]
): Promise<string> => {
  const cbUrl = new URL(url)
  cbUrl.searchParams.set('action', 'combine')
  cbUrl.searchParams.set('tokens', otherTokens.join(','))
  const body = await cashFetch(cbUrl)
  if (typeof body?.token !== 'string') {
    throw new Error('Server did not return a combined token.')
  }
  return body.token
}
