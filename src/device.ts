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
// This is the transport + command layer, plus deviceOrchestration.ts, which
// composes these commands with mint HTTP calls to actually route this
// wallet's rotate/split/merge/melt/mint/receive flows through a paired
// device instead of generating secrets in-browser - see its own header
// comment for the full command-by-command mapping (docs/PROTOCOL.md's
// "Orchestration"). DeviceContext.tsx / pages/Vault.tsx cover pairing,
// device info, and the device's own note list on top of that.

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

// get_info's `storage` field (docs/PROTOCOL.md's "get_info") - only 'ok'
// means the device can actually read its own notes. Every other value
// means note_count is how many notes the device could load, not how many
// exist; a client that skips this and just checks note_count === 0 can
// mistake a vault it can't currently read for one that's genuinely empty.
export type DeviceStorageState =
  'ok' | 'full' | 'version_unsupported' | 'unavailable' | 'index_unreadable'

// get_info's `inputs` - whether each button can be believed.
//
// 'stuck' is a usability problem, not a security one: the device won't let a
// button unseen-released answer a prompt, so a wedged line decides nothing.
// But a vault with a wedged cancel button has lost the ability to refuse, and
// only this field explains why pressing cancel does nothing.
//
// 'ok' means "not wedged low", NOT "works" - a disconnected button reads
// released forever. Don't render it as a clean bill of health.
export type DeviceInputState = 'ok' | 'stuck' | 'unknown'

export type DeviceInputs = {
  confirm: DeviceInputState
  cancel: DeviceInputState
}

// get_info's `capabilities` - what the device can physically do, so the
// wallet stops guessing. "Press cancel on the device" is wrong on a
// one-button board and meaningless on a touch-only one. deviceGuidance.ts
// turns this into the sentence a person reads.
export type DeviceCapabilities = {
  // buttons wired for confirm/cancel, not buttons present
  buttons: number
  touch: boolean
  // false => this build has no on-device confirmation wired at all, so every
  // physically-gated command will answer 'unsupported'. Worth saying before
  // the owner tries one, not after
  gated: boolean
  // usable pixels after the board's own rotation; 0 when the panel didn't
  // come up, which is how a client knows a QR handoff isn't available
  display: {width: number; height: number}
  transports: string[]
}

// identify's answer (lnurl-vault docs/PROTOCOL.md, issue #69). Verified in
// devicePinning.ts against a nonce this wallet chose - never trusted because
// the device said so.
export type DeviceIdentity = {
  pubkey: string
  sig: string
}

export type DeviceInfo = {
  fw_version: string
  note_count: number
  pending_count: number
  // identifies the hardware/pin map - absent on a build with no board
  // identifier compiled in
  board?: string
  // absent entirely on a build with no persistent storage at all - distinct
  // from 'unavailable', which means storage exists but couldn't come up
  // this boot (see DeviceStorageState)
  storage?: DeviceStorageState
  // absent on firmware that can't observe its own buttons. Absent is NOT
  // "they're fine" - it's "this build doesn't say"
  inputs?: DeviceInputs
  // absent on firmware that can't describe its own hardware. Again, absent
  // is not "no buttons and no screen"
  capabilities?: DeviceCapabilities
}

// one page of list_notes (docs/PROTOCOL.md's "list_notes") - `total` is how
// many notes the device holds in total, never just `notes.length`; a client
// must not treat the length of `notes` as the number of notes that exist.
// `nextOffset` is null once there's no more to page through.
export type DeviceNotePage = {
  total: number
  offset: number
  notes: DeviceNote[]
  nextOffset: number | null
}

export type DeviceErrorCode =
  | 'not_found'
  | 'invalid_state'
  | 'user_declined'
  | 'timeout'
  | 'storage_full'
  | 'bad_request'
  // the device could not ask its owner at all (no display, or it never
  // came up) - distinct from 'user_declined' on purpose (docs/PROTOCOL.md):
  // nobody refused, there was nothing to show. A generic "declined" message
  // for this sends the holder hunting for a confirm prompt that never
  // existed - callers that show different guidance per code should treat
  // this one separately.
  | 'display_unavailable'
  // list_notes: the reply didn't fit the transport's buffer at the
  // requested (or, unrequested, the largest attempted) page size
  | 'response_too_large'
  // no on-device confirmation is wired on this build at all - every
  // physically-gated command (export_secret/discard/mark_spent/rename/
  // delete/wipe) answers this instead of proceeding ungated
  | 'unsupported'
  // wipe only: the erase, or the verify-empty pass after it, failed -
  // treat as "this device still holds secrets", not as "nothing happened"
  | 'wipe_failed'
  // ota_begin/ota_finish only
  | 'bad_signature'
  | 'ota_failed'
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
  // `reason` is only set when the transport itself tore the session down
  // for a specific cause (see SerialTransport's receive-buffer cap) - an
  // ordinary drop (cable pulled, GATT lost) carries none
  onDisconnect(handler: (reason?: string) => void): void
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

// a response is a single JSON line, a few KB at most - and the receive
// buffer only ever shrinks at a '\n', so a malfunctioning/compromised
// device streaming newline-free data would otherwise grow it until the tab
// runs out of memory. Cap it far above any legitimate response and treat
// hitting the cap as fatal (see startReading). The BLE path needs no
// equivalent - its length-prefix framing bounds a message by the firmware's
// own declared length
const SERIAL_BUFFER_MAX_CHARS = 1_048_576 // 1 MB

export class SerialTransport implements DeviceTransport {
  readonly kind = 'serial' as const
  private port: SerialPort
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  private messageHandler: ((message: unknown) => void) | null = null
  private disconnectHandler: ((reason?: string) => void) | null = null
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
    return SerialTransport.open(port)
  }

  // Reconnect to a port the owner already granted, with no chooser and no
  // click. requestPort() needs a user gesture; open() does not, so a vault
  // still plugged in comes back by itself on reload.
  //
  // `probe` decides whether what answered is actually a vault. getPorts()
  // returns every port this origin was ever granted, which can include a
  // Heartwood signer (binary framing, see heartwoodTransport.ts) or anything
  // else the owner once picked - talking newline JSON at those is wrong. A
  // port that fails the probe is closed and the next one tried.
  static async tryReconnect(
    probe: (transport: SerialTransport) => Promise<boolean>
  ): Promise<SerialTransport | null> {
    if (!SerialTransport.isSupported()) return null
    let ports: SerialPort[] = []
    try {
      ports = await navigator.serial!.getPorts()
    } catch {
      return null
    }
    for (const port of ports) {
      let transport: SerialTransport
      try {
        transport = await SerialTransport.open(port)
      } catch {
        continue // already open in another tab, or unplugged since granted
      }
      if (await probe(transport)) return transport
      await transport.disconnect().catch(() => {})
    }
    return null
  }

  private static async open(port: SerialPort): Promise<SerialTransport> {
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

  onDisconnect(handler: (reason?: string) => void): void {
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
        if (this.buffer.length > SERIAL_BUFFER_MAX_CHARS) {
          // no legitimate response comes anywhere near this large without a
          // newline - the peer is streaming garbage. Tear the whole session
          // down (rejecting any pending command with the actual cause, via
          // the disconnect handler's reason) instead of accumulating until
          // the tab runs out of memory
          await this.closeSession(
            `Device sent over ${SERIAL_BUFFER_MAX_CHARS} bytes without a newline - disconnected.`
          )
          return
        }
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

  // the single teardown path - sets `closed`, cancels the reader, closes
  // the port. `reason` is passed only for a transport-initiated teardown
  // (the buffer cap in startReading) and is forwarded to the disconnect
  // handler so DeviceClient can reject a pending command with the real
  // cause; a plain disconnect() (user-initiated, or a command timeout)
  // fires no handler, since the read loop's own finally below treats an
  // already-closed session the same way
  private async closeSession(reason?: string): Promise<void> {
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
    if (reason !== undefined) this.disconnectHandler?.(reason)
  }

  async disconnect(): Promise<void> {
    await this.closeSession()
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
    return BleTransport.connectTo(device)
  }

  // Same idea as SerialTransport.tryReconnect. getDevices() lists devices
  // already permitted for this origin; it is not in every browser, so an
  // absent method is a null, not an error.
  static async tryReconnect(
    probe: (transport: BleTransport) => Promise<boolean>
  ): Promise<BleTransport | null> {
    if (!BleTransport.isSupported()) return null
    const bluetooth = navigator.bluetooth as unknown as {
      getDevices?: () => Promise<BluetoothDevice[]>
    }
    if (typeof bluetooth.getDevices !== 'function') return null
    let devices: BluetoothDevice[] = []
    try {
      devices = await bluetooth.getDevices()
    } catch {
      return null
    }
    for (const device of devices) {
      let transport: BleTransport
      try {
        transport = await BleTransport.connectTo(device)
      } catch {
        continue // out of range, or off
      }
      if (await probe(transport)) return transport
      await transport.disconnect().catch(() => {})
    }
    return null
  }

  private static async connectTo(
    device: BluetoothDevice
  ): Promise<BleTransport> {
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

// Every physically-gated command - export_secret, discard, mark_spent,
// rename, delete, wipe (docs/PROTOCOL.md's "unsupported" paragraph lists
// them) - blocks on a physical button press with a 30s on-device timeout.
// This client waits a little longer than that so the device's own timeout
// gets the chance to fire and answer first, rather than racing it: a
// client-side timeout shorter than the on-device one would time out (and,
// per sendOne below, tear down the whole session) while the owner is still
// mid button-hold on a perfectly normal confirm.
const PHYSICAL_CONFIRM_TIMEOUT_MS = 35_000
const DEFAULT_TIMEOUT_MS = 10_000

type PendingCommand = {
  resolve: (message: any) => void
  reject: (err: Error) => void
}

// ---- response validation ----
//
// everything below is the one place wire data is trusted: a response is
// validated/normalized in handleMessage before it ever settles a command,
// so a buggy (or hostile) device can't smuggle malformed values into the
// accessors - which would otherwise adopt them blindly. Deliberately a
// handful of checks, not a schema framework.

// every k1/h the protocol carries is a 32-byte value hex-encoded (a note
// secret or its SHA-256 hash) - anything else on the wire is a malformed
// response, never valid data
const isHex64 = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value)

// a note id is NOT one of those. It is the device's own local handle for a
// note, 8 hex characters - lnurl-vault's VAULT_ID_BUF is 9, "8 hex chars +
// NUL", and every example in its docs/PROTOCOL.md shows one that long
// ({"ok":true,"id":"e5f6a7b8","h":"<64-hex sha256>"} - the two are different
// lengths in the same response).
//
// This was previously validated as 64 hex along with k1/h, which rejected
// every response a real vault has ever sent: new_secret failed outright, and
// list_notes entries were dropped one by one until the list came back empty,
// so a device holding notes looked like an empty one. It survived because the
// mocks in device.test.ts returned 64-hex ids too, and no test ever put this
// code in front of the firmware it describes.
const isVaultId = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{8}$/i.test(value)

// an ed25519 signature: 64 bytes, hex
const isHex128 = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{128}$/i.test(value)

// response fields that must hold a 32-byte hex value when present at all
const HEX_RESPONSE_FIELDS = ['h', 'h2', 'k1'] as const

// response fields that must hold a device note id when present at all
const ID_RESPONSE_FIELDS = ['id', 'id2'] as const

// 'disconnected' is deliberately absent - it's raised locally (see
// handleDisconnect), never adopted from the wire. Everything else the
// protocol defines IS listed: collapsing a legitimate code to 'bad_request'
// would hide it from callers showing per-code guidance (e.g.
// 'display_unavailable', which explicitly says to treat it separately from
// 'user_declined') - and deviceQueue.ts's idempotency recovery
// pattern-matches DeviceError.code, so the whitelist must not drift from
// the protocol
const WIRE_ERROR_CODES: readonly DeviceErrorCode[] = [
  'not_found',
  'invalid_state',
  'user_declined',
  'timeout',
  'storage_full',
  'bad_request',
  'display_unavailable',
  'response_too_large',
  'unsupported',
  'wipe_failed',
  'bad_signature',
  'ota_failed'
]

// an error code off the wire is trusted only if it's one of the known codes
// - anything else collapses to a generic error rather than letting
// arbitrary firmware strings into DeviceError.code, which
// deviceQueue.ts's idempotency recovery pattern-matches against
const normalizeErrorCode = (code: unknown): DeviceErrorCode =>
  WIRE_ERROR_CODES.includes(code as DeviceErrorCode)
    ? (code as DeviceErrorCode)
    : 'bad_request'

const INPUT_STATES: readonly DeviceInputState[] = ['ok', 'stuck', 'unknown']

// Unrecognised collapses to 'unknown' - the one value no UI treats as either
// a fault or a clean bill.
const asInputState = (value: unknown): DeviceInputState =>
  INPUT_STATES.includes(value as DeviceInputState)
    ? (value as DeviceInputState)
    : 'unknown'

const parseInputs = (value: any): DeviceInputs | undefined => {
  if (value === null || typeof value !== 'object') return undefined
  return {
    confirm: asInputState(value.confirm),
    cancel: asInputState(value.cancel)
  }
}

// Dropped whole rather than defaulted: defaulting `buttons` to 2 puts a
// confident wrong instruction in front of a one-button device. Dropping it
// falls back to generic wording, which is never wrong.
const parseCapabilities = (value: any): DeviceCapabilities | undefined => {
  if (value === null || typeof value !== 'object') return undefined
  if (typeof value.buttons !== 'number' || !Number.isFinite(value.buttons)) {
    return undefined
  }
  const display =
    value.display !== null &&
    typeof value.display === 'object' &&
    typeof value.display.width === 'number' &&
    typeof value.display.height === 'number'
      ? {width: value.display.width, height: value.display.height}
      : {width: 0, height: 0}
  return {
    buttons: value.buttons,
    touch: value.touch === true,
    // absent => assume it CAN ask; the other default would alarm every
    // owner of older firmware, wrongly
    gated: value.gated !== false,
    display,
    transports: Array.isArray(value.transports)
      ? value.transports.filter((t: unknown) => typeof t === 'string')
      : []
  }
}

// the per-entry shape a list_notes note must have - anything else (a null
// entry, a missing/wrong-typed field) is dropped, not trusted, so a single
// bad entry can neither fail the whole list nor crash a renderer on it
// (Vault.tsx maps over these with no error boundary)
const isDeviceNote = (value: any): value is DeviceNote =>
  value !== null &&
  typeof value === 'object' &&
  isVaultId(value.id) &&
  (value.state === 'pending' ||
    value.state === 'confirmed' ||
    value.state === 'spent') &&
  typeof value.amount_msat === 'number' &&
  typeof value.label === 'string' &&
  typeof value.host === 'string' &&
  Array.isArray(value.parent_ids) &&
  value.parent_ids.every((id: unknown) => typeof id === 'string') &&
  typeof value.created_at === 'number' &&
  typeof value.updated_at === 'number' &&
  (value.sig === undefined || typeof value.sig === 'string')

// Drives a DeviceTransport through the command set in docs/PROTOCOL.md.
// The wire protocol carries no request id ("every command gets exactly one
// response") - commands are therefore strictly serialized, one in flight at
// a time, and whatever message arrives next is always the pending command's
// response. A command that never gets one (device wedged, cable pulled
// mid-response) can't be safely told apart from a slow one without an id,
// so a client-side timeout treats it as fatal: it tears the session down
// and only lets the queue advance once that teardown has settled, rather
// than risk misattributing a late reply to the next command queued behind
// it. Responses are validated/normalized at this same boundary before a
// command ever settles with them (see handleMessage) - a malformed
// k1/h/id, an unknown error code, or a misshapen note-list entry from
// buggy or hostile firmware never reaches an accessor.
export class DeviceClient {
  private transport: DeviceTransport
  private pending: PendingCommand | null = null
  private queue: Promise<any> = Promise.resolve()
  private externalDisconnectHandler: (() => void) | null = null
  private disconnectNotified = false
  private deadReason: string | null = null

  constructor(transport: DeviceTransport) {
    this.transport = transport
    this.transport.onMessage(message => this.handleMessage(message))
    this.transport.onDisconnect(reason => this.handleDisconnect(reason))
  }

  onDisconnect(handler: () => void): void {
    this.externalDisconnectHandler = handler
  }

  private handleMessage(message: any): void {
    const pending = this.pending
    if (!pending) return // nothing awaiting this - stray/duplicate, dropped
    this.pending = null
    if (message?.ok === true) {
      // validate before resolving - a response is only trusted once the
      // fields the command's accessor is about to read actually check out;
      // a malformed one fails the command with a clear error instead
      for (const field of HEX_RESPONSE_FIELDS) {
        if (field in message && !isHex64(message[field])) {
          pending.reject(
            new DeviceError(
              'bad_request',
              `Device sent a malformed response (${field} must be 64 hex characters).`
            )
          )
          return
        }
      }
      for (const field of ID_RESPONSE_FIELDS) {
        if (field in message && !isVaultId(message[field])) {
          pending.reject(
            new DeviceError(
              'bad_request',
              `Device sent a malformed response (${field} must be 8 hex characters).`
            )
          )
          return
        }
      }
      if (Array.isArray(message.notes)) {
        // one malformed entry (a null, a wrong-typed field) is dropped
        // rather than failing the whole list
        message.notes = message.notes.filter(isDeviceNote)
      }
      pending.resolve(message)
    } else {
      pending.reject(
        new DeviceError(
          normalizeErrorCode(message?.error),
          typeof message?.message === 'string' ? message.message : undefined
        )
      )
    }
  }

  private handleDisconnect(reason?: string): void {
    // a session is one-shot, so remember why it died - sendOne reports this
    // instead of whatever the closed port says
    if (this.deadReason === null) {
      this.deadReason = reason ?? 'Device disconnected.'
    }
    if (this.pending) {
      this.pending.reject(
        new DeviceError('disconnected', reason ?? 'Device disconnected.')
      )
      this.pending = null
    }
    // one-shot: a client is dead after its first disconnect (DeviceContext
    // tears down and builds a fresh one per connect), so a transport that
    // signals the drop twice (e.g. BLE's gatt event racing the timeout
    // path's own notification, see sendOne) must not fire teardown twice
    if (this.disconnectNotified) return
    this.disconnectNotified = true
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
    // the transport is already closed by now; sending would fail with its own
    // "not writable" and bury the disconnect that actually caused it
    if (this.deadReason !== null) {
      return Promise.reject(new DeviceError('disconnected', this.deadReason))
    }
    return new Promise<any>((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        this.pending = null
        // claimed before teardown so a transport that raises its own
        // disconnect event can't overwrite it with a vaguer reason
        this.deadReason = 'Device did not respond in time.'
        // a late response to this command may still be on its way in -
        // reject only once the teardown has actually settled, since
        // rejecting is what lets the queue start the next command (see
        // send): without the wait, the straggler could arrive after the
        // next command's own pending is installed and be misattributed as
        // its response
        this.transport
          .disconnect()
          .catch(() => {})
          .then(() => {
            // a serial timeout's plain disconnect() fires no event of its
            // own (BLE's does - handleDisconnect is one-shot, so either
            // way the handler runs exactly once) - without this the UI
            // would keep showing "connected" on a dead port
            this.handleDisconnect('Device did not respond in time.')
            reject(
              new DeviceError('timeout', 'Device did not respond in time.')
            )
          })
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
    const info: DeviceInfo = {
      fw_version: res.fw_version,
      note_count: res.note_count,
      pending_count: res.pending_count
    }
    if (typeof res.board === 'string') info.board = res.board
    if (typeof res.storage === 'string') {
      info.storage = res.storage as DeviceStorageState
    }
    const inputs = parseInputs(res.inputs)
    if (inputs) info.inputs = inputs
    const capabilities = parseCapabilities(res.capabilities)
    if (capabilities) info.capabilities = capabilities
    return info
  }

  // Challenge-response over the device's identity key. The nonce is the
  // caller's, always - a fixed one turns this into a recording anything can
  // replay. Throws DeviceError('unsupported') on firmware with no identity.
  async identify(nonceHex: string): Promise<DeviceIdentity> {
    const res = await this.send({cmd: 'identify', nonce: nonceHex})
    if (!isHex64(res.pubkey) || !isHex128(res.sig)) {
      throw new DeviceError('bad_request', 'Malformed identity response.')
    }
    return {pubkey: res.pubkey.toLowerCase(), sig: res.sig.toLowerCase()}
  }

  // one page - `offset`/`limit` both optional, matching the wire command
  // exactly (docs/PROTOCOL.md's "list_notes"). See listAllNotes() below for
  // a caller that just wants everything, not manual paging.
  async listNotes(offset?: number, limit?: number): Promise<DeviceNotePage> {
    const cmd: Record<string, unknown> = {cmd: 'list_notes'}
    if (offset !== undefined) cmd.offset = offset
    if (limit !== undefined) cmd.limit = limit
    const res = await this.send(cmd)
    return {
      total: res.total,
      offset: res.offset,
      notes: Array.isArray(res.notes) ? res.notes : [],
      nextOffset: typeof res.next_offset === 'number' ? res.next_offset : null
    }
  }

  // pages through every note the device holds, feeding next_offset back as
  // offset until it stops appearing (docs/PROTOCOL.md's "list_notes": "Page
  // by feeding next_offset back as offset until it stops appearing") - for
  // a caller (DeviceContext.tsx) that wants the full list, not one page.
  // Omitting `limit` throughout means each page is "as many as fit", so
  // this never risks a 'response_too_large' the way an explicit limit
  // chosen too large would. A hostile or buggy device could answer with a
  // stationary/cycling next_offset forever, hanging the Vault page's
  // refresh in command roundtrips - pages must strictly advance and stay
  // within the reported total, and the page count is capped outright
  async listAllNotes(): Promise<DeviceNote[]> {
    const notes: DeviceNote[] = []
    let offset: number | undefined
    let lastOffset = -1
    for (let pages = 0; ;) {
      const page = await this.listNotes(offset)
      notes.push(...page.notes)
      const next = page.nextOffset
      if (next === null) break
      if (next <= lastOffset || next >= page.total || ++pages >= 1000) {
        throw new DeviceError(
          'bad_request',
          'Device sent invalid list_notes pagination.'
        )
      }
      lastOffset = next
      offset = next
    }
    return notes
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

  // gated on-device by a physical confirm/cancel button press (see
  // PHYSICAL_CONFIRM_TIMEOUT_MS) - a discard drops a note the mint already
  // rejected, but the device can't tell that apart from any other command
  // that touches a held note, so it asks the same as the rest
  async discard(id: string): Promise<void> {
    await this.send({cmd: 'discard', id}, PHYSICAL_CONFIRM_TIMEOUT_MS)
  }

  // gated on-device by a physical confirm/cancel button press - see
  // PHYSICAL_CONFIRM_TIMEOUT_MS. Rejects with DeviceError code
  // 'user_declined' or 'timeout' if the holder doesn't confirm.
  async exportSecret(id: string): Promise<string> {
    const res = await this.send(
      {cmd: 'export_secret', id},
      PHYSICAL_CONFIRM_TIMEOUT_MS
    )
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

  // gated on-device by a physical confirm/cancel button press - see
  // PHYSICAL_CONFIRM_TIMEOUT_MS. This is the burn step of every rotate/
  // split/merge/melt on a device-backed note (see deviceOrchestration.ts),
  // so this fires on ordinary, successful operations constantly - not an
  // edge case worth a shorter timeout.
  async markSpent(id: string): Promise<void> {
    await this.send({cmd: 'mark_spent', id}, PHYSICAL_CONFIRM_TIMEOUT_MS)
  }

  // gated on-device by a physical confirm/cancel button press - see
  // PHYSICAL_CONFIRM_TIMEOUT_MS
  async rename(id: string, label: string): Promise<void> {
    await this.send({cmd: 'rename', id, label}, PHYSICAL_CONFIRM_TIMEOUT_MS)
  }

  // gated on-device by a physical confirm/cancel button press - see
  // PHYSICAL_CONFIRM_TIMEOUT_MS
  async delete(id: string): Promise<void> {
    await this.send({cmd: 'delete', id}, PHYSICAL_CONFIRM_TIMEOUT_MS)
  }

  async disconnect(): Promise<void> {
    await this.transport.disconnect()
  }
}
