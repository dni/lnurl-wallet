import toast from 'solid-toast'

export enum NotifyKind {
  SUCCESS = 'success',
  ERROR = 'error',
  LOADING = 'loading'
}

export const notify = (
  message: string,
  _type: NotifyKind | null = null
): void => {
  switch (_type) {
    case NotifyKind.SUCCESS:
      toast.success(message)
      break
    case NotifyKind.ERROR:
      toast.error(message)
      break
    case NotifyKind.LOADING:
      toast.loading(message)
      break
    default:
      toast(message)
  }
}

export const copyToClipboard = (text: string): void => {
  try {
    navigator.clipboard.writeText(text)
    notify('Copied to clipboard!', NotifyKind.SUCCESS)
  } catch (err) {
    notify('Failed to copy to clipboard.', NotifyKind.ERROR)
  }
}

// every caller of this pastes an lnurl/invoice/lightning-address value. A
// `lightning:` URI scheme prefix (how some wallets/QR readers hand these
// off) is always stripped. The rest is lowercased only when it's bech32
// (LNURL, bolt11) or a Lightning Address, both case-insensitive by spec -
// a raw lnurlw://, lnurlp://, lnurlc://, keyauth:// or http(s):// URL
// carries a query string (e.g. a note's own k1 secret) that isn't
// guaranteed to be, so those are left exactly as pasted
const CASE_SENSITIVE_SCHEME = /^(https?|lnurlw|lnurlp|lnurlc|keyauth):\/\//i

export const pasteFromClipboard = async (): Promise<string | null> => {
  try {
    const text = (await navigator.clipboard.readText())
      .trim()
      .replace(/^lightning:/i, '')
    return CASE_SENSITIVE_SCHEME.test(text) ? text : text.toLowerCase()
  } catch (err) {
    notify('Failed to paste from clipboard.', NotifyKind.ERROR)
    return null
  }
}

export const msatToSats = (msat: number): string =>
  (msat / 1000).toLocaleString()

export const satsToMsat = (sats: string | number): number =>
  Math.round(Number(sats) * 1000)

export const formatDate = (ts: number): string => new Date(ts).toLocaleString()

const relativeTimeFormatter = new Intl.RelativeTimeFormat(undefined, {
  numeric: 'auto'
})
const RELATIVE_TIME_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 31536000],
  ['month', 2592000],
  ['week', 604800],
  ['day', 86400],
  ['hour', 3600],
  ['minute', 60]
]

// "5 minutes ago", "yesterday", etc, via the built-in locale-aware
// formatter - always a past timestamp here, so this doesn't handle future
// ones beyond what RelativeTimeFormat does on its own
export const formatRelativeTime = (ts: number): string => {
  const seconds = Math.round((Date.now() - ts) / 1000)
  if (seconds < 5) return 'just now'
  for (const [unit, secondsInUnit] of RELATIVE_TIME_UNITS) {
    if (seconds >= secondsInUnit) {
      return relativeTimeFormatter.format(
        -Math.round(seconds / secondsInUnit),
        unit
      )
    }
  }
  return relativeTimeFormatter.format(-seconds, 'second')
}
