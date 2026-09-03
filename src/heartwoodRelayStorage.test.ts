import {beforeEach, describe, expect, it, vi} from 'vitest'

import {deriveBearerAesKey} from './keys'
import {
  clearHeartwoodRelayLink,
  heartwoodRelayLinkExists,
  loadHeartwoodRelayLink,
  saveHeartwoodRelayLink
} from './heartwoodRelayStorage'

const values = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => void values.set(key, String(value)),
  removeItem: (key: string) => void values.delete(key)
})

const link = {
  devicePubkey: '11'.repeat(32),
  relays: ['wss://relay.example'],
  clientSecretHex: '22'.repeat(32)
}

beforeEach(() => values.clear())

describe('Heartwood relay credential storage', () => {
  it('stores the client key encrypted and recovers it only with this wallet key', async () => {
    const key = await deriveBearerAesKey(new Uint8Array(32).fill(3))
    await saveHeartwoodRelayLink(key, link)
    expect(heartwoodRelayLinkExists()).toBe(true)
    expect([...values.values()].join('')).not.toContain(link.clientSecretHex)
    await expect(loadHeartwoodRelayLink(key)).resolves.toEqual(link)

    const wrong = await deriveBearerAesKey(new Uint8Array(32).fill(4))
    await expect(loadHeartwoodRelayLink(wrong)).rejects.toThrow(
      'cannot be decrypted'
    )
  })

  it('forgets the encrypted pairing record', async () => {
    const key = await deriveBearerAesKey(new Uint8Array(32).fill(3))
    await saveHeartwoodRelayLink(key, link)
    clearHeartwoodRelayLink()
    expect(heartwoodRelayLinkExists()).toBe(false)
    await expect(loadHeartwoodRelayLink(key)).resolves.toBeNull()
  })
})
