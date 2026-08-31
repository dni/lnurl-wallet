import type {InvoiceResult, MintFee, PayRequestInfo} from './lnurlcash'

// Secret-free recovery record for the one invoice currently bound to a
// vault-generated output. The raw k1 remains on the device; this stores only
// public identifiers, the quote, and the mint key needed to authenticate its
// receipt. Persisting before the invoice is rendered closes the reload gap
// between payment and device confirmation.
export type PendingDeviceMint = {
  version: 1
  deviceId: string
  h: string
  mintInput: string
  payRequest: PayRequestInfo
  invoice: InvoiceResult & {verify: string}
  grossMsat: number
  amountMsat: number
  mintPubkey: string
  createdAt: number
}

const STORAGE_KEY = 'lnurlcash_pending_device_mint'
const HEX_32 = /^[0-9a-f]{64}$/
const DEVICE_ID = /^[0-9a-f]{8}$/
const PUBKEY = /^[0-9a-f]{66}$/

const positiveSafeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0

const parseFee = (value: unknown): MintFee | undefined => {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  if (
    !Number.isSafeInteger(raw.baseFeeMsat) ||
    !Number.isSafeInteger(raw.feePpm)
  ) {
    return undefined
  }
  return {
    baseFeeMsat: raw.baseFeeMsat as number,
    feePpm: raw.feePpm as number
  }
}

const parsePending = (value: unknown): PendingDeviceMint | null => {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, any>
  const pay = raw.payRequest
  const invoice = raw.invoice
  if (
    raw.version !== 1 ||
    typeof raw.deviceId !== 'string' ||
    !DEVICE_ID.test(raw.deviceId.toLowerCase()) ||
    typeof raw.h !== 'string' ||
    !HEX_32.test(raw.h.toLowerCase()) ||
    typeof raw.mintInput !== 'string' ||
    !pay ||
    pay.tag !== 'payRequest' ||
    typeof pay.callback !== 'string' ||
    typeof pay.withdrawLink !== 'string' ||
    typeof pay.metadata !== 'string' ||
    !positiveSafeInteger(pay.minSendable) ||
    !positiveSafeInteger(pay.maxSendable) ||
    !invoice ||
    typeof invoice.pr !== 'string' ||
    typeof invoice.verify !== 'string' ||
    invoice.mintToHash !== true ||
    !invoice.mint ||
    typeof invoice.mint.h !== 'string' ||
    invoice.mint.h.toLowerCase() !== raw.h.toLowerCase() ||
    !positiveSafeInteger(invoice.mint.amountMsat) ||
    invoice.mint.signature !== undefined ||
    !positiveSafeInteger(raw.grossMsat) ||
    !positiveSafeInteger(raw.amountMsat) ||
    raw.amountMsat !== invoice.mint.amountMsat ||
    typeof raw.mintPubkey !== 'string' ||
    !PUBKEY.test(raw.mintPubkey.toLowerCase()) ||
    !positiveSafeInteger(raw.createdAt)
  ) {
    return null
  }
  return {
    version: 1,
    deviceId: raw.deviceId.toLowerCase(),
    h: raw.h.toLowerCase(),
    mintInput: raw.mintInput,
    payRequest: {
      ...pay,
      mintToHash: pay.mintToHash === true,
      commentAllowed:
        typeof pay.commentAllowed === 'number' ? pay.commentAllowed : undefined,
      mintFee: parseFee(pay.mintFee)
    },
    invoice: {
      pr: invoice.pr,
      verify: invoice.verify,
      disposable: invoice.disposable !== false,
      mintToHash: true,
      mint: {
        h: raw.h.toLowerCase(),
        amountMsat: invoice.mint.amountMsat
      }
    },
    grossMsat: raw.grossMsat,
    amountMsat: raw.amountMsat,
    mintPubkey: raw.mintPubkey.toLowerCase(),
    createdAt: raw.createdAt
  }
}

export const readPendingDeviceMint = (): PendingDeviceMint | null => {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (!stored) return null
    return parsePending(JSON.parse(stored))
  } catch {
    return null
  }
}

export const savePendingDeviceMint = (pending: PendingDeviceMint): void => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(pending))
}

export const clearPendingDeviceMint = (): void => {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // No browser storage (plain Node tests) or a blocked storage area.
  }
}
