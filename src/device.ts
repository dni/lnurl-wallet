// LNURLvault client - talks to the hardware vault described in
// ../../lnurl-vault (see its README.md and docs/PROTOCOL.md for the full
// wire protocol this implements). The device generates and holds note
// secrets itself, disclosing only a SHA-256 hash until this wallet reports
// a mint accepted a rotate/split/merge, and gates every plaintext-secret
// export behind a physical button press on the device. It does no
// networking of its own - every mint HTTP call stays this wallet's job, the
// same as it already is; the device only ever sees the commands below.
//
// This module is transport-agnostic: SerialTransport (WebSerial/USB-CDC)
// and BleTransport (Web Bluetooth) both implement DeviceTransport, and
// DeviceClient drives either one identically. Only SerialTransport is
// exercised against real hardware-shaped expectations here (its framing -
// newline-delimited JSON - is trivial); BleTransport is implemented from
// docs/PROTOCOL.md's framing spec alone, the same "reasoned from spec, not
// verified against a board" caveat lnurl-vault's own README attaches to its
// NimBLE glue (src/transport/ble_gatt.c).
//
// This is the transport + command layer only. Wiring device-backed secrets
// into this wallet's existing rotate/split/merge/melt flows (Mint.tsx,
// Melt.tsx, SendDialog.tsx, BearerCard.tsx today generate/hold secrets
// in-browser via lnurlcash.ts's generateNoteSecret) is a deliberate,
// separate follow-up - see DeviceContext.tsx / pages/Vault.tsx for what's
// wired up so far: pairing, device info, and the device's own note list.

// ---- wire types (docs/PROTOCOL.md "Commands") ----

export type DeviceNoteState = 'pending' | 'confirmed' | 'spent'

export type DeviceNote = {
  id: string
  state: DeviceNoteState
  amount_msat: number
  label: string
  host: string
  parent_ids: string[]
  created_at: number
  updated_at: number
  // present only if the note carries a LUD-25 offline-verification signature
  sig?: string
}

export type DeviceInfo = {
  fw_version: string
  note_count: number
  pending_count: number
}

export type DeviceErrorCode =
  | 'not_found'
  | 'invalid_state'
  | 'user_declined'
  | 'timeout'
  | 'storage_full'
  | 'bad_request'
  // not a wire code - raised locally when the transport drops mid-command
  | 'disconnected'

export class DeviceError extends Error {
  code: DeviceErrorCode
  constructor(code: DeviceErrorCode, message?: string) {
    super(message || code)
    this.name = 'DeviceError'
    this.code = code
  }
}

// ---- transport abstraction ----

// One full JSON message in, one full JSON message out - each transport owns
// turning that into bytes on the wire (and back) per its own framing.
export interface DeviceTransport {
  readonly kind: 'serial' | 'ble'
  send(message: unknown): Promise<void>
  onMessage(handler: (message: unknown) => void): void
  onDisconnect(handler: () => void): void
  disconnect(): Promise<void>
}

// ---- WebSerial (USB-CDC) ----

// Pure and testable without a real port: splits a growing text buffer on
// '\n', returning whatever complete lines are available and the remainder
// still awaiting more bytes.
export const splitLines = (buffer: string): {lines: string[]; rest: string} => {
  const lines: string[] = []
  let rest = buffer
  let idx: number
  while ((idx = rest.indexOf('\n')) !== -1) {
    lines.push(rest.slice(0, idx))
    rest = rest.slice(idx + 1)
  }
  return {lines, rest}
}

export class SerialTransport implements DeviceTransport {
  readonly kind = 'serial' as const
  private port: SerialPort
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  private messageHandler: ((message: unknown) => void) | null = null
  private disconnectHandler: (() => void) | null = null
  private buffer = ''
  private closed = false

  static isSupported(): boolean {
    return typeof navigator !== 'undefined' && !!navigator.serial
  }

  static async requestAndConnect(): Promise<SerialTransport> {
    if (!SerialTransport.isSupported()) {
      throw new Error('This browser does not support WebSerial.')
    }
    const port = await navigator.serial!.requestPort()
    await port.open({baudRate: 115200})
    const transport = new SerialTransport(port)
    transport.startReading()
    return transport
  }

  private constructor(port: SerialPort) {
    this.port = port
  }

  onMessage(handler: (message: unknown) => void): void {
    this.messageHandler = handler
  }

  onDisconnect(handler: () => void): void {
    this.disconnectHandler = handler
  }

  async send(message: unknown): Promise<void> {
    if (!this.port.writable) throw new Error('Serial port is not writable.')
    const writer = this.port.writable.getWriter()
    try {
      await writer.write(
        new TextEncoder().encode(JSON.stringify(message) + '\n')
      )
    } finally {
      writer.releaseLock()
    }
  }

  private async startReading(): Promise<void> {
    if (!this.port.readable) return
    const reader = this.port.readable.getReader()
    this.reader = reader
    const decoder = new TextDecoder()
    try {
      for (;;) {
        const {value, done} = await reader.read()
        if (done) break
        this.buffer += decoder.decode(value, {stream: true})
        const {lines, rest} = splitLines(this.buffer)
        this.buffer = rest
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue
          try {
            this.messageHandler?.(JSON.parse(trimmed))
          } catch {
            // a malformed line is dropped, not fatal - whatever command is
            // waiting on it is left to its own client-side timeout
          }
        }
      }
    } catch {
      // the read loop throwing (port yanked, cable pulled) is the same
      // "gone" signal as an explicit close below
    } finally {
      reader.releaseLock()
      if (!this.closed) {
        this.closed = true
        this.disconnectHandler?.()
      }
    }
  }

  async disconnect(): Promise<void> {
    if (this.closed) return
    this.closed = true
    try {
      await this.reader?.cancel()
    } catch {
      // already gone - nothing left to cancel
    }
    try {
      await this.port.close()
    } catch {
      // already gone - nothing left to close
    }
  }
}

// ---- BLE (NimBLE GATT) ----
//
// UUIDs and framing mirror lnurl-vault/src/transport/ble_gatt.c and
// docs/PROTOCOL.md exactly. Unlike SerialTransport, this has never run
// against a real board from this environment (no Bluetooth adapter, no
// device) - treat it the same way lnurl-vault's own README treats its BLE
// firmware: a strong, spec-faithful starting point to debug against real
// hardware, not verified-working code.

const BLE_SERVICE_UUID = '407e0f1a-2c3d-118e-d64b-1b534e601a9c'
const BLE_RX_CHARACTERISTIC_UUID = '407e0f1b-2c3d-118e-d64b-1b534e601a9c'
const BLE_TX_CHARACTERISTIC_UUID = '407e0f1c-2c3d-118e-d64b-1b534e601a9c'

// Web Bluetooth exposes no MTU-negotiation API, so writes are chunked to
// the pre-4.2 default ATT MTU (23 bytes - 3-byte ATT header) rather than
// assume a larger negotiated one. Correct either way, just less efficient
// if the real link negotiated more.
const BLE_CHUNK_BYTES = 20

// [2-byte little-endian total length][message bytes...], the length header
// only on the first chunk - see docs/PROTOCOL.md's "BLE (NimBLE GATT)".
// Pure and testable without a real characteristic.
export const encodeBleFrames = (
  message: unknown,
  maxChunkBytes: number = BLE_CHUNK_BYTES
): Uint8Array[] => {
  const body = new TextEncoder().encode(JSON.stringify(message))
  if (body.length > 0xffff) {
    throw new Error('Message too large to frame over BLE.')
  }
  const framed = new Uint8Array(2 + body.length)
  framed[0] = body.length & 0xff
  framed[1] = (body.length >> 8) & 0xff
  framed.set(body, 2)
  const chunks: Uint8Array[] = []
  for (let offset = 0; offset < framed.length; offset += maxChunkBytes) {
    chunks.push(framed.slice(offset, offset + maxChunkBytes))
  }
  return chunks
}

// Reassembles chunks pushed one at a time (as they arrive from successive
// notifications) back into complete JSON messages. Pure state machine, no
// Bluetooth API involved - push() returns the parsed message once a
// complete one has arrived, null while still accumulating.
export class BleFrameReassembler {
  private expectedLength: number | null = null
  private bytes: number[] = []

  push(chunk: Uint8Array): unknown | null {
    if (this.expectedLength === null) {
      if (chunk.length < 2) return null // too short to carry a length header - drop
      this.expectedLength = chunk[0] | (chunk[1] << 8)
      this.bytes = Array.from(chunk.slice(2))
    } else {
      this.bytes.push(...chunk)
    }
    if (this.bytes.length < this.expectedLength) return null
    const complete = Uint8Array.from(this.bytes.slice(0, this.expectedLength))
    this.expectedLength = null
    this.bytes = []
    try {
      return JSON.parse(new TextDecoder().decode(complete))
    } catch {
      return null
    }
  }
}

export class BleTransport implements DeviceTransport {
  readonly kind = 'ble' as const
  private device: BluetoothDevice
  private rxCharacteristic: BluetoothRemoteGATTCharacteristic
  private txCharacteristic: BluetoothRemoteGATTCharacteristic
  private reassembler = new BleFrameReassembler()
  private messageHandler: ((message: unknown) => void) | null = null
  private disconnectHandler: (() => void) | null = null

  static isSupported(): boolean {
    return typeof navigator !== 'undefined' && !!navigator.bluetooth
  }

  static async requestAndConnect(): Promise<BleTransport> {
    if (!BleTransport.isSupported()) {
      throw new Error('This browser does not support Web Bluetooth.')
    }
    const device = await navigator.bluetooth!.requestDevice({
      filters: [{services: [BLE_SERVICE_UUID]}]
    })
    if (!device.gatt) throw new Error('This device has no GATT server.')
    const server = await device.gatt.connect()
    const service = await server.getPrimaryService(BLE_SERVICE_UUID)
    const rxCharacteristic = await service.getCharacteristic(
      BLE_RX_CHARACTERISTIC_UUID
    )
    const txCharacteristic = await service.getCharacteristic(
      BLE_TX_CHARACTERISTIC_UUID
    )
    const transport = new BleTransport(
      device,
      rxCharacteristic,
      txCharacteristic
    )
    await transport.startNotifications()
    return transport
  }

  private constructor(
    device: BluetoothDevice,
    rxCharacteristic: BluetoothRemoteGATTCharacteristic,
    txCharacteristic: BluetoothRemoteGATTCharacteristic
  ) {
    this.device = device
    this.rxCharacteristic = rxCharacteristic
    this.txCharacteristic = txCharacteristic
    this.device.addEventListener('gattserverdisconnected', () => {
      this.disconnectHandler?.()
    })
  }

  onMessage(handler: (message: unknown) => void): void {
    this.messageHandler = handler
  }

  onDisconnect(handler: () => void): void {
    this.disconnectHandler = handler
  }

  private async startNotifications(): Promise<void> {
    await this.txCharacteristic.startNotifications()
    this.txCharacteristic.addEventListener('characteristicvaluechanged', () => {
      const view = this.txCharacteristic.value
      if (!view) return
      const bytes = new Uint8Array(
        view.buffer,
        view.byteOffset,
        view.byteLength
      )
      const message = this.reassembler.push(bytes)
      if (message !== null) this.messageHandler?.(message)
    })
  }

  async send(message: unknown): Promise<void> {
    for (const chunk of encodeBleFrames(message)) {
      // .slice() pins the TS type to Uint8Array<ArrayBufferLike> (could in
      // principle be SharedArrayBuffer-backed), which BufferSource rejects -
      // same fix as keys.ts's encryptSecretParts
      await this.rxCharacteristic.writeValueWithoutResponse(
        new Uint8Array(chunk)
      )
    }
  }

  async disconnect(): Promise<void> {
    this.device.gatt?.disconnect()
  }
}

// ---- command layer ----

// export_secret blocks on a physical button press with a 30s on-device
// timeout (docs/PROTOCOL.md) - this client waits a little longer so the
// device's own timeout gets the chance to fire and answer first, rather
// than racing it.
const EXPORT_TIMEOUT_MS = 35_000
const DEFAULT_TIMEOUT_MS = 10_000

type PendingCommand = {
  resolve: (message: any) => void
  reject: (err: Error) => void
}

// Drives a DeviceTransport through the command set in docs/PROTOCOL.md.
// The wire protocol carries no request id ("every command gets exactly one
// response") - commands are therefore strictly serialized, one in flight at
// a time, and whatever message arrives next is always the pending command's
// response. A command that never gets one (device wedged, cable pulled
// mid-response) can't be safely told apart from a slow one without an id,
// so a client-side timeout treats it as fatal and tears down the session
// rather than risk misattributing a late reply to the next command queued
// behind it.
export class DeviceClient {
  private transport: DeviceTransport
  private pending: PendingCommand | null = null
  private queue: Promise<any> = Promise.resolve()
  private externalDisconnectHandler: (() => void) | null = null

  constructor(transport: DeviceTransport) {
    this.transport = transport
    this.transport.onMessage(message => this.handleMessage(message))
    this.transport.onDisconnect(() => this.handleDisconnect())
  }

  onDisconnect(handler: () => void): void {
    this.externalDisconnectHandler = handler
  }

  private handleMessage(message: any): void {
    const pending = this.pending
    if (!pending) return // nothing awaiting this - stray/duplicate, dropped
    this.pending = null
    if (message?.ok === true) {
      pending.resolve(message)
    } else {
      pending.reject(
        new DeviceError(message?.error ?? 'bad_request', message?.message)
      )
    }
  }

  private handleDisconnect(): void {
    if (this.pending) {
      this.pending.reject(
        new DeviceError('disconnected', 'Device disconnected.')
      )
      this.pending = null
    }
    this.externalDisconnectHandler?.()
  }

  private send(cmd: object, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<any> {
    const run = this.queue
      .catch(() => {})
      .then(() => this.sendOne(cmd, timeoutMs))
    // chains regardless of outcome - one command failing must not wedge
    // every command queued behind it
    this.queue = run.catch(() => {})
    return run
  }

  private sendOne(cmd: object, timeoutMs: number): Promise<any> {
    return new Promise<any>((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        this.pending = null
        this.transport.disconnect().catch(() => {})
        reject(new DeviceError('timeout', 'Device did not respond in time.'))
      }, timeoutMs)

      this.pending = {
        resolve: message => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve(message)
        },
        reject: err => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          reject(err)
        }
      }

      this.transport.send(cmd).catch(err => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.pending = null
        reject(err instanceof Error ? err : new Error(String(err)))
      })
    })
  }

  async getInfo(): Promise<DeviceInfo> {
    const res = await this.send({cmd: 'get_info'})
    return {
      fw_version: res.fw_version,
      note_count: res.note_count,
      pending_count: res.pending_count
    }
  }

  async listNotes(): Promise<DeviceNote[]> {
    const res = await this.send({cmd: 'list_notes'})
    return Array.isArray(res.notes) ? res.notes : []
  }

  // rotate (parentIds=[old]) / merge (parentIds=many inputs) - see
  // docs/PROTOCOL.md's "Orchestration"
  async newSecret(
    parentIds: string[] = [],
    label?: string
  ): Promise<{id: string; h: string}> {
    const cmd: Record<string, unknown> = {cmd: 'new_secret'}
    if (parentIds.length) cmd.parent_ids = parentIds
    if (label) cmd.label = label
    const res = await this.send(cmd)
    return {id: res.id, h: res.h}
  }

  // split - two outputs sharing the same parent lineage
  async newSecretPair(
    parentIds: string[]
  ): Promise<{id: string; h: string; id2: string; h2: string}> {
    const res = await this.send({cmd: 'new_secret_pair', parent_ids: parentIds})
    return {id: res.id, h: res.h, id2: res.id2, h2: res.h2}
  }

  async confirm(
    id: string,
    amountMsat: number,
    host: string,
    sig?: string
  ): Promise<void> {
    const cmd: Record<string, unknown> = {
      cmd: 'confirm',
      id,
      amount_msat: amountMsat,
      host
    }
    if (sig) cmd.sig = sig
    await this.send(cmd)
  }

  async discard(id: string): Promise<void> {
    await this.send({cmd: 'discard', id})
  }

  // gated on-device by a physical confirm/cancel button press - see
  // EXPORT_TIMEOUT_MS. Rejects with DeviceError code 'user_declined' or
  // 'timeout' if the holder doesn't confirm.
  async exportSecret(id: string): Promise<string> {
    const res = await this.send({cmd: 'export_secret', id}, EXPORT_TIMEOUT_MS)
    return res.k1
  }

  async importSecret(
    k1: string,
    host: string,
    amountMsat: number,
    label?: string
  ): Promise<string> {
    const cmd: Record<string, unknown> = {
      cmd: 'import_secret',
      k1,
      host,
      amount_msat: amountMsat
    }
    if (label) cmd.label = label
    const res = await this.send(cmd)
    return res.id
  }

  async markSpent(id: string): Promise<void> {
    await this.send({cmd: 'mark_spent', id})
  }

  async rename(id: string, label: string): Promise<void> {
    await this.send({cmd: 'rename', id, label})
  }

  async delete(id: string): Promise<void> {
    await this.send({cmd: 'delete', id})
  }

  async disconnect(): Promise<void> {
    await this.transport.disconnect()
  }
}
