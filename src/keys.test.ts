import {describe, expect, it} from 'vitest'
import {bytesToHex, hexToBytes} from '@noble/hashes/utils.js'

import {
  generateSeedPhrase,
  isValidSeedPhrase,
  deriveWalletLinkingKey,
  deriveLud05LinkingKey,
  lud05PathSuffix,
  linkingPubKeyHex,
  encryptSecretParts,
  decryptSecretParts,
  deriveBearerAesKey,
  encryptRecord,
  decryptRecord,
  WALLET_DOMAIN,
  deriveLud25CashRootNode,
  cashRootToHex,
  cashRootFromHex,
  isValidStoredSecret
} from './keys'

// fixed reference vector - the BIP39 test mnemonic
const SEED =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

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

  it('matches the LUD-05 spec test vector', () => {
    // from the spec (luds/05.md): domain site.com, fixed hashingPrivKey ->
    // this exact path suffix - pins the HMAC + big-endian uint32 reading
    // against the spec's own reference, not just self-consistency
    const hashingKey = hexToBytes(
      '7d417a6a5e9a6a4a879aeaba11a11838764c8fa2b959c242d43dea682b3e409b'
    )
    expect(lud05PathSuffix(hashingKey, 'site.com')).toEqual([
      1588488367, 2659270754, 38110259, 4136336762
    ])
  })

  it('differs per domain (unlinkability)', () => {
    expect(bytesToHex(deriveLud05LinkingKey(SEED, 'a.example'))).not.toBe(
      bytesToHex(deriveLud05LinkingKey(SEED, 'b.example'))
    )
  })
})

describe('LUD-25 cash root key derivation', () => {
  it('is deterministic for the same seed, and independent of the linking key', () => {
    const a = deriveLud25CashRootNode(SEED)
    const b = deriveLud25CashRootNode(SEED)
    expect(a.privateKey).toEqual(b.privateKey)
    expect(a.chainCode).toEqual(b.chainCode)
    // own purpose (m/139') - never the same scalar as the LUD-05 linking
    // key's own branch (m/138'), even off the same seed
    expect(bytesToHex(a.privateKey!)).not.toBe(
      bytesToHex(deriveWalletLinkingKey(SEED))
    )
  })

  it('differs for a different seed', () => {
    const other = generateSeedPhrase()
    expect(bytesToHex(deriveLud25CashRootNode(SEED).privateKey!)).not.toBe(
      bytesToHex(deriveLud25CashRootNode(other).privateKey!)
    )
  })

  it('round-trips through the compact hex serialization', () => {
    const node = deriveLud25CashRootNode(SEED)
    const hex = cashRootToHex(node)
    expect(hex).toMatch(/^[0-9a-f]{128}$/)
    const restored = cashRootFromHex(hex)
    expect(restored.privateKey).toEqual(node.privateKey)
    expect(restored.chainCode).toEqual(node.chainCode)
    // the reconstructed node can still derive children - the whole point of
    // keeping the chain code around instead of just the bare private key
    // (see cashSecrets.ts, which is what actually needs this)
    expect(restored.deriveChild(0).privateKey).toEqual(
      node.deriveChild(0).privateKey
    )
  })

  it('rejects a malformed hex blob', () => {
    expect(() => cashRootFromHex('not hex')).toThrow()
    expect(() => cashRootFromHex('aa'.repeat(32))).toThrow() // 32 bytes, needs 64
  })
})

describe('isValidStoredSecret hex length', () => {
  it('defaults to 64 hex chars (linking key)', () => {
    expect(isValidStoredSecret({enc: false, value: 'aa'.repeat(32)})).toBe(true)
    expect(isValidStoredSecret({enc: false, value: 'aa'.repeat(64)})).toBe(
      false
    )
  })

  it('accepts a wider plaintext form when asked (cash root key)', () => {
    expect(isValidStoredSecret({enc: false, value: 'aa'.repeat(64)}, 128)).toBe(
      true
    )
    expect(isValidStoredSecret({enc: false, value: 'aa'.repeat(32)}, 128)).toBe(
      false
    )
  })

  it('the encrypted form is unaffected by hexLength either way', () => {
    const encrypted = {
      enc: true,
      salt: 'aa'.repeat(16),
      iv: 'bb'.repeat(12),
      ciphertext: 'cc'.repeat(32)
    }
    expect(isValidStoredSecret(encrypted)).toBe(true)
    expect(isValidStoredSecret(encrypted, 128)).toBe(true)
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
      url: 'https://mint.example.com/withdraw?k1=s3cr3t&amount=21000',
      callback: 'https://mint.example.com/withdraw/cb',
      amount: 21000,
      verified: true,
      createdAt: 1,
      updatedAt: 2
    }
    const parts = await encryptRecord(aesKey, bearer)
    expect(parts.ciphertext).not.toContain('s3cr3t')
    expect(await decryptRecord(aesKey, parts)).toEqual(bearer)
  })

  it("cannot be decrypted with a different seed's key", async () => {
    const keyA = await deriveBearerAesKey(deriveWalletLinkingKey(SEED))
    const otherSeed = generateSeedPhrase()
    const keyB = await deriveBearerAesKey(deriveWalletLinkingKey(otherSeed))
    const parts = await encryptRecord(keyA, {secret: true})
    await expect(decryptRecord(keyB, parts)).rejects.toThrow()
  })
})
