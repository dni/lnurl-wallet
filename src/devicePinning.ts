import {ed25519} from '@noble/curves/ed25519.js'
import {hexToBytes, utf8ToBytes} from '@noble/hashes/utils.js'

// Trust-on-first-use for a paired vault (lnurl-vault issue #69).
//
// Until the device grew an identity key there was nothing to pin: get_info
// reports fw_version and board, which every unit of a build shares, so a
// swapped or hostile vault answering the same commands was indistinguishable
// from the one paired yesterday. DeviceContext.tsx used to say exactly that,
// and this is what replaces it.
//
// What a pass proves: whatever is answering holds the same key as last time.
// Not who has it, and not that it is safe - someone holding the vault can
// still use it, which is the model. Physical possession is the boundary.

// Must match src/vault/identity.h's IDENTITY_DOMAIN, and the 0x00 separator
// after it. Domain-separated so an identity challenge can never be replayed
// as an OTA approval.
const DOMAIN = 'lnurlvault-id-v1'

// The device refuses anything outside this, so asking for more is asking for
// a bad_request.
export const NONCE_BYTES = 32

const PIN_KEY = 'lnurlvault.pinnedIdentity'

export type PinVerdict =
  // first time this wallet has seen a vault: pin it
  | {kind: 'new'; pubkey: string}
  // same key as last time
  | {kind: 'known'; pubkey: string}
  // a different vault is answering. This is the one that matters
  | {kind: 'changed'; pubkey: string; pinned: string}
  // the device answered, but not with a signature over our nonce
  | {kind: 'invalid'}
  // firmware with no identity at all. Older builds, not a fault
  | {kind: 'unsupported'}

export const identityChallenge = (): string => {
  const bytes = new Uint8Array(NONCE_BYTES)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}

// The exact bytes the device signed: DOMAIN, a 0x00 separator, then the
// nonce. Built here rather than trusted from the device, which is the whole
// point of a challenge.
export const identityMessage = (nonceHex: string): Uint8Array => {
  const domain = utf8ToBytes(DOMAIN)
  const nonce = hexToBytes(nonceHex)
  const message = new Uint8Array(domain.length + 1 + nonce.length)
  message.set(domain, 0)
  message[domain.length] = 0x00
  message.set(nonce, domain.length + 1)
  return message
}

export const verifyIdentity = (
  pubkeyHex: string,
  nonceHex: string,
  sigHex: string
): boolean => {
  try {
    return ed25519.verify(
      hexToBytes(sigHex),
      identityMessage(nonceHex),
      hexToBytes(pubkeyHex)
    )
  } catch {
    // malformed hex, wrong lengths, a point that isn't on the curve
    return false
  }
}

export const readPinnedIdentity = (): string | null => {
  try {
    const raw = localStorage.getItem(PIN_KEY)
    return raw && /^[0-9a-f]{64}$/i.test(raw) ? raw.toLowerCase() : null
  } catch {
    return null
  }
}

export const pinIdentity = (pubkey: string): void => {
  try {
    localStorage.setItem(PIN_KEY, pubkey.toLowerCase())
  } catch {
    // private browsing or quota. Pinning is best-effort: without it the next
    // connect reads as 'new', which warns about nothing rather than wrongly
  }
}

export const forgetPinnedIdentity = (): void => {
  try {
    localStorage.removeItem(PIN_KEY)
  } catch {
    // nothing to do
  }
}

// Decides what a challenge answer means. Pure: takes the answer and the
// stored pin, returns a verdict, writes nothing - so the caller decides
// whether to pin, and the whole table is testable.
export const judgeIdentity = (
  answer: {pubkey: string; sig: string} | null,
  nonceHex: string,
  pinned: string | null
): PinVerdict => {
  if (!answer) return {kind: 'unsupported'}
  if (!verifyIdentity(answer.pubkey, nonceHex, answer.sig)) {
    return {kind: 'invalid'}
  }
  const pubkey = answer.pubkey.toLowerCase()
  if (!pinned) return {kind: 'new', pubkey}
  if (pinned !== pubkey) return {kind: 'changed', pubkey, pinned}
  return {kind: 'known', pubkey}
}

export const identityWarning = (verdict: PinVerdict): string | null => {
  switch (verdict.kind) {
    case 'changed':
      // Deliberately not phrased as "an attack". A wipe destroys the key on
      // purpose, so the honest reading is "this is a different vault", and
      // the owner is the one who knows whether it should be.
      return 'This is not the vault this wallet paired with before. It reports a different identity key, which happens if it was wiped, reflashed with a new key, or is simply another device. If you did not expect that, disconnect and check which device you are holding.'
    case 'invalid':
      return 'This vault could not prove its identity - it answered the challenge with a signature that does not check out. Treat it as untrusted and disconnect.'
    default:
      return null
  }
}
