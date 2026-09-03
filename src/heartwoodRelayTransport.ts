// ---- Heartwood (NIP-46 relay) ----
//
// Heartwood's standalone/"hard" mode owns its USB port and serves the note
// locker as heartwood_note_* NIP-46 extensions.  This transport adapts those
// request-id-bearing relay calls back to the same JSON command surface that
// DeviceClient already drives for USB/BLE vaults.

import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  verifyEvent,
  type Event
} from 'nostr-tools/pure'
import {SimplePool} from 'nostr-tools/pool'
import * as nip44 from 'nostr-tools/nip44'
import type {Filter} from 'nostr-tools/filter'
import {bytesToHex, hexToBytes, randomBytes} from '@noble/hashes/utils.js'

import type {DeviceTransport} from './device.js'

const NIP46_KIND = 24133
const PLAIN_TIMEOUT_MS = 15_000
const GATED_TIMEOUT_MS = 75_000

export type HeartwoodRelayLink = {
  devicePubkey: string
  relays: string[]
  clientSecretHex: string
}

export type ParsedBunkerUri = {
  devicePubkey: string
  relays: string[]
  pairingSecret: string
}

export type RelayTransport = {
  subscribe(
    relays: string[],
    filter: Filter,
    onEvent: (event: Event) => void
  ): {close(): void}
  publish(
    relays: string[],
    event: Event
  ): Promise<{ok: string[]; failed: string[]}>
  close(): void
}

export const parseBunkerUri = (input: string): ParsedBunkerUri => {
  const match = input.trim().match(/^bunker:\/\/([0-9a-f]{64})\??(.*)$/i)
  if (!match) throw new Error('Paste a valid bunker:// pairing link.')
  const params = new URLSearchParams(match[2] ?? '')
  const relays = params
    .getAll('relay')
    .filter(relay => /^wss:\/\//i.test(relay))
  if (!relays.length) throw new Error('The pairing link names no secure relay.')
  const pairingSecret = params.get('secret') ?? ''
  if (!pairingSecret)
    throw new Error('The pairing link carries no one-time secret.')
  return {
    devicePubkey: match[1]!.toLowerCase(),
    relays: [...new Set(relays)],
    pairingSecret
  }
}

export const newHeartwoodRelayLink = (
  bunkerUri: string
): {link: HeartwoodRelayLink; pairingSecret: string} => {
  const parsed = parseBunkerUri(bunkerUri)
  return {
    link: {
      devicePubkey: parsed.devicePubkey,
      relays: parsed.relays,
      clientSecretHex: bytesToHex(generateSecretKey())
    },
    pairingSecret: parsed.pairingSecret
  }
}

export const isHeartwoodRelayLink = (
  value: unknown
): value is HeartwoodRelayLink => {
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

export const poolRelayTransport = (): RelayTransport => {
  const pool = new SimplePool()
  return {
    subscribe: (relays, filter, onEvent) =>
      pool.subscribe(relays, filter, {onevent: onEvent}),
    publish: async (relays, event) => {
      const ok: string[] = []
      const failed: string[] = []
      await Promise.all(
        pool.publish(relays, event).map((result, index) =>
          result.then(
            () => ok.push(relays[index]!),
            () => failed.push(relays[index]!)
          )
        )
      )
      return {ok, failed}
    },
    close: () => pool.destroy()
  }
}

const METHOD_BY_COMMAND: Record<string, string> = {
  list_notes: 'heartwood_note_list',
  new_secret: 'heartwood_note_new',
  new_secret_pair: 'heartwood_note_new_pair',
  confirm: 'heartwood_note_confirm',
  discard: 'heartwood_note_discard',
  export_secret: 'heartwood_note_export',
  import_secret: 'heartwood_note_import',
  mark_spent: 'heartwood_note_spent'
}

const GATED_COMMANDS = new Set(['discard', 'export_secret', 'mark_spent'])

type RpcAnswer = {id: string; result?: unknown; error?: unknown}

const errorMessage = (error: unknown): string => {
  if (typeof error === 'string') return error
  if (error && typeof error === 'object') {
    const value = error as {message?: unknown; code?: unknown}
    if (typeof value.message === 'string') return value.message
    if (typeof value.code === 'string') return value.code
    if (typeof value.code === 'number') return `Heartwood error ${value.code}`
  }
  return 'Heartwood refused the request.'
}

const wireError = (message: string): string => {
  const normalized = message.trim().toLowerCase()
  const known = [
    'not_found',
    'invalid_state',
    'user_declined',
    'timeout',
    'storage_full',
    'bad_request',
    'display_unavailable',
    'response_too_large',
    'unsupported'
  ]
  return known.includes(normalized) ? normalized : 'bad_request'
}

export class HeartwoodRelayTransport implements DeviceTransport {
  readonly kind = 'relay' as const
  private readonly relay: RelayTransport
  private readonly link: HeartwoodRelayLink
  private readonly clientSecret: Uint8Array
  private readonly clientPubkey: string
  private readonly conversationKey: Uint8Array
  private messageHandler: ((message: unknown) => void) | null = null
  private disconnectHandler: ((reason?: string) => void) | null = null
  private closed = false

  constructor(
    link: HeartwoodRelayLink,
    relay: RelayTransport = poolRelayTransport()
  ) {
    if (!isHeartwoodRelayLink(link))
      throw new Error('Saved Heartwood pairing is invalid.')
    this.link = link
    this.relay = relay
    this.clientSecret = hexToBytes(link.clientSecretHex)
    this.clientPubkey = getPublicKey(this.clientSecret)
    this.conversationKey = nip44.getConversationKey(
      this.clientSecret,
      link.devicePubkey
    )
  }

  onMessage(handler: (message: unknown) => void): void {
    this.messageHandler = handler
  }

  onDisconnect(handler: (reason?: string) => void): void {
    this.disconnectHandler = handler
  }

  // DeviceClient's direct-transport defaults are shorter than a relay card's
  // approval window.  Request IDs make late replies unambiguous here, so the
  // relay path can safely grant the whole firmware window.
  commandTimeoutMs(message: unknown, fallbackMs: number): number {
    const cmd = (message as {cmd?: unknown})?.cmd
    if (typeof cmd !== 'string') return fallbackMs
    return GATED_COMMANDS.has(cmd) ? GATED_TIMEOUT_MS + 5_000 : 25_000
  }

  async connect(pairingSecret: string): Promise<void> {
    const result = await this.rpc<string>(
      'connect',
      [
        this.clientPubkey,
        pairingSecret,
        'heartwood_note_*',
        JSON.stringify({name: 'LNURLwallet'})
      ],
      GATED_TIMEOUT_MS
    )
    if (result !== 'ack' && result !== pairingSecret) {
      throw new Error(`Unexpected Heartwood pairing reply: ${String(result)}`)
    }
  }

  async send(message: unknown): Promise<void> {
    try {
      const command = message as Record<string, unknown>
      const cmd = typeof command?.cmd === 'string' ? command.cmd : ''
      if (cmd === 'identify') {
        this.messageHandler?.({
          ok: false,
          error: 'unsupported',
          message: 'Heartwood relay identity is authenticated by NIP-46.'
        })
        return
      }
      if (cmd === 'get_info') {
        this.messageHandler?.(await this.infoResponse())
        return
      }
      const method = METHOD_BY_COMMAND[cmd]
      if (!method) {
        this.messageHandler?.({
          ok: false,
          error: 'unsupported',
          message: `${cmd || 'That command'} is not available over the Heartwood relay.`
        })
        return
      }
      const {cmd: _ignored, ...fields} = command
      const raw = await this.rpc<unknown>(
        method,
        [fields],
        GATED_COMMANDS.has(cmd) ? GATED_TIMEOUT_MS : PLAIN_TIMEOUT_MS
      )
      const response = typeof raw === 'string' ? JSON.parse(raw) : raw
      this.messageHandler?.(response)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.messageHandler?.({ok: false, error: wireError(message), message})
    }
  }

  private async infoResponse(): Promise<Record<string, unknown>> {
    const notes: Array<{state?: unknown}> = []
    let offset = 0
    let total = 0
    for (let pages = 0; pages < 1000; pages++) {
      const raw = await this.rpc<unknown>('heartwood_note_list', [
        {offset, limit: 8}
      ])
      const page = (typeof raw === 'string' ? JSON.parse(raw) : raw) as {
        ok?: boolean
        total?: number
        notes?: Array<{state?: unknown}>
        next_offset?: number
      }
      if (page.ok === false) return page as Record<string, unknown>
      if (typeof page.total === 'number') total = page.total
      if (Array.isArray(page.notes)) notes.push(...page.notes)
      if (typeof page.next_offset !== 'number') break
      if (page.next_offset <= offset || page.next_offset >= total) {
        throw new Error('Heartwood sent invalid note pagination.')
      }
      offset = page.next_offset
    }
    return {
      ok: true,
      fw_version: 'Heartwood relay',
      board: 'Heartwood',
      storage: 'ok',
      note_count: total || notes.length,
      pending_count: notes.filter(note => note.state === 'pending').length
    }
  }

  private rpc<T>(
    method: string,
    params: unknown[],
    timeoutMs = PLAIN_TIMEOUT_MS
  ): Promise<T> {
    if (this.closed)
      return Promise.reject(new Error('Heartwood relay disconnected.'))
    const id = bytesToHex(randomBytes(8))
    const createdAt = Math.floor(Date.now() / 1000)
    const request = finalizeEvent(
      {
        kind: NIP46_KIND,
        created_at: createdAt,
        tags: [['p', this.link.devicePubkey]],
        content: nip44.encrypt(
          JSON.stringify({id, method, params}),
          this.conversationKey
        )
      },
      this.clientSecret
    )

    return new Promise<T>((resolve, reject) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      let subscription: {close(): void} | undefined
      const finish = (action: () => void) => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        subscription?.close()
        action()
      }
      subscription = this.relay.subscribe(
        this.link.relays,
        {
          kinds: [NIP46_KIND],
          authors: [this.link.devicePubkey],
          '#p': [this.clientPubkey],
          since: createdAt - 5
        },
        event => {
          if (
            settled ||
            event.pubkey !== this.link.devicePubkey ||
            !verifyEvent(event)
          ) {
            return
          }
          try {
            const answer = JSON.parse(
              nip44.decrypt(event.content, this.conversationKey)
            ) as RpcAnswer
            if (answer.id !== id) return
            if (answer.error !== undefined) {
              const message = errorMessage(answer.error)
              finish(() => reject(new Error(message)))
            } else {
              finish(() => resolve(answer.result as T))
            }
          } catch {
            // Not this client's ciphertext, or malformed: leave this request
            // waiting for its own authenticated answer.
          }
        }
      )
      timer = setTimeout(
        () =>
          finish(() =>
            reject(new Error(`Heartwood did not answer ${method} in time.`))
          ),
        timeoutMs
      )
      this.relay.publish(this.link.relays, request).then(
        published => {
          if (!published.ok.length) {
            finish(() =>
              reject(
                new Error(
                  `No relay took the Heartwood request${
                    published.failed.length
                      ? ` (${published.failed.join(', ')})`
                      : ''
                  }.`
                )
              )
            )
          }
        },
        error =>
          finish(() =>
            reject(error instanceof Error ? error : new Error(String(error)))
          )
      )
    })
  }

  async disconnect(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.relay.close()
  }
}
