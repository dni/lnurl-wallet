import {beforeEach, describe, expect, it, vi} from 'vitest'

import {
  clearPendingDeviceMint,
  readPendingDeviceMint,
  savePendingDeviceMint,
  type PendingDeviceMint
} from './pendingDeviceMint'

const record = (): PendingDeviceMint => ({
  version: 1,
  deviceId: 'deadbeef',
  h: 'ab'.repeat(32),
  mintInput: 'mint@example.com',
  payRequest: {
    tag: 'payRequest',
    callback: 'https://mint.example/p/cb',
    minSendable: 1000,
    maxSendable: 1000000,
    metadata: '[]',
    withdrawLink: 'https://mint.example/w',
    commentAllowed: 64,
    mintToHash: true
  },
  invoice: {
    pr: 'lnbc1bound',
    verify: 'https://mint.example/verify/1',
    disposable: false,
    mintToHash: true,
    mint: {h: 'ab'.repeat(32), amountMsat: 21000}
  },
  grossMsat: 22000,
  amountMsat: 21000,
  mintPubkey: '02' + 'cd'.repeat(32),
  createdAt: 1
})

describe('pending device mint recovery', () => {
  let values: Map<string, string>

  beforeEach(() => {
    values = new Map()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key)
    })
  })

  it('round-trips only public quote and device metadata', () => {
    const pending = record()
    savePendingDeviceMint(pending)
    expect(readPendingDeviceMint()).toEqual(pending)
    expect([...values.values()][0]).not.toContain('k1')

    clearPendingDeviceMint()
    expect(readPendingDeviceMint()).toBeNull()
  })

  it('rejects a quote whose output no longer matches the staged hash', () => {
    const pending = record()
    values.set(
      'lnurlcash_pending_device_mint',
      JSON.stringify({
        ...pending,
        invoice: {
          ...pending.invoice,
          mint: {...pending.invoice.mint!, h: 'ef'.repeat(32)}
        }
      })
    )
    expect(readPendingDeviceMint()).toBeNull()
  })
})
