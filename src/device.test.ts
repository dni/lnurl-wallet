import {describe, expect, it, vi} from 'vitest'

import {
  splitLines,
  encodeBleFrames,
  BleFrameReassembler,
  DeviceClient,
  type DeviceTransport
} from './device'

describe('splitLines (WebSerial framing)', () => {
  it('splits complete lines and keeps the remainder', () => {
    expect(splitLines('a\nb\nc')).toEqual({lines: ['a', 'b'], rest: 'c'})
    expect(splitLines('no newline yet')).toEqual({
      lines: [],
      rest: 'no newline yet'
    })
    expect(splitLines('one\n')).toEqual({lines: ['one'], rest: ''})
    expect(splitLines('')).toEqual({lines: [], rest: ''})
  })
})

describe('BLE framing', () => {
  it('round-trips a message split across many small chunks', () => {
    const message = {cmd: 'list_notes', padding: 'x'.repeat(100)}
    const chunks = encodeBleFrames(message, 5)
    expect(chunks.length).toBeGreaterThan(1)
    const reassembler = new BleFrameReassembler()
    let result: unknown = null
    for (const chunk of chunks) {
      const parsed = reassembler.push(chunk)
      if (parsed !== null) result = parsed
    }
    expect(result).toEqual(message)
  })

  it('round-trips a message that fits in a single chunk', () => {
    const chunks = encodeBleFrames({ok: true}, 64)
    expect(chunks.length).toBe(1)
    const reassembler = new BleFrameReassembler()
    expect(reassembler.push(chunks[0])).toEqual({ok: true})
  })

  it('reassembles a second message after the first completes', () => {
    const reassembler = new BleFrameReassembler()
    for (const chunk of encodeBleFrames({a: 1}, 4)) reassembler.push(chunk)
    let second: unknown = null
    for (const chunk of encodeBleFrames({b: 2}, 4)) {
      const parsed = reassembler.push(chunk)
      if (parsed !== null) second = parsed
    }
    expect(second).toEqual({b: 2})
  })
})

// implements DeviceTransport directly (bypassing WebSerial/BLE entirely),
// same approach mockMint.test.ts uses for lnurlcash.ts's fetch layer - lets
// DeviceClient's command/queueing/timeout logic be exercised without any
// real port or GATT connection
class FakeTransport implements DeviceTransport {
  readonly kind = 'serial' as const
  sent: unknown[] = []
  disconnected = false
  private messageHandler: ((message: unknown) => void) | null = null
  private disconnectHandler: (() => void) | null = null

  onMessage(handler: (message: unknown) => void): void {
    this.messageHandler = handler
  }

  onDisconnect(handler: () => void): void {
    this.disconnectHandler = handler
  }

  async send(message: unknown): Promise<void> {
    this.sent.push(message)
  }

  async disconnect(): Promise<void> {
    if (this.disconnected) return
    this.disconnected = true
    this.disconnectHandler?.()
  }

  // test-only: simulates the device's response to whatever is currently pending
  respond(message: unknown): void {
    this.messageHandler?.(message)
  }
}

describe('DeviceClient', () => {
  it('resolves a command with the device response', async () => {
    const transport = new FakeTransport()
    const client = new DeviceClient(transport)
    const promise = client.getInfo()
    await vi.waitFor(() => expect(transport.sent).toEqual([{cmd: 'get_info'}]))
    transport.respond({
      ok: true,
      fw_version: '0.1.0',
      note_count: 2,
      pending_count: 1
    })
    await expect(promise).resolves.toEqual({
      fw_version: '0.1.0',
      note_count: 2,
      pending_count: 1
    })
  })

  it('includes board/storage in getInfo only when the device sends them', async () => {
    const transport = new FakeTransport()
    const client = new DeviceClient(transport)
    const promise = client.getInfo()
    await vi.waitFor(() => expect(transport.sent.length).toBe(1))
    transport.respond({
      ok: true,
      fw_version: '0.1.0',
      note_count: 2,
      pending_count: 1,
      board: 't-display-s3',
      storage: 'index_unreadable'
    })
    await expect(promise).resolves.toEqual({
      fw_version: '0.1.0',
      note_count: 2,
      pending_count: 1,
      board: 't-display-s3',
      storage: 'index_unreadable'
    })
  })

  it('passes offset/limit through to list_notes, and reports next_offset', async () => {
    const transport = new FakeTransport()
    const client = new DeviceClient(transport)
    const promise = client.listNotes(10, 5)
    await vi.waitFor(() =>
      expect(transport.sent).toEqual([
        {cmd: 'list_notes', offset: 10, limit: 5}
      ])
    )
    transport.respond({
      ok: true,
      total: 40,
      offset: 10,
      notes: [{id: 'a'}],
      next_offset: 15
    })
    await expect(promise).resolves.toEqual({
      total: 40,
      offset: 10,
      notes: [{id: 'a'}],
      nextOffset: 15
    })
  })

  it('listAllNotes pages through every note by feeding next_offset back', async () => {
    const transport = new FakeTransport()
    const client = new DeviceClient(transport)
    const promise = client.listAllNotes()

    await vi.waitFor(() =>
      expect(transport.sent).toEqual([{cmd: 'list_notes'}])
    )
    transport.respond({
      ok: true,
      total: 3,
      offset: 0,
      notes: [{id: 'a'}, {id: 'b'}],
      next_offset: 2
    })

    await vi.waitFor(() =>
      expect(transport.sent).toEqual([
        {cmd: 'list_notes'},
        {cmd: 'list_notes', offset: 2}
      ])
    )
    transport.respond({ok: true, total: 3, offset: 2, notes: [{id: 'c'}]})

    await expect(promise).resolves.toEqual([{id: 'a'}, {id: 'b'}, {id: 'c'}])
  })

  it('rejects with a typed DeviceError on a wire error response', async () => {
    const transport = new FakeTransport()
    const client = new DeviceClient(transport)
    const promise = client.exportSecret('abc')
    await vi.waitFor(() => expect(transport.sent.length).toBe(1))
    transport.respond({ok: false, error: 'user_declined'})
    await expect(promise).rejects.toMatchObject({
      name: 'DeviceError',
      code: 'user_declined'
    })
  })

  it('serializes commands - the second is never sent before the first resolves', async () => {
    const transport = new FakeTransport()
    const client = new DeviceClient(transport)
    const first = client.getInfo()
    const second = client.listNotes()

    // whatever it takes device.ts's internal queue to reach the transport,
    // at most the first command can possibly be on the wire by now - the
    // second is data-dependent on the first's response settling, so this
    // holds regardless of exact microtask timing, not by luck
    await vi.waitFor(() => expect(transport.sent.length).toBeGreaterThan(0))
    expect(transport.sent).toEqual([{cmd: 'get_info'}])

    transport.respond({
      ok: true,
      fw_version: '0.1.0',
      note_count: 0,
      pending_count: 0
    })
    await first
    await vi.waitFor(() => expect(transport.sent.length).toBe(2))
    expect(transport.sent).toEqual([{cmd: 'get_info'}, {cmd: 'list_notes'}])

    transport.respond({ok: true, total: 0, offset: 0, notes: []})
    await expect(second).resolves.toEqual({
      total: 0,
      offset: 0,
      notes: [],
      nextOffset: null
    })
  })

  it('rejects the pending command if the transport disconnects', async () => {
    const transport = new FakeTransport()
    const client = new DeviceClient(transport)
    const promise = client.getInfo()
    await vi.waitFor(() => expect(transport.sent.length).toBe(1))
    await transport.disconnect()
    await expect(promise).rejects.toMatchObject({code: 'disconnected'})
  })

  it('notifies an external disconnect handler exactly once', async () => {
    const transport = new FakeTransport()
    const client = new DeviceClient(transport)
    const handler = vi.fn()
    client.onDisconnect(handler)
    await transport.disconnect()
    expect(handler).toHaveBeenCalledOnce()
  })

  it('times out and disconnects a command that never gets a response', async () => {
    vi.useFakeTimers()
    try {
      const transport = new FakeTransport()
      const client = new DeviceClient(transport)
      const promise = client.getInfo()
      const assertion = expect(promise).rejects.toMatchObject({code: 'timeout'})
      await vi.advanceTimersByTimeAsync(10_000)
      await assertion
      expect(transport.disconnected).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('gives export_secret longer than a normal command before timing out', async () => {
    vi.useFakeTimers()
    try {
      const transport = new FakeTransport()
      const client = new DeviceClient(transport)
      const promise = client.exportSecret('abc')

      // still well within the default command timeout, but past it the
      // export-specific one is longer than - the on-device button-press
      // gate (30s) needs the client to outlast it, not race it
      await vi.advanceTimersByTimeAsync(10_000)
      transport.respond({ok: true, k1: 'deadbeef'})
      await expect(promise).resolves.toBe('deadbeef')
    } finally {
      vi.useRealTimers()
    }
  })

  // discard/mark_spent/rename/delete are gated by the same on-device
  // physical confirm as export_secret (docs/PROTOCOL.md's "unsupported"
  // paragraph) - each needs the same longer timeout, or a normal
  // button-hold confirm races the client's own default 10s and tears down
  // the whole session over what should have been a successful command
  it.each([
    ['discard', (c: DeviceClient) => c.discard('abc'), {ok: true}],
    ['markSpent', (c: DeviceClient) => c.markSpent('abc'), {ok: true}],
    ['rename', (c: DeviceClient) => c.rename('abc', 'label'), {ok: true}],
    ['delete', (c: DeviceClient) => c.delete('abc'), {ok: true}]
  ] as const)(
    'gives %s longer than a normal command before timing out',
    async (_name, call, response) => {
      vi.useFakeTimers()
      try {
        const transport = new FakeTransport()
        const client = new DeviceClient(transport)
        const promise = call(client)
        await vi.advanceTimersByTimeAsync(10_000)
        transport.respond(response)
        await expect(promise).resolves.toBeUndefined()
      } finally {
        vi.useRealTimers()
      }
    }
  )
})
