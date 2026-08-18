import {describe, it, expect} from 'vitest'
import {
  buildFrame,
  crc32,
  FrameAccumulator,
  nackToResponse,
  FRAME_TYPE_NOTE_CMD,
  FRAME_TYPE_NOTE_RESP,
  FRAME_TYPE_NACK
} from './heartwoodTransport.js'

const encode = (s: string) => new TextEncoder().encode(s)

describe('buildFrame', () => {
  it('produces the heartwood frame layout with a BE CRC over type+len+payload', () => {
    const payload = encode('{"cmd":"get_info"}')
    const frame = buildFrame(FRAME_TYPE_NOTE_CMD, payload)
    expect(frame[0]).toBe(0x48)
    expect(frame[1]).toBe(0x57)
    expect(frame[2]).toBe(FRAME_TYPE_NOTE_CMD)
    expect((frame[3] << 8) | frame[4]).toBe(payload.length)
    expect(frame.slice(5, 5 + payload.length)).toEqual(payload)
    const body = frame.slice(2, 5 + payload.length)
    const view = new DataView(frame.buffer, frame.length - 4)
    expect(view.getUint32(0)).toBe(crc32(body))
  })

  it('refuses an oversized payload instead of sending a corrupt length', () => {
    expect(() =>
      buildFrame(FRAME_TYPE_NOTE_CMD, new Uint8Array(32769))
    ).toThrow(/too large/)
  })
})

describe('FrameAccumulator', () => {
  const respFrame = (json: string) =>
    buildFrame(FRAME_TYPE_NOTE_RESP, encode(json))

  it('yields a frame delivered in one chunk', () => {
    const acc = new FrameAccumulator()
    const frames = acc.push(respFrame('{"ok":true}'))
    expect(frames).toHaveLength(1)
    expect(frames[0].type).toBe(FRAME_TYPE_NOTE_RESP)
    expect(new TextDecoder().decode(frames[0].payload)).toBe('{"ok":true}')
    expect(acc.pending).toBe(0)
  })

  it('reassembles a frame split at every possible byte boundary', () => {
    const frame = respFrame('{"ok":true,"id":"a1b2c3d4"}')
    for (let cut = 1; cut < frame.length; cut++) {
      const acc = new FrameAccumulator()
      expect(acc.push(frame.slice(0, cut))).toHaveLength(0)
      const frames = acc.push(frame.slice(cut))
      expect(frames, `cut at ${cut}`).toHaveLength(1)
    }
  })

  it('skips interleaved log text around and between frames', () => {
    const a = respFrame('{"ok":true,"n":1}')
    const b = respFrame('{"ok":true,"n":2}')
    const noise1 = encode('I (1234) heartwood: [notes] loaded 2 note(s)\n')
    const noise2 = encode('W (1250) wifi: retrying\n')
    const acc = new FrameAccumulator()
    const stream = new Uint8Array([...noise1, ...a, ...noise2, ...b])
    const frames = acc.push(stream)
    expect(frames).toHaveLength(2)
    expect(new TextDecoder().decode(frames[1].payload)).toContain('"n":2')
  })

  it('resyncs past log text containing the magic bytes', () => {
    // 'HW' inside ordinary text forms a false frame start whose CRC fails
    const noise = encode('I (99) app: HWclock drift 3ms observed HW\n')
    const frame = respFrame('{"ok":true}')
    const acc = new FrameAccumulator()
    const frames = acc.push(new Uint8Array([...noise, ...frame]))
    expect(frames).toHaveLength(1)
  })

  it('drops a corrupted frame and still finds the next one', () => {
    const bad = respFrame('{"ok":true,"n":1}')
    bad[7] ^= 0x01 // corrupt a payload byte - CRC now fails
    const good = respFrame('{"ok":true,"n":2}')
    const acc = new FrameAccumulator()
    const frames = acc.push(new Uint8Array([...bad, ...good]))
    expect(frames).toHaveLength(1)
    expect(new TextDecoder().decode(frames[0].payload)).toContain('"n":2')
  })

  it('does not buffer unbounded plain noise', () => {
    const acc = new FrameAccumulator()
    acc.push(encode('no frames here at all, just logging '.repeat(100)))
    // everything non-frame is discarded (at most one byte kept for a split
    // magic), so the cap only ever bites on frame-like data
    expect(acc.pending).toBeLessThanOrEqual(1)
  })
})

describe('nackToResponse', () => {
  it('maps a reasoned NACK onto the ok:false path with the reason visible', () => {
    const res = nackToResponse(encode('locked')) as any
    expect(res.ok).toBe(false)
    expect(res.error).toBe('bad_request')
    expect(res.message).toContain('locked')
  })

  it('survives a reasonless NACK', () => {
    const res = nackToResponse(new Uint8Array(0)) as any
    expect(res.ok).toBe(false)
    expect(typeof res.message).toBe('string')
  })

  it('keeps the frame constant in step with the firmware', () => {
    // heartwood-common/src/types.rs: FRAME_TYPE_NACK = 0x15
    expect(FRAME_TYPE_NACK).toBe(0x15)
  })
})
