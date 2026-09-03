import {describe, expect, it} from 'vitest'
import {finalizeEvent, getPublicKey, type Event} from 'nostr-tools/pure'
import * as nip44 from 'nostr-tools/nip44'
import type {Filter} from 'nostr-tools/filter'
import {bytesToHex, hexToBytes} from '@noble/hashes/utils.js'

import {DeviceClient} from './device'
import {
  HeartwoodRelayTransport,
  newHeartwoodRelayLink,
  parseBunkerUri,
  type HeartwoodRelayLink,
  type RelayTransport
} from './heartwoodRelayTransport'

const deviceSecret = hexToBytes('11'.repeat(32))
const devicePubkey = getPublicKey(deviceSecret)
const clientSecretHex = '22'.repeat(32)

type Request = {id: string; method: string; params: unknown[]}

class FakeRelay implements RelayTransport {
  readonly requests: Request[] = []
  private listener: ((event: Event) => void) | null = null
  constructor(private answer: (request: Request) => unknown) {}

  subscribe(
    _relays: string[],
    _filter: Filter,
    onEvent: (event: Event) => void
  ): {close(): void} {
    this.listener = onEvent
    return {close: () => void (this.listener = null)}
  }

  async publish(
    relays: string[],
    event: Event
  ): Promise<{ok: string[]; failed: string[]}> {
    const conversationKey = nip44.getConversationKey(deviceSecret, event.pubkey)
    const request = JSON.parse(
      nip44.decrypt(event.content, conversationKey)
    ) as Request
    this.requests.push(request)
    const answer = this.answer(request)
    queueMicrotask(() => {
      this.listener?.(
        finalizeEvent(
          {
            kind: 24133,
            created_at: Math.floor(Date.now() / 1000),
            tags: [['p', event.pubkey]],
            content: nip44.encrypt(
              JSON.stringify({id: request.id, result: answer}),
              conversationKey
            )
          },
          deviceSecret
        )
      )
    })
    return {ok: relays, failed: []}
  }

  close(): void {}
}

const link = (): HeartwoodRelayLink => ({
  devicePubkey,
  relays: ['wss://relay.example'],
  clientSecretHex
})

const note = (id: string, state: 'pending' | 'confirmed' | 'spent') => ({
  id,
  h: '33'.repeat(32),
  state,
  amount_msat: 994_000,
  label: '',
  host: 'moneyer.dev/w',
  parent_ids: [],
  created_at: 1,
  updated_at: 2
})

describe('Heartwood relay pairing', () => {
  it('parses a bunker URI and generates a separate client key', () => {
    const uri = `bunker://${devicePubkey}?secret=once&relay=${encodeURIComponent('wss://relay.example')}`
    expect(parseBunkerUri(uri)).toEqual({
      devicePubkey,
      relays: ['wss://relay.example'],
      pairingSecret: 'once'
    })
    const created = newHeartwoodRelayLink(uri)
    expect(created.pairingSecret).toBe('once')
    expect(created.link.clientSecretHex).toMatch(/^[0-9a-f]{64}$/)
    expect(created.link.clientSecretHex).not.toBe(bytesToHex(deviceSecret))
  })

  it('binds the generated client pubkey with the one-time secret', async () => {
    const relay = new FakeRelay(request => request.params[1])
    const transport = new HeartwoodRelayTransport(link(), relay)
    await transport.connect('once')
    expect(relay.requests).toHaveLength(1)
    expect(relay.requests[0]!.method).toBe('connect')
    expect(relay.requests[0]!.params[0]).toBe(
      getPublicKey(hexToBytes(clientSecretHex))
    )
    expect(relay.requests[0]!.params[1]).toBe('once')
  })
})

describe('HeartwoodRelayTransport', () => {
  it('maps DeviceClient list_notes onto the authenticated relay extension', async () => {
    const relay = new FakeRelay(request => {
      expect(request.method).toBe('heartwood_note_list')
      expect(request.params).toEqual([{}])
      return JSON.stringify({
        ok: true,
        total: 1,
        offset: 0,
        notes: [note('8ab13774', 'confirmed')]
      })
    })
    const client = new DeviceClient(new HeartwoodRelayTransport(link(), relay))
    await expect(client.listAllNotes()).resolves.toEqual([
      note('8ab13774', 'confirmed')
    ])
  })

  it('maps secret generation without ever returning the secret itself', async () => {
    const relay = new FakeRelay(request => {
      expect(request.method).toBe('heartwood_note_new')
      expect(request.params).toEqual([
        {parent_ids: ['8ab13774'], label: 'rotated'}
      ])
      return JSON.stringify({
        ok: true,
        id: '1234abcd',
        h: '44'.repeat(32)
      })
    })
    const client = new DeviceClient(new HeartwoodRelayTransport(link(), relay))
    await expect(client.newSecret(['8ab13774'], 'rotated')).resolves.toEqual({
      id: '1234abcd',
      h: '44'.repeat(32)
    })
  })

  it('synthesizes get_info from every list page', async () => {
    const relay = new FakeRelay(request => {
      const fields = request.params[0] as {offset: number}
      return JSON.stringify(
        fields.offset === 0
          ? {
              ok: true,
              total: 2,
              offset: 0,
              notes: [note('11111111', 'pending')],
              next_offset: 1
            }
          : {
              ok: true,
              total: 2,
              offset: 1,
              notes: [note('22222222', 'confirmed')]
            }
      )
    })
    const client = new DeviceClient(new HeartwoodRelayTransport(link(), relay))
    await expect(client.getInfo()).resolves.toMatchObject({
      fw_version: 'Heartwood relay',
      note_count: 2,
      pending_count: 1,
      storage: 'ok'
    })
    expect(relay.requests.map(request => request.method)).toEqual([
      'heartwood_note_list',
      'heartwood_note_list'
    ])
  })

  it('refuses USB-only housekeeping clearly', async () => {
    const relay = new FakeRelay(() => {
      throw new Error('should not publish')
    })
    const client = new DeviceClient(new HeartwoodRelayTransport(link(), relay))
    await expect(client.rename('8ab13774', 'x')).rejects.toMatchObject({
      code: 'unsupported'
    })
    expect(relay.requests).toHaveLength(0)
  })
})
