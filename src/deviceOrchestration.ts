import type {DeviceClient} from './device'
import {
  rotateNoteWithHash,
  splitNoteWithHash,
  mergeNotesWithHash,
  meltNote,
  fetchNoteInfo,
  withNewK1,
  withoutK1,
  fromLud17,
  requireNoteK1,
  noteSignature,
  serverOf,
  type HashedMutationResult,
  type HashedSplitResult,
  type MeltResult
} from './lnurlcash'
import {enqueuePendingDeviceOp, drainPendingDeviceOps} from './deviceQueue'

// Combines device.ts's command client with lnurlcash.ts's mint calls to
// implement docs/PROTOCOL.md's "Orchestration" section (in the lnurl-vault
// repo) - the two-phase commit behind rotate/split/merge/mint/receive when
// a vault is connected: the device stages a fresh secret and discloses only
// its hash, the mint call either burns/mints against that hash, and only
// once the mint confirms does the device commit (confirm the new note,
// mark_spent the old one(s)). Same division of responsibility as
// receive.ts: pure functions, callers own addBearer/updateBearer/
// removeBearer - never touches WalletContext/storage.ts directly. Errors
// (DeviceError, PendingNoteError, plain Error) propagate unwrapped so
// existing instanceof checks at call sites keep working unmodified - the
// one exception is importAndRotate's DeviceImportLeftBehindError (see
// below), which wraps precisely to carry the already-imported note a
// caller would otherwise lose track of.

export type DeviceMutationResult = {
  deviceId: string
  amountMsat: number
  // blank mirror url - see lnurlcash.ts's withoutK1 -
  // never carries a real k1
  url: string
  callback: string
  signature?: string
}

// an input to merge/split: device-backed (deviceId set, secret exported
// just-in-time) or browser-only (secret read straight from url) - mixed
// selections are fully supported, see exportInputK1 below
export type CustodyInput = {deviceId?: string; url: string}

export const requireDeviceClient = (
  client: DeviceClient | null
): DeviceClient => {
  if (!client) throw new Error('Vault not connected - reconnect to continue.')
  return client
}

const exportInputK1 = (
  client: DeviceClient,
  input: CustodyInput
): Promise<string> =>
  input.deviceId
    ? client.exportSecret(input.deviceId)
    : Promise.resolve(requireNoteK1(input.url))

// writes the recovery-queue entry the instant the mint call above this has
// already succeeded, then tries to drain it right away. Never throws - the
// mint operation succeeded regardless of whether device bookkeeping
// finishes; deviceQueue.ts reconciles the rest on a later reconnect if not.
const commitToDevice = async (
  client: DeviceClient,
  outputs: {
    deviceId: string
    amountMsat: number
    host: string
    signature?: string
  }[],
  burnDeviceIds: string[]
): Promise<void> => {
  enqueuePendingDeviceOp({outputs, burnDeviceIds})
  await drainPendingDeviceOps(client)
}

// shared core of rotate/migrate/mint/receive/settle: given a secret already
// in hand (exported, imported, or just read from browser storage) and
// where it should be re-custodied, stages a fresh device secret, makes the
// mint call, and commits. `parentDeviceId` is null for a note that was
// never device-backed to begin with (migrate, mint, receive) - nothing to
// burn on-device in that case.
const rotateK1OnDevice = async (
  client: DeviceClient,
  note: {url: string; callback: string},
  parentDeviceId: string | null,
  k1: string,
  amountMsat: number
): Promise<DeviceMutationResult> => {
  const host = serverOf(note.callback)
  const {id, h} = await client.newSecret(parentDeviceId ? [parentDeviceId] : [])
  let result: HashedMutationResult
  try {
    result = await rotateNoteWithHash(note.callback, k1, h)
  } catch (err) {
    await client.discard(id).catch(() => {})
    throw err
  }
  await commitToDevice(
    client,
    [{deviceId: id, amountMsat, host, signature: result.signature}],
    parentDeviceId ? [parentDeviceId] : []
  )
  return {
    deviceId: id,
    amountMsat,
    url: withoutK1(note.url, amountMsat, result.signature),
    callback: note.callback,
    signature: result.signature
  }
}

// rotate an already device-backed note - the on-device physical button
// press happens here (exportSecret)
export const deviceRotate = async (
  client: DeviceClient,
  bearer: {deviceId: string; url: string; callback: string; amount: number}
): Promise<DeviceMutationResult> => {
  const k1 = await client.exportSecret(bearer.deviceId)
  return rotateK1OnDevice(client, bearer, bearer.deviceId, k1, bearer.amount)
}

// move a browser-only note onto the device: no export needed (the browser
// already has k1 in hand), no old device id to burn - just stage+commit a
// fresh device secret in its place. This is the whole "migration" story:
// hitting Refresh/Split/Combine on any note while a vault is connected
// moves its replacement onto the device, one action at a time.
export const migrateNoteToDevice = async (
  client: DeviceClient,
  bearer: {url: string; callback: string; amount: number}
): Promise<DeviceMutationResult> => {
  const k1 = requireNoteK1(bearer.url)
  return rotateK1OnDevice(client, bearer, null, k1, bearer.amount)
}

// merge/split's on-device output(s) may charge/refund a LUD-25 fee this
// wallet's own pre-computed amount doesn't reflect - reads the true value
// back via an informational GET (which itself briefly puts the device's
// freshly-minted secret on the wire) and immediately re-custodies it,
// closing that exposure. Mirrors lnurlcash.ts's settleNote exactly, one
// physical button press (the export needed for the GET; the follow-up
// rotate reuses that same k1, no second export).
export const deviceSettle = async (
  client: DeviceClient,
  pending: DeviceMutationResult
): Promise<DeviceMutationResult> => {
  const k1 = await client.exportSecret(pending.deviceId)
  const info = await fetchNoteInfo(
    withNewK1(pending.url, k1, pending.amountMsat, pending.signature)
  )
  try {
    return await rotateK1OnDevice(
      client,
      {url: pending.url, callback: info.callback},
      pending.deviceId,
      k1,
      info.maxWithdrawable
    )
  } catch {
    // best-effort re-custody, same fallback settleNote itself uses: keep
    // the authoritative amount even if closing the exposure failed
    return {
      ...pending,
      amountMsat: info.maxWithdrawable,
      callback: info.callback
    }
  }
}

// refresh: like deviceRotate, but first re-reads the note's current
// authoritative value/callback/mintPubkey via an informational GET, the
// same reason BearerCard's own browser-only refresh does this. The export
// needed for that GET (this bearer's own url carries no k1 to GET with) is
// reused for the following rotate, not requested a second time.
//
// Unlike the browser-only refresh, this has no partial-failure fallback:
// if anything here fails (export declined/timed out, the GET, or the
// rotate), nothing about the bearer changes and the whole thing is
// surfaced as one error - the mint-side GET/rotate split that lets the
// browser-only path update the amount even on a failed rotate doesn't
// carry over cleanly to a single button-gated device flow, so this trades
// that partial credit for a simpler, always-consistent local state.
export type DeviceRefreshResult = DeviceMutationResult & {
  mintPubkey?: string
}

export const deviceRefresh = async (
  client: DeviceClient,
  bearer: {deviceId: string; url: string; amount: number}
): Promise<DeviceRefreshResult> => {
  const k1 = await client.exportSecret(bearer.deviceId)
  const info = await fetchNoteInfo(withNewK1(bearer.url, k1, bearer.amount))
  const rotated = await rotateK1OnDevice(
    client,
    {url: bearer.url, callback: info.callback},
    bearer.deviceId,
    k1,
    info.maxWithdrawable
  )
  return {...rotated, mintPubkey: info.mintPubkey}
}

// merge: burns every input (device-exported or browser-read as
// appropriate - mixed selections are fine, parent_ids only ever lists the
// device-backed subset), mints one device-custodied note worth their sum
export const deviceMerge = async (
  client: DeviceClient,
  inputs: CustodyInput[],
  callback: string,
  totalAmountMsat: number
): Promise<DeviceMutationResult> => {
  const k1s: string[] = []
  for (const input of inputs) k1s.push(await exportInputK1(client, input))
  const host = serverOf(callback)
  const parentIds = inputs.flatMap(i => (i.deviceId ? [i.deviceId] : []))
  const {id, h} = await client.newSecret(parentIds)
  let result: HashedMutationResult
  try {
    result = await mergeNotesWithHash(callback, k1s, h)
  } catch (err) {
    await client.discard(id).catch(() => {})
    throw err
  }
  await commitToDevice(
    client,
    [
      {
        deviceId: id,
        amountMsat: totalAmountMsat,
        host,
        signature: result.signature
      }
    ],
    parentIds
  )
  return {
    deviceId: id,
    amountMsat: totalAmountMsat,
    url: withoutK1(inputs[0].url, totalAmountMsat, result.signature),
    callback,
    signature: result.signature
  }
}

export type DeviceSplitResult = {
  target: DeviceMutationResult
  change: DeviceMutationResult
}

// split: burns every input the same way deviceMerge does, mints two
// device-custodied notes - amountMsat (exact, per spec) and the remainder
export const deviceSplit = async (
  client: DeviceClient,
  inputs: CustodyInput[],
  callback: string,
  amountMsat: number,
  totalMsat: number
): Promise<DeviceSplitResult> => {
  const k1s: string[] = []
  for (const input of inputs) k1s.push(await exportInputK1(client, input))
  const host = serverOf(callback)
  const parentIds = inputs.flatMap(i => (i.deviceId ? [i.deviceId] : []))
  const {id, h, id2, h2} = await client.newSecretPair(parentIds)
  let result: HashedSplitResult
  try {
    result = await splitNoteWithHash(callback, k1s, amountMsat, h, h2)
  } catch (err) {
    await Promise.all([
      client.discard(id).catch(() => {}),
      client.discard(id2).catch(() => {})
    ])
    throw err
  }
  const changeMsat = totalMsat - amountMsat
  await commitToDevice(
    client,
    [
      {deviceId: id, amountMsat, host, signature: result.signature},
      {
        deviceId: id2,
        amountMsat: changeMsat,
        host,
        signature: result.changeSignature
      }
    ],
    parentIds
  )
  const template = inputs[0].url
  return {
    target: {
      deviceId: id,
      amountMsat,
      url: withoutK1(template, amountMsat, result.signature),
      callback,
      signature: result.signature
    },
    change: {
      deviceId: id2,
      amountMsat: changeMsat,
      url: withoutK1(template, changeMsat, result.changeSignature),
      callback,
      signature: result.changeSignature
    }
  }
}

// importAndRotate's unique failure mode: the import_secret already landed
// on the device (the k1 sits there CONFIRMED) but the follow-up rotate
// didn't finish - e.g. its mint call rejected, which also means nothing
// was burned mint-side. The imported note is still real, spendable money
// on the device, so this error carries a ready-to-track mirror of it
// (deviceId, k1-less url, expected amount) rather than letting it vanish
// from local state. Mint.tsx's claim stores that mirror as an unverified
// bearer; deviceReceive unwraps and rethrows the cause instead, since its
// own browser-held copy is already tracked
export class DeviceImportLeftBehindError extends Error {
  cause: unknown
  imported: DeviceMutationResult
  constructor(cause: unknown, imported: DeviceMutationResult) {
    super(cause instanceof Error ? cause.message : String(cause))
    this.name = 'DeviceImportLeftBehindError'
    this.cause = cause
    this.imported = imported
  }
}

// shared core of mint/receive: a k1 already known (a payment preimage, or a
// received note's own secret) is imported onto the device, then
// immediately rotated (per LUD-25's security considerations - the mint, or
// the previous holder, already saw this exact k1 once). `noteUrlTemplate`
// must already be a real, fetchable https(s) URL - withoutK1 strips any k1
// it happens to carry (a received note's own url always does) before it
// ever becomes the blank mirror. A failure after the import landed rejects
// with DeviceImportLeftBehindError, never the bare cause - the imported
// note exists on the device by then and must not silently disappear
const importAndRotate = async (
  client: DeviceClient,
  noteUrlTemplate: string,
  callback: string,
  host: string,
  k1: string,
  amountMsat: number,
  label?: string
): Promise<DeviceMutationResult> => {
  const importedId = await client.importSecret(k1, host, amountMsat, label)
  try {
    return await rotateK1OnDevice(
      client,
      {url: withoutK1(noteUrlTemplate, amountMsat), callback},
      importedId,
      k1,
      amountMsat
    )
  } catch (err) {
    throw new DeviceImportLeftBehindError(err, {
      deviceId: importedId,
      amountMsat,
      url: withoutK1(noteUrlTemplate, amountMsat),
      callback
    })
  }
}

// minting a brand new note: pay the invoice off-device (unchanged), then
// bring the resulting preimage under device custody. `withdrawLink` is the
// raw LUD-17 URL a payRequest advertises - never normalized yet, unlike a
// bearer's own stored url. Rejects with DeviceImportLeftBehindError when
// the import landed but the rotate didn't - Mint.tsx's claim tracks the
// carried mirror rather than stranding the note on the device
export const deviceMint = (
  client: DeviceClient,
  withdrawLink: string,
  callback: string,
  host: string,
  preimage: string,
  amountMsat: number,
  label?: string
): Promise<DeviceMutationResult> =>
  importAndRotate(
    client,
    fromLud17(withdrawLink.trim()),
    callback,
    host,
    preimage,
    amountMsat,
    label
  )

// receiving a note from someone else: same custody move as minting, but
// `noteUrl` is the received note's own url (already normalized by
// receive.ts/resolveLnurlInput, still carrying its real, about-to-be-
// stripped k1) rather than a bare payRequest withdrawLink
export const deviceReceive = async (
  client: DeviceClient,
  noteUrl: string,
  callback: string,
  host: string,
  k1: string,
  amountMsat: number,
  label?: string
): Promise<DeviceMutationResult> => {
  try {
    return await importAndRotate(
      client,
      noteUrl,
      callback,
      host,
      k1,
      amountMsat,
      label
    )
  } catch (err) {
    // ReceiveDialog has already stored the note browser-side (its own
    // addBearer) before this ever runs, so a left-behind device import
    // strands nothing there - keep the original error's identity
    // (ReceiveDialog pattern-matches PendingNoteError) instead of the
    // wrapper
    if (err instanceof DeviceImportLeftBehindError) {
      throw err.cause instanceof Error ? err.cause : err
    }
    throw err
  }
}

// melt only ever burns - no new secret, so no queue entry either. Export
// happens up front (button press); the mint call is the existing meltNote,
// unchanged. mark_spent is a separate, later step (see deviceMarkSpent)
// since a melt settles asynchronously, same as the browser-only path.
export const deviceMeltRequest = async (
  client: DeviceClient,
  deviceId: string,
  callback: string,
  pr: string
): Promise<MeltResult> => {
  const k1 = await client.exportSecret(deviceId)
  return meltNote(callback, k1, pr)
}

// marks a device note spent with no accompanying new secret - a melt once
// its settlement is confirmed (Melt.tsx's checkPending / TransferDialog's
// checkTransfer already detect that point for the local spent-flag, this
// is the same moment, not optimistic), or a prepared note once its "Done"/
// handed-over action fires (SendDialog.tsx). Routed through the same
// recovery queue as every other device commit (with no outputs, just a
// burn id) so a disconnect right at this instant doesn't strand the device
// thinking the note is still CONFIRMED - the next reconnect retries it.
export const deviceMarkSpent = (
  client: DeviceClient,
  deviceId: string
): Promise<void> => commitToDevice(client, [], [deviceId])

// deviceMarkSpent for callers that can't assume a vault is connected at
// the settlement-confirmed moment (a melt with no verify URL to poll, a
// transfer marked done after the device was unplugged): with a client this
// IS deviceMarkSpent (which already queues first and only then drains, so
// even a mid-call disconnect loses nothing); with none, the mark-spent op
// is just queued for the next connect's drainPendingDeviceOps. The queued
// op is the same shape deviceMarkSpent writes - empty outputs, one burn
// id - so it inherits the drain's semantics unchanged: 'invalid_state'
// (already spent) is idempotent success, 'not_found' leaves it queued for
// the next reconnect. Never throws - a failed or deferred mark must not
// fail the melt/transfer it trails, the money already moved
export const markDeviceNoteSpent = async (
  client: DeviceClient | null,
  deviceId: string
): Promise<void> => {
  try {
    if (client) {
      await deviceMarkSpent(client, deviceId)
    } else {
      enqueuePendingDeviceOp({outputs: [], burnDeviceIds: [deviceId]})
    }
  } catch {
    // unreachable by design (enqueue falls back to memory, drain never
    // throws) - the no-throw guarantee is explicit so callers can safely
    // fire-and-forget
  }
}

// reveals a device-backed note's real secret for handing it over (QR/copy)
// - deliberately no side effects on the device. Callers must hold the
// result in local state only, never persist it, until the note is actually
// marked spent (the existing explicit "mark as spent"/"Done" action),
// which is the point deviceMeltMarkSpent-style bookkeeping belongs, not
// here. `noteUrl` is the bearer's own blank-mirror url (see withoutK1) -
// reused as the template so any offline-verification `sig` it already
// carries travels with the revealed note too, not just its k1/amount.
export const deviceExportForHandoff = async (
  client: DeviceClient,
  deviceId: string,
  noteUrl: string,
  amountMsat: number
): Promise<{url: string; k1: string}> => {
  const k1 = await client.exportSecret(deviceId)
  const sig = noteSignature(noteUrl) ?? undefined
  return {url: withNewK1(noteUrl, k1, amountMsat, sig), k1}
}
