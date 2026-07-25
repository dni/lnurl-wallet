import {
  resolveNoteInput,
  noteK1,
  noteDeclaredAmount,
  serverOf,
  fetchNoteInfo,
  rotateNote,
  withNewK1
} from './lnurlcash'
import type {Bearer} from './storage'
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
  } catch {
    // service unreachable - fall back to the sender's own (unverified)
    // declared amount so the note isn't shown as worth nothing
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
