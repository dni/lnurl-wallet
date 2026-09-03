import {decryptRecord, encryptRecord, type EncryptedRecordParts} from './keys'
import type {HeartwoodRelayLink} from './heartwoodRelayTransport'

const STORAGE_KEY = 'lnurlcash_heartwood_relay'

// Kept local so merely loading the wallet's storage layer does not eagerly
// pull the Nostr relay client into the main application bundle.
const isStoredLink = (value: unknown): value is HeartwoodRelayLink => {
  const link = value as HeartwoodRelayLink | null
  return (
    !!link &&
    /^[0-9a-f]{64}$/i.test(link.devicePubkey) &&
    /^[0-9a-f]{64}$/i.test(link.clientSecretHex) &&
    Array.isArray(link.relays) &&
    link.relays.length > 0 &&
    link.relays.every(
      relay => typeof relay === 'string' && /^wss:\/\//i.test(relay)
    )
  )
}

export const heartwoodRelayLinkExists = (): boolean => {
  try {
    return localStorage.getItem(STORAGE_KEY) !== null
  } catch {
    return false
  }
}

export const saveHeartwoodRelayLink = async (
  aesKey: CryptoKey,
  link: HeartwoodRelayLink
): Promise<void> => {
  if (!isStoredLink(link)) throw new Error('Heartwood pairing is invalid.')
  const encrypted = await encryptRecord(aesKey, link)
  localStorage.setItem(STORAGE_KEY, JSON.stringify(encrypted))
}

export const loadHeartwoodRelayLink = async (
  aesKey: CryptoKey
): Promise<HeartwoodRelayLink | null> => {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) return null
  let encrypted: EncryptedRecordParts
  try {
    encrypted = JSON.parse(raw) as EncryptedRecordParts
  } catch {
    throw new Error('Saved Heartwood pairing is damaged.')
  }
  const link = await decryptRecord<unknown>(aesKey, encrypted).catch(() => {
    throw new Error(
      'Saved Heartwood pairing cannot be decrypted by this wallet.'
    )
  })
  if (!isStoredLink(link))
    throw new Error('Saved Heartwood pairing is invalid.')
  return link
}

export const clearHeartwoodRelayLink = (): void => {
  localStorage.removeItem(STORAGE_KEY)
}
