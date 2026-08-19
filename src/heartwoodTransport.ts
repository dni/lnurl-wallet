// ---- Heartwood (binary-framed WebSerial) ----
//
// A DeviceTransport for the Heartwood ESP32 signer's bearer-note locker
// (github.com/forgesworn/heartwood-esp32). Heartwood answers the exact same
// JSON command set as lnurl-vault - deviceOrchestration.ts runs against it
// unmodified - but its serial surface is a single binary frame protocol
// shared with its signing traffic, not newline-delimited JSON:
//
//   [0x48 0x57] [type u8] [length u16 BE] [payload...] [crc32 u32 BE]
//
// CRC32 (IEEE) covers type + length + payload, NOT the magic. One command
// goes out as a NOTE_CMD (0x70) frame carrying the JSON object; the reply
// comes back as a NOTE_RESP (0x71) frame carrying the JSON response. A NACK
// (0x15) is the device refusing at the frame layer - it is vault-locked, or
// in WiFi-standalone mode where the locker is USB-only - and is surfaced as
// an ok:false response so DeviceClient's normal error path reports the
// device's own reason.
//
// The same port also carries the firmware's log output, so the extractor
// scans for the magic and lets the CRC reject false positives - interleaved
// text between frames is expected, not an error. Opening at 115200 with no
// signal manipulation matches Sapwood's management path, which drives these
// boards over WebSerial daily without resetting them.

import type {DeviceTransport} from './device.js'

export const FRAME_TYPE_NOTE_CMD = 0x70
export const FRAME_TYPE_NOTE_RESP = 0x71
export const FRAME_TYPE_NACK = 0x15

const FRAME_MAGIC = new Uint8Array([0x48, 0x57])
const HEADER_SIZE = 5 // 2 magic + 1 type + 2 length
const CRC_SIZE = 4
// mirrors heartwood-common's MAX_PAYLOAD - nothing legitimate is larger
const MAX_PAYLOAD = 32768
// inbound plausibility bound, deliberately far tighter than MAX_PAYLOAD: a
// note response tops out around 2 KB (the firmware pages list_notes at 8
// per frame for exactly this reason), while a false magic inside log text
// whose next two bytes read as a big length would otherwise stall the
// extractor until that many bytes arrived. Anything claiming more than
// this is treated as noise and resynced past immediately
const MAX_RESPONSE_PAYLOAD = 8192

// same cap and reasoning as SerialTransport's newline buffer: the buffer
// only ever shrinks when a whole frame (or a hopeless prefix) is consumed,
// so a peer streaming frameless garbage must hit a ceiling, not the tab's
// memory
const FRAME_BUFFER_MAX_BYTES = 1_048_576 // 1 MB

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

export const crc32 = (bytes: Uint8Array): number => {
  let c = 0xffffffff
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

// build one frame around a payload. Pure and testable - the transport only
// adds the port plumbing
export const buildFrame = (type: number, payload: Uint8Array): Uint8Array => {
  if (payload.length > MAX_PAYLOAD) {
    throw new Error(`Frame payload too large (${payload.length} bytes).`)
  }
  const body = new Uint8Array(3 + payload.length)
  body[0] = type
  body[1] = (payload.length >> 8) & 0xff
  body[2] = payload.length & 0xff
  body.set(payload, 3)
  const crc = crc32(body)
  const frame = new Uint8Array(HEADER_SIZE + payload.length + CRC_SIZE)
  frame.set(FRAME_MAGIC, 0)
  frame.set(body, 2)
  const view = new DataView(frame.buffer)
  view.setUint32(frame.length - CRC_SIZE, crc)
  return frame
}

export type ExtractedFrame = {type: number; payload: Uint8Array}

// accumulate raw serial bytes, yield complete CRC-valid frames. Pure and
// testable without a port, like splitLines. Log text between frames is
// skipped by scanning to the next magic; a magic-looking sequence inside
// log text fails the CRC and is skipped one byte at a time (resync). An
// incomplete frame at the tail stays buffered until more bytes arrive
export class FrameAccumulator {
  private buffer = new Uint8Array(0)

  // bytes retained awaiting completion - the transport's cap check reads
  // this after each push
  get pending(): number {
    return this.buffer.length
  }

  push(bytes: Uint8Array): ExtractedFrame[] {
    const merged = new Uint8Array(this.buffer.length + bytes.length)
    merged.set(this.buffer, 0)
    merged.set(bytes, this.buffer.length)
    this.buffer = merged

    const frames: ExtractedFrame[] = []
    for (;;) {
      const start = this.findMagic()
      // nothing frame-like: keep only a possible split magic's first byte
      if (start === -1) {
        const last = this.buffer[this.buffer.length - 1]
        this.buffer =
          last === FRAME_MAGIC[0] ? this.buffer.slice(-1) : new Uint8Array(0)
        return frames
      }
      if (start > 0) this.buffer = this.buffer.slice(start)
      if (this.buffer.length < HEADER_SIZE) return frames
      const length = (this.buffer[3] << 8) | this.buffer[4]
      if (length > MAX_RESPONSE_PAYLOAD) {
        // impossible length - this was log text that happened to contain
        // the magic. Resync one byte on
        this.buffer = this.buffer.slice(1)
        continue
      }
      const total = HEADER_SIZE + length + CRC_SIZE
      if (this.buffer.length < total) return frames
      const body = this.buffer.slice(2, HEADER_SIZE + length)
      const view = new DataView(
        this.buffer.buffer,
        this.buffer.byteOffset + HEADER_SIZE + length,
        CRC_SIZE
      )
      if (view.getUint32(0) !== crc32(body)) {
        // false magic inside other traffic - resync one byte on
        this.buffer = this.buffer.slice(1)
        continue
      }
      frames.push({
        type: this.buffer[2],
        payload: this.buffer.slice(HEADER_SIZE, HEADER_SIZE + length)
      })
      this.buffer = this.buffer.slice(total)
    }
  }

  private findMagic(): number {
    for (let i = 0; i + 1 < this.buffer.length; i++) {
      if (
        this.buffer[i] === FRAME_MAGIC[0] &&
        this.buffer[i + 1] === FRAME_MAGIC[1]
      ) {
        return i
      }
    }
    return -1
  }
}

// what a frame-layer NACK becomes on DeviceClient's message path: an
// ordinary ok:false response whose message carries the device's own reason
// ("locked", "note locker is USB-mode only", ...). normalizeErrorCode maps
// the code to bad_request; the reason survives in message where the UI
// shows it
export const nackToResponse = (payload: Uint8Array): unknown => {
  const reason = new TextDecoder().decode(payload).trim()
  return {
    ok: false,
    error: 'bad_request',
    message: reason ? `Device refused: ${reason}` : 'Device refused.'
  }
}

export class HeartwoodTransport implements DeviceTransport {
  readonly kind = 'serial' as const
  private port: SerialPort
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  private messageHandler: ((message: unknown) => void) | null = null
  private disconnectHandler: ((reason?: string) => void) | null = null
  private frames = new FrameAccumulator()
  private closed = false

  static isSupported(): boolean {
    return typeof navigator !== 'undefined' && !!navigator.serial
  }

  static async requestAndConnect(): Promise<HeartwoodTransport> {
    if (!HeartwoodTransport.isSupported()) {
      throw new Error('This browser does not support WebSerial.')
    }
    const port = await navigator.serial!.requestPort()
    await port.open({baudRate: 115200})
    const transport = new HeartwoodTransport(port)
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
    const payload = new TextEncoder().encode(JSON.stringify(message))
    const frame = buildFrame(FRAME_TYPE_NOTE_CMD, payload)
    const writer = this.port.writable.getWriter()
    try {
      await writer.write(frame)
    } finally {
      writer.releaseLock()
    }
  }

  private async startReading(): Promise<void> {
    if (!this.port.readable) return
    const reader = this.port.readable.getReader()
    this.reader = reader
    try {
      for (;;) {
        const {value, done} = await reader.read()
        if (done) break
        const frames = this.frames.push(value)
        if (this.frames.pending > FRAME_BUFFER_MAX_BYTES) {
          await this.closeSession(
            `Device sent over ${FRAME_BUFFER_MAX_BYTES} bytes with no valid frame - disconnected.`
          )
          return
        }
        for (const frame of frames) {
          if (frame.type === FRAME_TYPE_NOTE_RESP) {
            try {
              this.messageHandler?.(
                JSON.parse(new TextDecoder().decode(frame.payload))
              )
            } catch {
              // a malformed response frame is dropped, not fatal - the
              // pending command is left to its own client-side timeout
            }
          } else if (frame.type === FRAME_TYPE_NACK) {
            this.messageHandler?.(nackToResponse(frame.payload))
          }
          // any other frame type is the signer's other traffic - not ours,
          // ignored
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

  // single teardown path, mirroring SerialTransport: `reason` only for a
  // transport-initiated teardown, forwarded so DeviceClient can reject a
  // pending command with the real cause
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
