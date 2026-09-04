import {
  resolveNoteInput,
  noteK1,
  noteDeclaredAmount,
  serverOf,
  fetchNoteInfo,
  rotateNote,
  withNewK1,
  requireNoteK1,
  noteEndpointOf,
  probeBurnedNote,
  NoteSpentError,
  NoteUnknownError,
  PendingNoteError,
  AmbiguousMutationError
} from './lnurlcash'
import {deviceReceive} from './deviceOrchestration'
import type {DeviceClient} from './device'
import {notify, NotifyKind, msatToSats} from './helpers'
import type {Bearer, ActivityKind} from './storage'
import type {NewBearer} from './WalletContext'

// shared by Scan and Paste: resolve whatever came in to a note URL, ask the
// issuing service what it is worth (an informational GET - per spec this
// always puts k1 on the wire, so receive.ts's caller should rotate right
// after, see secureReceivedNote). Returns the note even when the info fetch
// fails - a bearer is better stored unverified than dropped.
export const receiveNote = async (
  input: string,
  existing: Bearer[]
): Promise<NewBearer> => {
  const url = resolveNoteInput(input)
  if (!url) {
    throw new Error('Not an LNURLcash bearer note (needs a k1).')
  }
  const k1 = noteK1(url)
  if (
    existing.some(
      b => noteK1(b.url) === k1 && serverOf(b.url) === serverOf(url)
    )
  ) {
    throw new Error('This note is already in your wallet.')
  }
  try {
    const info = await fetchNoteInfo(url)
    return {
      url,
      callback: info.callback,
      amount: info.maxWithdrawable,
      verified: true,
      mintPubkey: info.mintPubkey
    }
  } catch (err) {
    // the service positively told us this k1 is dead - that's worth more
    // than the sender's own claim, so don't paper over it with an
    // unverified fallback the way an unreachable/unknown-shaped error
    // below does. The caller (ReceiveDialog.tsx) surfaces this and never stores
    // the note.
    if (err instanceof NoteSpentError || err instanceof NoteUnknownError) {
      throw err
    }
    // service unreachable (or some other non-definitive failure) - fall
    // back to the sender's own (unverified) declared amount so the note
    // isn't shown as worth nothing
    return {
      url,
      callback: '',
      amount: noteDeclaredAmount(url) ?? 0,
      verified: false
    }
  }
}

// After receiving a note, rotate it: the previous holder (and anything that
// logged the URL in transit, since the informational GET above already put
// k1 on the wire) still knows the old secret - a rotate burns it and mints
// a fresh one only this wallet knows. Returns the updated note URL. Throws
// when the service refuses (e.g. a plain LUD-03 withdraw link that doesn't
// speak lnurlcash) - the caller should warn, not fail the receive.
export const secureReceivedNote = async (note: {
  url: string
  callback: string
  amount: number
}): Promise<string> => {
  const k1 = noteK1(note.url)
  if (!k1 || !note.callback) {
    throw new Error('Note has no callback to rotate against yet.')
  }
  const result = await rotateNote(note.callback, k1)
  return withNewK1(note.url, result.k1, note.amount, result.signature)
}

export type ReceiveContext = {
  bearers: Bearer[]
  addBearer: (note: NewBearer) => Promise<Bearer>
  updateBearer: (
    id: string,
    changes: Partial<Omit<Bearer, 'id'>>
  ) => Promise<void>
  logActivity: (kind: ActivityKind, message: string, label?: string) => void
  deviceClient: DeviceClient | null
}

// The full "bring a note in" flow: receiveNote + secureReceivedNote (or the
// device-bound equivalent) above, plus the storage/activity/notification
// side effects around them - shared by every entry point that accepts a
// note (Wallet.tsx's own scan/paste/type on the hero widget, ReceiveDialog's
// review-first flow for a vault handoff link). Re-entrancy is the caller's
// job (see e.g. ReceiveDialog's own busy() guard) - this itself just does
// the work once, top to bottom, and throws only for receiveNote's own
// up-front failures (not a note at all, already held, or definitively
// spent/unknown); everything after a note is actually stored is reported
// via notify()/logActivity() instead; a failed rotate still means "the
// note is yours", just not yet a secret only you know.
export const receiveIntoWallet = async (
  noteValue: string,
  ctx: ReceiveContext
): Promise<void> => {
  const received = await receiveNote(noteValue, ctx.bearers)
  const bearer = await ctx.addBearer(received)
  if (!received.verified) {
    notify(
      'Note stored, but its service could not be reached - refresh it later.',
      NotifyKind.LOADING
    )
    return
  }
  // rotate immediately: whoever handed this note over still knows the old
  // secret until it is burned. If a vault is connected, that fresh secret
  // is generated and held there instead of in this browser.
  try {
    if (ctx.deviceClient) {
      const result = await deviceReceive(
        ctx.deviceClient,
        received.url,
        received.callback,
        noteEndpointOf(received.url),
        requireNoteK1(received.url),
        received.amount
      )
      await ctx.updateBearer(bearer.id, {
        url: result.url,
        callback: result.callback,
        deviceId: result.deviceId,
        deviceHash: result.deviceHash
      })
    } else {
      const url = await secureReceivedNote(received)
      await ctx.updateBearer(bearer.id, {url})
    }
    ctx.logActivity(
      'receive',
      `Received ${msatToSats(received.amount)} sats from ${serverOf(received.url)}.`
    )
    notify(
      `Received ${msatToSats(received.amount)} sats - secret rotated, previous copies are burned.`,
      NotifyKind.SUCCESS
    )
  } catch (err) {
    if (err instanceof AmbiguousMutationError) {
      // the rotate request may have landed despite the failure - the fresh
      // secret it carried is then the only copy of this note
      const outcome = await probeBurnedNote(received.url)
      if (outcome === 'gone') {
        // the burn landed - adopt the fresh secret as the note
        const url = withNewK1(received.url, err.newSecrets[0], received.amount)
        await ctx.updateBearer(bearer.id, {url})
        ctx.logActivity(
          'receive',
          `Received ${msatToSats(received.amount)} sats from ${serverOf(received.url)} (rotated - confirmed on re-check after an uncertain response).`
        )
        notify(
          `Received ${msatToSats(received.amount)} sats - secret rotated, previous copies are burned.`,
          NotifyKind.SUCCESS
        )
        return
      }
      if (outcome === 'unknown') {
        // can't tell: keep the stored original AND track the possible
        // rotated copy, rather than gamble either way
        await ctx.addBearer({
          url: withNewK1(received.url, err.newSecrets[0], received.amount),
          callback: received.callback,
          amount: received.amount,
          verified: false,
          mintPubkey: received.mintPubkey
        })
        ctx.logActivity(
          'receive',
          `Received ${msatToSats(received.amount)} sats from ${serverOf(received.url)} (rotation outcome uncertain - the possible rotated copy is stored unverified).`
        )
        notify(
          `Received ${msatToSats(received.amount)} sats, but the rotation's outcome is uncertain - the possible new copy is stored unverified alongside the original; refresh both to reconcile.`,
          NotifyKind.ERROR
        )
        return
      }
      // 'live': the rotate never landed - the messages below fit as-is
    }
    // a PendingNoteError here means this exact k1 has some other operation
    // in flight on the service right now (e.g. the sender's own melt/rotate
    // hasn't settled yet) - temporary, and the note is already stored
    // (addBearer above), so it'll simply rotate on the next refresh.
    // Reporting it the same as every other failure ("the service refused to
    // rotate") reads as a permanent limitation instead of "try again
    // shortly" (see issue #3).
    const pending = err instanceof PendingNoteError
    ctx.logActivity(
      'receive',
      `Received ${msatToSats(received.amount)} sats from ${serverOf(received.url)} (${pending ? 'rotate pending - will retry on next refresh' : 'not rotated - sender may still hold a copy'}).`
    )
    notify(
      pending
        ? `Received ${msatToSats(received.amount)} sats, but couldn't rotate yet - this note has another operation in progress on the service. It'll rotate automatically next time you refresh it.`
        : `Received ${msatToSats(received.amount)} sats, but the service refused to rotate - the sender may still hold a spendable copy.`,
      NotifyKind.ERROR
    )
  }
}
