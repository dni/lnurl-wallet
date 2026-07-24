import {describe, expect, it} from 'vitest'
import {bytesToHex} from '@noble/hashes/utils.js'

import {
  generateSeedPhrase,
  isValidSeedPhrase,
  deriveWalletLinkingKey,
  deriveLud05LinkingKey,
  linkingPubKeyHex,
  encryptSecretParts,
  decryptSecretParts,
  deriveBearerAesKey,
  encryptRecord,
  decryptRecord,
  WALLET_DOMAIN
} from './keys'

// fixed reference vector - the BIP39 test mnemonic
const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

describe('seed phrase', () => {
  it('generates a valid 12-word mnemonic', () => {
    const phrase = generateSeedPhrase()
    expect(phrase.split(' ')).toHaveLength(12)
    expect(isValidSeedPhrase(phrase)).toBe(true)
  })

  it('validates case- and whitespace-insensitively', () => {
    expect(isValidSeedPhrase(`  ${SEED.toUpperCase()}  `)).toBe(true)
    expect(isValidSeedPhrase('definitely not a seed')).toBe(false)
  })
})

describe('linking key derivation', () => {
  it('is deterministic for the same seed', () => {
    const a = deriveWalletLinkingKey(SEED)
    const b = deriveWalletLinkingKey(SEED)
    expect(bytesToHex(a)).toBe(bytesToHex(b))
    expect(a).toHaveLength(32)
    expect(linkingPubKeyHex(a)).toMatch(/^0[23][0-9a-f]{64}$/)
  })

  it('matches the generic LUD-05 derivation for the wallet domain', () => {
    expect(bytesToHex(deriveWalletLinkingKey(SEED))).toBe(
      bytesToHex(deriveLud05LinkingKey(SEED, WALLET_DOMAIN))
    )
  })

  it('differs per domain (unlinkability)', () => {
    expect(bytesToHex(deriveLud05LinkingKey(SEED, 'a.example'))).not.toBe(
      bytesToHex(deriveLud05LinkingKey(SEED, 'b.example'))
    )
  })
})

describe('password-encrypted secret parts', () => {
  it('round-trips and rejects a wrong password', async () => {
    const parts = await encryptSecretParts('super secret value', 'hunter2')
    expect(await decryptSecretParts(parts, 'hunter2')).toBe(
      'super secret value'
    )
    await expect(decryptSecretParts(parts, 'wrong')).rejects.toThrow()
  })
})

describe('bearer record encryption', () => {
  it('round-trips a bearer with the seed-derived AES key', async () => {
    const aesKey = await deriveBearerAesKey(deriveWalletLinkingKey(SEED))
    const bearer = {
      url: 'https://cash.example.com/lnurlcash/s3cr3t',
      amount: 21000,
      pending: false,
      createdAt: 1,
      updatedAt: 2
    }
    const parts = await encryptRecord(aesKey, bearer)
    expect(parts.ciphertext).not.toContain('s3cr3t')
    expect(await decryptRecord(aesKey, parts)).toEqual(bearer)
  })

  it('cannot be decrypted with a different seed\'s key', async () => {
    const keyA = await deriveBearerAesKey(deriveWalletLinkingKey(SEED))
    const otherSeed = generateSeedPhrase()
    const keyB = await deriveBearerAesKey(deriveWalletLinkingKey(otherSeed))
    const parts = await encryptRecord(keyA, {secret: true})
    await expect(decryptRecord(keyB, parts)).rejects.toThrow()
  })
})
