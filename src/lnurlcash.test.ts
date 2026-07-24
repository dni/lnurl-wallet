import {describe, expect, it} from 'vitest'

import {
  encodeCashToken,
  decodeCashToken,
  isCashToken,
  isValidCashInput,
  resolveCashInput,
  serverOf
} from './lnurlcash'

const URL_FIXTURE = 'https://cash.example.com/lnurlcash/s3cr3t-bearer-id'

describe('lnurlcash token codec', () => {
  it('round-trips a token URL through bech32', () => {
    const token = encodeCashToken(URL_FIXTURE)
    expect(token.startsWith('LNURLCASH1')).toBe(true)
    expect(decodeCashToken(token)).toBe(URL_FIXTURE)
  })

  it('accepts lowercase and surrounding whitespace', () => {
    const token = encodeCashToken(URL_FIXTURE)
    expect(decodeCashToken(`  ${token.toLowerCase()}  `)).toBe(URL_FIXTURE)
  })

  it('rejects non-lnurlcash bech32', () => {
    expect(decodeCashToken('LNURL1DP68GURN8GHJ7MRWW4EXCTNZD9NHXATW9EU8J730D3H82UNVWQHKGETNW3EZUCNPDEJZ7VTNV4SKG')).toBeNull()
    expect(isCashToken('LNURL1ABC')).toBe(false)
    expect(decodeCashToken('LNURLCASH1notbech32!!!')).toBeNull()
  })

  it('resolves all accepted input forms to the token URL', () => {
    const token = encodeCashToken(URL_FIXTURE)
    expect(resolveCashInput(token)).toBe(URL_FIXTURE)
    expect(resolveCashInput(URL_FIXTURE)).toBe(URL_FIXTURE)
    expect(
      resolveCashInput('lnurlcash://cash.example.com/lnurlcash/s3cr3t-bearer-id')
    ).toBe(URL_FIXTURE)
    // insecure hosts resolve the LUD-17-style scheme to http
    expect(resolveCashInput('lnurlcash://localhost:8000/lnurlcash/abc')).toBe(
      'http://localhost:8000/lnurlcash/abc'
    )
    expect(resolveCashInput('not a token')).toBeNull()
    expect(isValidCashInput(token)).toBe(true)
    expect(isValidCashInput('you@example.com')).toBe(false)
  })

  it('extracts the issuing server host', () => {
    expect(serverOf(URL_FIXTURE)).toBe('cash.example.com')
    expect(serverOf('http://localhost:8000/lnurlcash/abc')).toBe(
      'localhost:8000'
    )
  })
})
