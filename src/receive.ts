import {resolveCashInput, fetchCashStatus} from './lnurlcash'
import type {Bearer} from './storage'

// shared by Scan and Paste: resolve whatever came in to a token URL, ask the
// issuing server what it is worth, and hand back what to store. Returns the
// url even when the status fetch fails - a bearer is better stored unverified
// than dropped.
export type ReceivedCash = {
  url: string
  amount: number
  pending: boolean
  verified: boolean
}

export const receiveCash = async (
  input: string,
  existing: Bearer[]
): Promise<ReceivedCash> => {
  const url = resolveCashInput(input)
  if (!url) {
    throw new Error('Not an LNURLcash token.')
  }
  if (existing.some(b => b.url === url)) {
    throw new Error('This bearer is already in your wallet.')
  }
  try {
    const status = await fetchCashStatus(url)
    return {
      url,
      amount: status.amount,
      pending: status.pending === true,
      verified: true
    }
  } catch {
    return {url, amount: 0, pending: false, verified: false}
  }
}
