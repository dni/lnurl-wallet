import type {DeviceClient} from './device'
import {DeviceError} from './device'

// Persisted record of device-side bookkeeping still owed after a mint call
// already succeeded - see deviceOrchestration.ts's commitToDevice. Plain
// localStorage, deliberately NOT the encrypted bearer store: entries only
// ever reference device note ids and public amounts, never a raw secret.
//
// Exists to close a real gap: rotate/split/merge/mint on a device-backed
// note is a two-phase commit (mint call, then device confirm + mark_spent).
// If the device drops between those two phases, the mint has already
// committed but the device hasn't recorded it - without this queue, that
// desync has no way back short of manually reconciling PENDING notes by
// hand.
export type PendingDeviceOp = {
  id: string
  outputs: {
    deviceId: string
    amountMsat: number
    host: string
    signature?: string
  }[]
  burnDeviceIds: string[]
  createdAt: number
}

const STORAGE_KEY = 'lnurlcash_device_pending_ops'

const newOpId = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(8)))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')

// this module is pulled in by deviceOrchestration.ts, which is
// unit-tested directly under plain Node (deviceOrchestration.test.ts) - no
// localStorage global there. Falls back to an in-memory copy so the queue
// still behaves correctly within one process either way - it just won't
// survive a reload without a real localStorage (which every real browser
// this ships to has).
let memoryFallback: PendingDeviceOp[] = []

const readStored = (): PendingDeviceOp[] => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return memoryFallback
  }
}

const writeStored = (ops: PendingDeviceOp[]): void => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ops))
  } catch {
    memoryFallback = ops
  }
}

export const readPendingDeviceOps = (): PendingDeviceOp[] => readStored()

// written the instant a mint call succeeds, before confirm/mark_spent are
// even attempted - see deviceOrchestration.ts's commitToDevice. Returns the
// stored record (id/createdAt filled in) so the caller can try draining it
// immediately, same record left behind if that attempt doesn't finish.
export const enqueuePendingDeviceOp = (
  op: Omit<PendingDeviceOp, 'id' | 'createdAt'>
): PendingDeviceOp => {
  const entry: PendingDeviceOp = {...op, id: newOpId(), createdAt: Date.now()}
  writeStored([...readStored(), entry])
  return entry
}

export const dequeuePendingDeviceOp = (id: string): void => {
  writeStored(readStored().filter(op => op.id !== id))
}

// 'invalid_state' from confirm/mark_spent means the device already did
// this (a PENDING note can't be confirmed twice, a SPENT one can't be
// marked spent twice) - treated as success, not failure, since that's
// exactly the idempotent recovery this queue exists for
const isAlreadyDone = (err: unknown): boolean =>
  err instanceof DeviceError && err.code === 'invalid_state'

// drains every queued op against `client`: confirms every output, then
// marks every burn id spent, tolerating 'invalid_state' on either step as
// "already done". An op that still fails partway through (device
// disconnects again mid-drain) is left queued for next time - never
// thrown, since this runs best-effort on every reconnect.
export const drainPendingDeviceOps = async (
  client: DeviceClient
): Promise<void> => {
  for (const op of readStored()) {
    try {
      for (const output of op.outputs) {
        try {
          await client.confirm(
            output.deviceId,
            output.amountMsat,
            output.host,
            output.signature
          )
        } catch (err) {
          if (!isAlreadyDone(err)) throw err
        }
      }
      for (const deviceId of op.burnDeviceIds) {
        try {
          await client.markSpent(deviceId)
        } catch (err) {
          if (!isAlreadyDone(err)) throw err
        }
      }
      dequeuePendingDeviceOp(op.id)
    } catch {
      // still incomplete - leave it queued, the next drain retries it
    }
  }
}
