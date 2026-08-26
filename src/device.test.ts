import {describe, expect, it, vi} from 'vitest'

import {
  splitLines,
  encodeBleFrames,
  BleFrameReassembler,
  DeviceClient,
  SerialTransport,
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
  // a list_notes entry valid enough to survive device.ts's response validation
  const wireNote = (id: string) => ({
    id,
    state: 'confirmed',
    amount_msat: 1000,
    label: '',
    host: 'mock-mint.test',
    parent_ids: [],
    created_at: 0,
    updated_at: 0
  })

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
      notes: [wireNote('aaaaaaaa')],
      next_offset: 15
    })
    await expect(promise).resolves.toEqual({
      total: 40,
      offset: 10,
      notes: [wireNote('aaaaaaaa')],
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
      notes: [wireNote('aaaaaaaa'), wireNote('bbbbbbbb')],
      next_offset: 2
    })

    await vi.waitFor(() =>
      expect(transport.sent).toEqual([
        {cmd: 'list_notes'},
        {cmd: 'list_notes', offset: 2}
      ])
    )
    transport.respond({
      ok: true,
      total: 3,
      offset: 2,
      notes: [wireNote('cccccccc')]
    })

    await expect(promise).resolves.toEqual([
      wireNote('aaaaaaaa'),
      wireNote('bbbbbbbb'),
      wireNote('cccccccc')
    ])
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

  // A rotate leaves its parent behind as a spent record, so a vault in use
  // fills with dead weight. The firmware clears the lot in one press; the
  // trash icon on each note is one press per note.
  it('prunes spent notes on the physical-confirm timeout, not the short one', async () => {
    vi.useFakeTimers()
    try {
      const transport = new FakeTransport()
      const client = new DeviceClient(transport)
      const promise = client.pruneSpent()
      // past the default 10s a gated command would have died on, and the
      // on-device prompt has not even timed out yet
      await vi.advanceTimersByTimeAsync(10_000)
      expect(transport.disconnected).toBe(false)
      transport.respond({ok: true, removed: 3, remaining: 1})
      await expect(promise).resolves.toEqual({removed: 3, remaining: 1})
      expect(transport.sent).toEqual([{cmd: 'prune_spent'}])
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports the disconnect, not the closed port, on a later command', async () => {
    const transport = new FakeTransport()
    const client = new DeviceClient(transport)
    await transport.disconnect()
    await expect(client.getInfo()).rejects.toMatchObject({
      code: 'disconnected'
    })
    expect(transport.sent.length).toBe(0)
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
      const k1 = 'ab'.repeat(32)
      transport.respond({ok: true, k1})
      await expect(promise).resolves.toBe(k1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails a command queued behind a timeout with the timeout, not the closed port', async () => {
    vi.useFakeTimers()
    try {
      const transport = new FakeTransport()
      // a disconnect that only completes once the test releases it - the
      // worst case for the misattribution race: the old session is still
      // being torn down while the queue wants to advance
      let releaseDisconnect!: () => void
      const disconnectGate = new Promise<void>(resolve => {
        releaseDisconnect = resolve
      })
      const realDisconnect = transport.disconnect.bind(transport)
      transport.disconnect = async () => {
        await disconnectGate
        await realDisconnect()
      }
      const client = new DeviceClient(transport)
      const first = client.getInfo()
      const second = client.listNotes()
      const firstAssertion = expect(first).rejects.toMatchObject({
        code: 'timeout'
      })
      // the session is one-shot, so the queued command never reaches the
      // now-closed port and reports what killed it rather than the port's
      // own "not writable"
      const secondAssertion = expect(second).rejects.toMatchObject({
        code: 'disconnected',
        message: 'Device did not respond in time.'
      })

      await vi.advanceTimersByTimeAsync(10_000)
      // the timeout fired and teardown started, but until disconnect() has
      // settled the queue must NOT advance - a late response from the old
      // session could otherwise be misattributed as this next command's
      expect(transport.sent.length).toBe(1)

      releaseDisconnect()
      await firstAssertion
      await vi.advanceTimersByTimeAsync(0)
      await secondAssertion
      expect(transport.sent.length).toBe(1)
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

describe('DeviceClient response validation', () => {
  it('clamps an unknown wire error code to a generic bad_request', async () => {
    const transport = new FakeTransport()
    const client = new DeviceClient(transport)
    const promise = client.getInfo()
    await vi.waitFor(() => expect(transport.sent.length).toBe(1))
    transport.respond({ok: false, error: 'definitely_not_a_real_code'})
    await expect(promise).rejects.toMatchObject({
      name: 'DeviceError',
      code: 'bad_request'
    })
  })

  it('fails a command whose response carries a malformed id or hash', async () => {
    const transport = new FakeTransport()
    const client = new DeviceClient(transport)
    const promise = client.newSecret()
    await vi.waitFor(() => expect(transport.sent.length).toBe(1))
    transport.respond({ok: true, id: 'not-hex-at-all', h: 'ab'.repeat(32)})
    await expect(promise).rejects.toMatchObject({
      code: 'bad_request',
      message: expect.stringContaining('id')
    })
  })

  it('fails export_secret on a k1 that is not 64 hex characters', async () => {
    const transport = new FakeTransport()
    const client = new DeviceClient(transport)
    const promise = client.exportSecret('cdcdcdcd')
    await vi.waitFor(() => expect(transport.sent.length).toBe(1))
    transport.respond({ok: true, k1: 'deadbeef'})
    await expect(promise).rejects.toMatchObject({
      code: 'bad_request',
      message: expect.stringContaining('k1')
    })
  })

  it('drops malformed list_notes entries without failing the whole list', async () => {
    const good = {
      id: 'cdcdcdcd',
      state: 'confirmed',
      amount_msat: 1000,
      label: '',
      host: 'mock-mint.test',
      parent_ids: [],
      created_at: 0,
      updated_at: 0
    }
    const alsoGood = {...good, id: 'efefefef', state: 'pending'}
    const transport = new FakeTransport()
    const client = new DeviceClient(transport)
    const promise = client.listNotes()
    await vi.waitFor(() => expect(transport.sent.length).toBe(1))
    // a null entry (crashed Vault.tsx before), a wrong-typed id, and a
    // missing field - all dropped, the conforming entries kept
    transport.respond({
      ok: true,
      notes: [good, null, {...good, id: 'nope'}, {state: 'pending'}, alsoGood]
    })
    await expect(promise).resolves.toEqual({
      total: undefined,
      offset: undefined,
      notes: [good, alsoGood],
      nextOffset: null
    })
  })
})

describe('SerialTransport receive buffer cap', () => {
  it('tears the session down when the device floods the buffer without a newline', async () => {
    // a fake SerialPort just real enough for requestAndConnect: a readable
    // stream the test pushes bytes into, a writable that records sends
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const writes: Uint8Array[] = []
    const fakePort = {
      readable: new ReadableStream<Uint8Array>({
        start: c => {
          controller = c
        }
      }),
      writable: {
        getWriter: () => ({
          write: async (chunk: Uint8Array) => {
            writes.push(chunk)
          },
          releaseLock: () => {}
        })
      },
      open: async () => {},
      close: async () => {}
    }
    vi.stubGlobal('navigator', {
      serial: {requestPort: async () => fakePort}
    })
    try {
      const transport = await SerialTransport.requestAndConnect()
      const client = new DeviceClient(transport)
      const promise = client.getInfo()
      await vi.waitFor(() => expect(writes.length).toBe(1))
      const assertion = expect(promise).rejects.toMatchObject({
        code: 'disconnected',
        message: expect.stringContaining('newline')
      })
      // one chunk over the 1 MB cap with no '\n' anywhere - a well-behaved
      // response is a single small JSON line, so this can only be garbage
      controller.enqueue(new Uint8Array(1_048_576 + 1))
      await assertion
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
