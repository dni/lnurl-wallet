import {
  resolveNoteInput,
  noteK1,
  serverOf,
  fetchNoteInfoSafe,
  rotateNote,
  withNewK1
} from './lnurlcash'
import type {Bearer} from './storage'
import type {NewBearer} from './WalletContext'

// shared by Scan and Paste: resolve whatever came in to a note URL, ask the
// issuing service what it is worth (informational GET, hash lookup when
// possible), and hand back what to store. Returns the note even when the
// info fetch fails - a bearer is better stored unverified than dropped.
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
    const {info} = await fetchNoteInfoSafe(url)
    return {
      url,
      callback: info.callback,
      amount: info.maxWithdrawable,
      verified: true
    }
  } catch {
    return {url, callback: '', amount: 0, verified: false}
  }
}

// After receiving a note, rotate it: the previous holder (and anything that
// logged the URL in transit) still knows the old k1 - a rotate burns it and
// mints a fresh secret only this wallet knows. Returns the updated note URL.
// Throws when the service refuses (e.g. a plain LUD-03 withdraw link that
// doesn't speak lnurlcash) - the caller should warn, not fail the receive.
export const secureReceivedNote = async (note: {
  url: string
  callback: string
}): Promise<string> => {
  const k1 = noteK1(note.url)
  if (!k1 || !note.callback) {
    throw new Error('Note has no callback to rotate against yet.')
  }
  const newK1 = await rotateNote(note.callback, k1)
  return withNewK1(note.url, newK1)
}
