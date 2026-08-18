import {
  mnemonicToSeedSync,
  generateMnemonic,
  validateMnemonic
} from '@scure/bip39'
import {wordlist} from '@scure/bip39/wordlists/english.js'
import {HDKey, HARDENED_OFFSET} from '@scure/bip32'
import {hmac} from '@noble/hashes/hmac.js'
import {sha256} from '@noble/hashes/sha2.js'
import {secp256k1} from '@noble/curves/secp256k1.js'
import {bytesToHex, hexToBytes, utf8ToBytes} from '@noble/hashes/utils.js'

// The wallet's identity is derived against this fixed domain rather than
// window.location.hostname, so the same seed phrase always yields the same
// linking key (and thus decrypts the same bearer tokens) no matter where
// this static build happens to be hosted - github.io, a mirror, file://.
export const WALLET_DOMAIN = 'lnurlwallet'

export const generateSeedPhrase = (): string => generateMnemonic(wordlist, 128)

export const isValidSeedPhrase = (phrase: string): boolean =>
  validateMnemonic(phrase.trim().toLowerCase(), wordlist)

const readUint32BE = (bytes: Uint8Array, offset: number): number =>
  ((bytes[offset] << 24) |
    (bytes[offset + 1] << 16) |
    (bytes[offset + 2] << 8) |
    bytes[offset + 3]) >>>
  0

// LUD-05: BIP32-based linking-key derivation, same scheme as lnurl_server -
// a seed restored there or here produces the same identity for a given domain
export const deriveLud05LinkingKey = (
  seedPhrase: string,
  domain: string
): Uint8Array => {
  const seed = mnemonicToSeedSync(seedPhrase.trim().toLowerCase())
  const master = HDKey.fromMasterSeed(seed)

  const hashingKeyNode = master.derive("m/138'/0")
  if (!hashingKeyNode.privateKey)
    throw new Error('Could not derive hashing key')
  const suffix = lud05PathSuffix(hashingKeyNode.privateKey, domain)

  // path suffix longs are raw BIP32 child indices: whether each level ends up
  // hardened depends solely on its own magnitude (>= 2^31), never forced
  let node = master.deriveChild(138 + HARDENED_OFFSET)
  for (const index of suffix) {
    node = node.deriveChild(index)
  }
  if (!node.privateKey) throw new Error('Could not derive linking key')
  return node.privateKey
}

// the HMAC half of the derivation, split out so the LUD-05 test vector
// (which starts from a fixed hashingPrivKey, not a seed phrase) can pin it
// directly - see keys.test.ts
export const lud05PathSuffix = (
  hashingKey: Uint8Array,
  domain: string
): number[] => {
  const material = hmac(sha256, hashingKey, utf8ToBytes(domain))
  return [0, 4, 8, 12].map(i => readUint32BE(material, i))
}

export const deriveWalletLinkingKey = (seedPhrase: string): Uint8Array =>
  deriveLud05LinkingKey(seedPhrase, WALLET_DOMAIN)

export const linkingPubKeyHex = (linkingPrivKey: Uint8Array): string =>
  bytesToHex(secp256k1.getPublicKey(linkingPrivKey, true))

// Encrypted-at-rest localStorage secret, same shape as lnurl_server's: the
// stored value is either plaintext or, if the holder opted in with a
// password, AES-GCM ciphertext keyed by a PBKDF2 stretch of that password -
// GCM's auth tag doubles as the "wrong password" check on decrypt.
const PBKDF2_ITERATIONS = 210_000

export type StoredSecret =
  | {enc: false; value: string}
  | {enc: true; salt: string; iv: string; ciphertext: string}

// strict shape check on a StoredSecret - a plaintext form must be exactly a
// 32-byte hex key, an encrypted form must carry hex salt/iv/ciphertext of
// the sizes encryptSecretParts produces. Guards the backup-restore path
// (storage.ts's applyBackup), where a crafted file would otherwise get an
// arbitrary "linking key" installed verbatim.
export const isValidStoredSecret = (
  stored: unknown
): stored is StoredSecret => {
  if (typeof stored !== 'object' || stored === null) return false
  const s = stored as Record<string, unknown>
  if (s.enc === false) {
    return typeof s.value === 'string' && /^[0-9a-f]{64}$/i.test(s.value)
  }
  if (s.enc === true) {
    return (
      typeof s.salt === 'string' &&
      /^[0-9a-f]{32}$/i.test(s.salt) &&
      typeof s.iv === 'string' &&
      /^[0-9a-f]{24}$/i.test(s.iv) &&
      typeof s.ciphertext === 'string' &&
      s.ciphertext.length > 0 &&
      s.ciphertext.length % 2 === 0 &&
      /^[0-9a-f]+$/i.test(s.ciphertext)
    )
  }
  return false
}

const readSecret = (storageKey: string): StoredSecret | null => {
  const raw = localStorage.getItem(storageKey)
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return isValidStoredSecret(parsed) ? parsed : null
  } catch {
    return null
  }
}

const deriveAesKeyFromPassword = (
  password: string,
  salt: Uint8Array
): Promise<CryptoKey> =>
  crypto.subtle
    .importKey('raw', utf8ToBytes(password), 'PBKDF2', false, ['deriveKey'])
    .then(baseKey =>
      crypto.subtle.deriveKey(
        // the copy pins the TS type to Uint8Array<ArrayBuffer> - hexToBytes
        // returns Uint8Array<ArrayBufferLike>, which BufferSource rejects
        {
          name: 'PBKDF2',
          salt: new Uint8Array(salt),
          iterations: PBKDF2_ITERATIONS,
          hash: 'SHA-256'
        },
        baseKey,
        {name: 'AES-GCM', length: 256},
        false,
        ['encrypt', 'decrypt']
      )
    )

export type EncryptedSecretParts = {
  salt: string
  iv: string
  ciphertext: string
}

export const encryptSecretParts = async (
  value: string,
  password: string
): Promise<EncryptedSecretParts> => {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const aesKey = await deriveAesKeyFromPassword(password, salt)
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      {name: 'AES-GCM', iv},
      aesKey,
      utf8ToBytes(value)
    )
  )
  return {
    salt: bytesToHex(salt),
    iv: bytesToHex(iv),
    ciphertext: bytesToHex(ciphertext)
  }
}

// rejects (WebCrypto's own auth-tag check) if the password is wrong
export const decryptSecretParts = async (
  parts: EncryptedSecretParts,
  password: string
): Promise<string> => {
  const salt = hexToBytes(parts.salt)
  const iv = hexToBytes(parts.iv)
  const aesKey = await deriveAesKeyFromPassword(password, salt)
  const plaintext = await crypto.subtle.decrypt(
    {name: 'AES-GCM', iv},
    aesKey,
    hexToBytes(parts.ciphertext)
  )
  return new TextDecoder().decode(plaintext)
}

// The linking key is the only secret this wallet persists - the seed phrase
// it was derived from is shown once at setup and never stored. Everything
// else at rest (the bearer tokens) is encrypted with a key derived from it,
// so protecting this one record with a password protects the whole wallet.
const LINKING_KEY_STORAGE_KEY = 'lnurlwallet_linking_key'

export const savedKeyExists = (): boolean =>
  readSecret(LINKING_KEY_STORAGE_KEY) !== null

export const savedKeyIsEncrypted = (): boolean =>
  readSecret(LINKING_KEY_STORAGE_KEY)?.enc === true

export const getSavedLinkingKeyStored = (): StoredSecret | null =>
  readSecret(LINKING_KEY_STORAGE_KEY)

export const getPlainLinkingKey = (): Uint8Array | null => {
  const stored = readSecret(LINKING_KEY_STORAGE_KEY)
  if (stored === null || stored.enc === true) return null
  return hexToBytes(stored.value)
}

export const saveLinkingKey = async (
  linkingPrivKey: Uint8Array,
  password?: string
): Promise<void> => {
  const hex = bytesToHex(linkingPrivKey)
  if (!password) {
    localStorage.setItem(
      LINKING_KEY_STORAGE_KEY,
      JSON.stringify({enc: false, value: hex})
    )
    return
  }
  const parts = await encryptSecretParts(hex, password)
  localStorage.setItem(
    LINKING_KEY_STORAGE_KEY,
    JSON.stringify({enc: true, ...parts})
  )
}

export const restoreLinkingKeyStored = (stored: StoredSecret): void => {
  localStorage.setItem(LINKING_KEY_STORAGE_KEY, JSON.stringify(stored))
}

export const decryptSavedLinkingKey = async (
  password: string
): Promise<Uint8Array> => {
  const stored = readSecret(LINKING_KEY_STORAGE_KEY)
  if (!stored || !stored.enc) throw new Error('No encrypted linking key saved.')
  return hexToBytes(await decryptSecretParts(stored, password))
}

export const clearSavedLinkingKey = (): void => {
  localStorage.removeItem(LINKING_KEY_STORAGE_KEY)
}

// The bearer-encryption key is derived (not random): sha256 over the linking
// key plus a fixed context string. Deterministic derivation is what makes
// backup/restore work with nothing but the seed phrase - restore the seed on
// a fresh device and every previously exported ciphertext decrypts again.
const BEARER_KEY_CONTEXT = 'lnurlcash-bearer-encryption-v1'

export const deriveBearerAesKey = (
  linkingPrivKey: Uint8Array
): Promise<CryptoKey> => {
  const material = sha256(
    new Uint8Array([...linkingPrivKey, ...utf8ToBytes(BEARER_KEY_CONTEXT)])
  )
  return crypto.subtle.importKey('raw', material, 'AES-GCM', false, [
    'encrypt',
    'decrypt'
  ])
}

export type EncryptedRecordParts = {iv: string; ciphertext: string}

export const encryptRecord = async (
  aesKey: CryptoKey,
  value: object
): Promise<EncryptedRecordParts> => {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      {name: 'AES-GCM', iv},
      aesKey,
      utf8ToBytes(JSON.stringify(value))
    )
  )
  return {iv: bytesToHex(iv), ciphertext: bytesToHex(ciphertext)}
}

export const decryptRecord = async <T>(
  aesKey: CryptoKey,
  parts: EncryptedRecordParts
): Promise<T> => {
  const plaintext = await crypto.subtle.decrypt(
    {name: 'AES-GCM', iv: hexToBytes(parts.iv)},
    aesKey,
    hexToBytes(parts.ciphertext)
  )
  return JSON.parse(new TextDecoder().decode(plaintext)) as T
}
