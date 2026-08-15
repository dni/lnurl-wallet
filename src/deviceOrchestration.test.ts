import {describe, expect, it, vi} from 'vitest'
import {sha256} from '@noble/hashes/sha2.js'
import {bytesToHex, hexToBytes} from '@noble/hashes/utils.js'

import type {DeviceTransport} from './device'
import {DeviceClient} from './device'
import {
  deviceRotate,
  migrateNoteToDevice,
  deviceMerge,
  deviceSplit,
  deviceSettle,
  deviceMint,
  deviceMeltRequest,
  deviceMarkSpent
} from './deviceOrchestration'
import {readPendingDeviceOps, drainPendingDeviceOps} from './deviceQueue'
import {buildNoteUrl} from './lnurlcash'

// Combines mockMint.test.ts's mock-mint pattern (a fake fetch) with
// device.test.ts's fake-transport DeviceClient (a fake device), exercising
// the two-phase commit deviceOrchestration.ts implements between them:
// mint call, then device confirm/mark_spent.

const WITHDRAW_URL = 'https://mock-mint.test/w'
const WITHDRAW_CALLBACK = 'https://mock-mint.test/w/cb'
const HOST = 'mock-mint.test'

const randomHex = (bytes: number): string =>
  bytesToHex(crypto.getRandomValues(new Uint8Array(bytes)))

const hashK1 = (k1: string): string => bytesToHex(sha256(hexToBytes(k1)))

const noteTemplateUrl = (k1: string, amountMsat: number): string =>
  buildNoteUrl(WITHDRAW_URL, k1, amountMsat)

type MintNote = {amountMsat: number; pending: boolean}

// trimmed version of mockMint.test.ts's MockMint - just the withdraw
// endpoint + callback, nothing payRequest/invoice-related, since
// deviceOrchestration.ts never touches those directly
class MockMint {
  private notes = new Map<string, MintNote>()
  rejectNextCallback = false

  seed(k1: string, amountMsat: number): void {
    this.notes.set(hashK1(k1), {amountMsat, pending: false})
  }

  isOutstanding(k1: string): boolean {
    return this.notes.has(hashK1(k1))
  }

  private respond(body: object): Promise<Response> {
    return Promise.resolve({json: async () => body} as unknown as Response)
  }

  fetch = async (input: string | URL): Promise<Response> => {
    const url = new URL(input.toString())
    const params = url.searchParams

    if (url.pathname === '/w') {
      const k1 = params.get('k1')
      if (!k1) return this.respond({status: 'ERROR', reason: 'missing k1'})
      const note = this.notes.get(hashK1(k1))
      if (!note) return this.respond({status: 'ERROR', reason: 'not found'})
      return this.respond({
        tag: 'withdrawRequest',
        callback: WITHDRAW_CALLBACK,
        k1,
        minWithdrawable: note.amountMsat,
        maxWithdrawable: note.amountMsat
      })
    }

    if (url.pathname === '/w/cb') {
      if (this.rejectNextCallback) {
        this.rejectNextCallback = false
        return this.respond({status: 'ERROR', reason: 'rejected'})
      }
      const k1s = params.getAll('k1')
      const pr = params.get('pr')
      const amount = params.get('amount')
      const h = params.get('h')
      const h2 = params.get('h2')
      if (k1s.length === 0) {
        return this.respond({status: 'ERROR', reason: 'missing k1'})
      }
      const hashes = k1s.map(hashK1)
      const notes = hashes.map(hash => this.notes.get(hash))
      if (notes.some(n => !n)) {
        return this.respond({status: 'ERROR', reason: 'not found'})
      }
      if (notes.some(n => n!.pending)) {
        return this.respond({status: 'ERROR', reason: 'pending'})
      }

      if (pr && k1s.length === 1 && !h) {
        this.notes.get(hashes[0])!.pending = true
        return this.respond({status: 'OK'})
      }
      if (amount && h && h2 && !pr) {
        const target = Number(amount)
        const total = notes.reduce((sum, n) => sum + n!.amountMsat, 0)
        const change = total - target
        if (change < 0) {
          return this.respond({status: 'ERROR', reason: 'insufficient value'})
        }
        for (const hash of hashes) this.notes.delete(hash)
        this.notes.set(h, {amountMsat: target, pending: false})
        this.notes.set(h2, {amountMsat: change, pending: false})
        return this.respond({status: 'OK'})
      }
      if (h && !h2 && !amount && !pr) {
        const total = notes.reduce((sum, n) => sum + n!.amountMsat, 0)
        for (const hash of hashes) this.notes.delete(hash)
        this.notes.set(h, {amountMsat: total, pending: false})
        return this.respond({status: 'OK'})
      }
      return this.respond({status: 'ERROR', reason: 'bad request'})
    }

    return this.respond({status: 'ERROR', reason: 'not found'})
  }
}

type FirmwareNote = {
  id: string
  state: 'pending' | 'confirmed' | 'spent'
  secret: string
  amount_msat: number
  host: string
  label: string
  parent_ids: string[]
}

// Simulates the vault firmware's command handling (docs/PROTOCOL.md) well
// enough to drive deviceOrchestration.ts's calls end to end: new_secret(_pair)
// stages a device-generated secret and discloses only its hash, confirm/
// discard/mark_spent transition PENDING/CONFIRMED/SPENT exactly like
// vault.c's state machine, export_secret only works on a CONFIRMED note.
class MockDeviceFirmware implements DeviceTransport {
  readonly kind = 'serial' as const
  private notes = new Map<string, FirmwareNote>()
  private idCounter = 0
  private messageHandler: ((message: unknown) => void) | null = null
  private disconnectHandler: (() => void) | null = null
  // test hook: the next command matching this name gets no response at all
  // (simulates the device dropping mid-command)
  dropOnce: string | null = null

  onMessage(handler: (message: unknown) => void): void {
    this.messageHandler = handler
  }

  onDisconnect(handler: () => void): void {
    this.disconnectHandler = handler
  }

  private newId(): string {
    return `d${(this.idCounter++).toString().padStart(4, '0')}`
  }

  async send(message: unknown): Promise<void> {
    const cmd = message as {cmd: string}
    if (this.dropOnce === cmd.cmd) {
      this.dropOnce = null
      return
    }
    const response = this.handle(cmd)
    Promise.resolve().then(() => this.messageHandler?.(response))
  }

  async disconnect(): Promise<void> {
    this.disconnectHandler?.()
  }

  get(id: string): FirmwareNote | undefined {
    return this.notes.get(id)
  }

  private handle(cmd: any): any {
    switch (cmd.cmd) {
      case 'get_info':
        return {
          ok: true,
          fw_version: 'mock',
          note_count: this.notes.size,
          pending_count: [...this.notes.values()].filter(
            n => n.state === 'pending'
          ).length
        }
      case 'list_notes':
        return {
          ok: true,
          notes: [...this.notes.values()].map(n => ({
            id: n.id,
            state: n.state,
            amount_msat: n.amount_msat,
            label: n.label,
            host: n.host,
            parent_ids: n.parent_ids,
            created_at: 0,
            updated_at: 0
          }))
        }
      case 'new_secret': {
        const id = this.newId()
        const secret = randomHex(32)
        this.notes.set(id, {
          id,
          state: 'pending',
          secret,
          amount_msat: 0,
          host: '',
          label: cmd.label ?? '',
          parent_ids: cmd.parent_ids ?? []
        })
        return {ok: true, id, h: hashK1(secret)}
      }
      case 'new_secret_pair': {
        const id = this.newId()
        const id2 = this.newId()
        const secret = randomHex(32)
        const secret2 = randomHex(32)
        this.notes.set(id, {
          id,
          state: 'pending',
          secret,
          amount_msat: 0,
          host: '',
          label: '',
          parent_ids: cmd.parent_ids ?? []
        })
        this.notes.set(id2, {
          id: id2,
          state: 'pending',
          secret: secret2,
          amount_msat: 0,
          host: '',
          label: '',
          parent_ids: cmd.parent_ids ?? []
        })
        return {ok: true, id, h: hashK1(secret), id2, h2: hashK1(secret2)}
      }
      case 'confirm': {
        const note = this.notes.get(cmd.id)
        if (!note) return {ok: false, error: 'not_found'}
        if (note.state !== 'pending') return {ok: false, error: 'invalid_state'}
        note.state = 'confirmed'
        note.amount_msat = cmd.amount_msat
        note.host = cmd.host
        return {ok: true}
      }
      case 'discard': {
        const note = this.notes.get(cmd.id)
        if (!note) return {ok: false, error: 'not_found'}
        if (note.state !== 'pending') return {ok: false, error: 'invalid_state'}
        this.notes.delete(cmd.id)
        return {ok: true}
      }
      case 'export_secret': {
        const note = this.notes.get(cmd.id)
        if (!note) return {ok: false, error: 'not_found'}
        if (note.state !== 'confirmed') {
          return {ok: false, error: 'invalid_state'}
        }
        return {ok: true, k1: note.secret}
      }
      case 'import_secret': {
        const id = this.newId()
        this.notes.set(id, {
          id,
          state: 'confirmed',
          secret: cmd.k1,
          amount_msat: cmd.amount_msat,
          host: cmd.host,
          label: cmd.label ?? '',
          parent_ids: []
        })
        return {ok: true, id}
      }
      case 'mark_spent': {
        const note = this.notes.get(cmd.id)
        if (!note) return {ok: false, error: 'not_found'}
        if (note.state !== 'confirmed') {
          return {ok: false, error: 'invalid_state'}
        }
        note.state = 'spent'
        return {ok: true}
      }
      default:
        return {ok: false, error: 'bad_request'}
    }
  }
}

const withMint = <T>(mint: MockMint, run: () => Promise<T>): Promise<T> => {
  vi.stubGlobal('fetch', mint.fetch as unknown as typeof fetch)
  return run().finally(() => vi.unstubAllGlobals())
}

describe('deviceRotate / migrateNoteToDevice', () => {
  it('rotates an already device-backed note', async () => {
    const mint = new MockMint()
    const firmware = new MockDeviceFirmware()
    const client = new DeviceClient(firmware)
    const k1 = randomHex(32)
    mint.seed(k1, 21000)

    await withMint(mint, async () => {
      const importedId = await client.importSecret(k1, HOST, 21000)
      const result = await deviceRotate(client, {
        deviceId: importedId,
        url: noteTemplateUrl(k1, 21000),
        callback: WITHDRAW_CALLBACK,
        amount: 21000
      })

      expect(mint.isOutstanding(k1)).toBe(false)
      expect(firmware.get(importedId)?.state).toBe('spent')
      expect(firmware.get(result.deviceId)?.state).toBe('confirmed')
      const newK1 = await client.exportSecret(result.deviceId)
      expect(mint.isOutstanding(newK1)).toBe(true)
      expect(result.url).not.toContain('k1=')
    })
  })

  it('moves a browser-only note onto the device with no export needed', async () => {
    const mint = new MockMint()
    const firmware = new MockDeviceFirmware()
    const client = new DeviceClient(firmware)
    const k1 = randomHex(32)
    mint.seed(k1, 5000)

    await withMint(mint, async () => {
      const result = await migrateNoteToDevice(client, {
        url: noteTemplateUrl(k1, 5000),
        callback: WITHDRAW_CALLBACK,
        amount: 5000
      })
      expect(mint.isOutstanding(k1)).toBe(false)
      expect(firmware.get(result.deviceId)?.state).toBe('confirmed')
      // nothing to burn on-device - the note never lived there
      expect(firmware.get(result.deviceId)?.parent_ids).toEqual([])
    })
  })
})

describe('deviceSplit / deviceSettle', () => {
  it('splits a device-backed note and settles the change leg', async () => {
    const mint = new MockMint()
    const firmware = new MockDeviceFirmware()
    const client = new DeviceClient(firmware)
    const k1 = randomHex(32)
    mint.seed(k1, 21000)

    await withMint(mint, async () => {
      const importedId = await client.importSecret(k1, HOST, 21000)
      const parts = await deviceSplit(
        client,
        [{deviceId: importedId, url: noteTemplateUrl(k1, 21000)}],
        WITHDRAW_CALLBACK,
        6000,
        21000
      )
      expect(firmware.get(importedId)?.state).toBe('spent')
      expect(firmware.get(parts.target.deviceId)?.state).toBe('confirmed')
      expect(parts.target.amountMsat).toBe(6000)
      expect(parts.change.amountMsat).toBe(15000)

      const settledChange = await deviceSettle(client, parts.change)
      expect(settledChange.amountMsat).toBe(15000)
      // settling rotates the change leg - a fresh device id, the old one
      // (the raw split output) burned in the process
      expect(firmware.get(parts.change.deviceId)?.state).toBe('spent')
      expect(firmware.get(settledChange.deviceId)?.state).toBe('confirmed')

      const targetK1 = await client.exportSecret(parts.target.deviceId)
      const changeK1 = await client.exportSecret(settledChange.deviceId)
      expect(mint.isOutstanding(targetK1)).toBe(true)
      expect(mint.isOutstanding(changeK1)).toBe(true)
    })
  })
})

describe('deviceMerge - mixed custody', () => {
  it('merges a device-backed and a browser-only note into one device note', async () => {
    const mint = new MockMint()
    const firmware = new MockDeviceFirmware()
    const client = new DeviceClient(firmware)
    const deviceK1 = randomHex(32)
    const browserK1 = randomHex(32)
    mint.seed(deviceK1, 4000)
    mint.seed(browserK1, 6000)

    await withMint(mint, async () => {
      const importedId = await client.importSecret(deviceK1, HOST, 4000)
      const merged = await deviceMerge(
        client,
        [
          {deviceId: importedId, url: noteTemplateUrl(deviceK1, 4000)},
          {url: noteTemplateUrl(browserK1, 6000)} // browser-only: no deviceId
        ],
        WITHDRAW_CALLBACK,
        10000
      )
      expect(merged.amountMsat).toBe(10000)
      // only the device-backed input is burned on-device - the
      // browser-only one was never there to begin with
      expect(firmware.get(importedId)?.state).toBe('spent')
      expect(firmware.get(merged.deviceId)?.parent_ids).toEqual([importedId])
      expect(mint.isOutstanding(deviceK1)).toBe(false)
      expect(mint.isOutstanding(browserK1)).toBe(false)
      const mergedK1 = await client.exportSecret(merged.deviceId)
      expect(mint.isOutstanding(mergedK1)).toBe(true)
    })
  })
})

describe('mint rejection unwinds the staged device secret', () => {
  it('discards the new note and leaves the old one untouched', async () => {
    const mint = new MockMint()
    const firmware = new MockDeviceFirmware()
    const client = new DeviceClient(firmware)
    const k1 = randomHex(32)
    mint.seed(k1, 8000)

    await withMint(mint, async () => {
      const importedId = await client.importSecret(k1, HOST, 8000)
      mint.rejectNextCallback = true
      await expect(
        deviceRotate(client, {
          deviceId: importedId,
          url: noteTemplateUrl(k1, 8000),
          callback: WITHDRAW_CALLBACK,
          amount: 8000
        })
      ).rejects.toThrow(/rejected/)

      // the old note was never touched - the mint never accepted the
      // rotate, so nothing was burned
      expect(firmware.get(importedId)?.state).toBe('confirmed')
      expect(mint.isOutstanding(k1)).toBe(true)
      // the staged new secret was discarded, not left dangling PENDING
      const infoAfter = await client.getInfo()
      expect(infoAfter.pending_count).toBe(0)
    })
  })
})

describe('device melt', () => {
  it('exports for the melt request, then marks spent once settlement is confirmed', async () => {
    const mint = new MockMint()
    const firmware = new MockDeviceFirmware()
    const client = new DeviceClient(firmware)
    const k1 = randomHex(32)
    mint.seed(k1, 3000)

    await withMint(mint, async () => {
      const importedId = await client.importSecret(k1, HOST, 3000)
      await deviceMeltRequest(
        client,
        importedId,
        WITHDRAW_CALLBACK,
        'lnbcmockpr'
      )
      // melt only marks the mint-side note pending - the device note
      // itself is untouched until settlement is confirmed separately
      expect(firmware.get(importedId)?.state).toBe('confirmed')

      await deviceMarkSpent(client, importedId)
      expect(firmware.get(importedId)?.state).toBe('spent')
    })
  })
})

describe('deviceMint', () => {
  it('imports a payment preimage and rotates it under device custody', async () => {
    const mint = new MockMint()
    const firmware = new MockDeviceFirmware()
    const client = new DeviceClient(firmware)
    const preimage = randomHex(32)
    mint.seed(preimage, 21000)

    await withMint(mint, async () => {
      const result = await deviceMint(
        client,
        WITHDRAW_URL,
        WITHDRAW_CALLBACK,
        HOST,
        preimage,
        21000
      )
      expect(mint.isOutstanding(preimage)).toBe(false)
      expect(firmware.get(result.deviceId)?.state).toBe('confirmed')
      const newK1 = await client.exportSecret(result.deviceId)
      expect(mint.isOutstanding(newK1)).toBe(true)
      expect(result.url).not.toContain('k1=')
    })
  })
})

describe('recovery queue', () => {
  it('recovers a confirm that never landed because the device dropped mid-commit', async () => {
    vi.useFakeTimers()
    try {
      const mint = new MockMint()
      const firmware = new MockDeviceFirmware()
      const client = new DeviceClient(firmware)
      const k1 = randomHex(32)
      mint.seed(k1, 5000)

      vi.stubGlobal('fetch', mint.fetch as unknown as typeof fetch)
      try {
        const importedId = await client.importSecret(k1, HOST, 5000)

        // the mint call itself (over fetch, a separate channel) succeeds
        // normally - only the device's own confirm response is dropped,
        // simulating a cable pulled right after the mint accepted it
        firmware.dropOnce = 'confirm'
        const rotatePromise = deviceRotate(client, {
          deviceId: importedId,
          url: noteTemplateUrl(k1, 5000),
          callback: WITHDRAW_CALLBACK,
          amount: 5000
        })
        await vi.advanceTimersByTimeAsync(10_000)
        const result = await rotatePromise

        // mint-side rotate succeeded regardless of the dropped confirm
        expect(mint.isOutstanding(k1)).toBe(false)
        // neither side of the commit landed on the device - confirm
        // failing stops mark_spent from being attempted in the same pass,
        // so the new note is still stuck PENDING and the old one is still
        // CONFIRMED, exactly as before the attempt
        expect(firmware.get(importedId)?.state).toBe('confirmed')
        expect(firmware.get(result.deviceId)?.state).toBe('pending')
        expect(readPendingDeviceOps().length).toBe(1)

        // reconnect - a fresh client, same persistent device state - and
        // drain, exactly what DeviceContext's connect path does
        const reconnectedClient = new DeviceClient(firmware)
        await drainPendingDeviceOps(reconnectedClient)
        expect(readPendingDeviceOps().length).toBe(0)
        expect(firmware.get(importedId)?.state).toBe('spent')

        const newK1 = await reconnectedClient.exportSecret(result.deviceId)
        expect(mint.isOutstanding(newK1)).toBe(true)
      } finally {
        vi.unstubAllGlobals()
      }
    } finally {
      vi.useRealTimers()
    }
  })
})
