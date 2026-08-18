import type {EncryptedRecordParts, StoredSecret} from './keys'
import {
  encryptRecord,
  decryptRecord,
  getSavedLinkingKeyStored,
  savedKeyExists,
  savedKeyIsEncrypted,
  restoreLinkingKeyStored
} from './keys'
import type {TrustedMint} from './trustedMints'
import {trustedMints, mergeTrustedMints} from './trustedMints'

// One bearer note held by this wallet - the decrypted, in-memory shape.
// `url` is the note's withdraw LNURL with the secret as its k1 param (so it
// IS the asset); the displayable bech32/lnurlw:// forms are re-encoded from
// it on demand.
export type Bearer = {
  id: string
  url: string
  callback: string // the mutating callback from the withdrawRequest JSON, '' until first verified
  amount: number // msat, last known (maxWithdrawable) - refreshed on demand
  verified: boolean // false while the issuing service hasn't confirmed the note yet
  // the issuing service's signing pubkey, cached once seen (withdrawRequest/
  // payRequest's optional mintPubkey) - lets a note's ?sig= be checked
  // offline against it without a network round trip
  mintPubkey?: string
  // a local-only lock, not a server-verified state: true once this wallet
  // has melted/handed over the note, or the holder marked it manually. It
  // just disables further mutating actions here so this copy can't be
  // reused by accident - it says nothing about whether the service has
  // actually burned it yet
  spent?: boolean
  // manual display order within its mint group (see MintGroupCard's drag
  // reorder) - absent means "never manually placed", which sorts by
  // -createdAt instead (see compareBearerOrder), i.e. newest first, same as
  // the default order before this field existed
  sortIndex?: number
  // a free-text note the holder can attach for their own reference (e.g.
  // "rent", "gift for Alex") - purely local, never sent anywhere, no
  // protocol meaning at all
  label?: string
  // present if this note's secret lives on a paired LNURLvault device,
  // never in this browser's storage - the device's own note id (see
  // device.ts's DeviceNote.id). When set, `url` never carries a real k1
  // (see lnurlcash.ts's withoutK1) - it's a blank mirror, kept
  // only so this bearer displays like any other (amount/host/label/state)
  deviceId?: string
  createdAt: number
  updatedAt: number
}

// the wallet's default note order (newest first) with manually dragged
// notes taking priority once they have an explicit rank - see
// MintGroupCard, the only place sortIndex is ever written
export const compareBearerOrder = (a: Bearer, b: Bearer): number =>
  (a.sortIndex ?? -a.createdAt) - (b.sortIndex ?? -b.createdAt)

export type EncryptedBearerRecord = {id: string} & EncryptedRecordParts

const BEARERS_STORAGE_KEY = 'lnurlcash_bearers'

export const newBearerId = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(8)))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')

export const readEncryptedBearers = (): EncryptedBearerRecord[] => {
  const raw = localStorage.getItem(BEARERS_STORAGE_KEY)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

const writeEncryptedBearers = (records: EncryptedBearerRecord[]): void => {
  localStorage.setItem(BEARERS_STORAGE_KEY, JSON.stringify(records))
}

// decrypts everything currently stored - a record that fails to decrypt
// (e.g. written by a different seed's key) is skipped, not destroyed: it
// stays in localStorage untouched and simply doesn't show up
export const loadBearers = async (aesKey: CryptoKey): Promise<Bearer[]> => {
  const bearers: Bearer[] = []
  for (const record of readEncryptedBearers()) {
    try {
      const bearer = await decryptRecord<Omit<Bearer, 'id'>>(aesKey, record)
      bearers.push({...bearer, id: record.id})
    } catch {
      // undecryptable with this key - leave it in place
    }
  }
  return bearers.sort((a, b) => b.createdAt - a.createdAt)
}

export const persistBearer = async (
  aesKey: CryptoKey,
  bearer: Bearer
): Promise<void> => {
  const {id, ...plain} = bearer
  const parts = await encryptRecord(aesKey, plain)
  const records = readEncryptedBearers().filter(r => r.id !== id)
  records.push({id, ...parts})
  writeEncryptedBearers(records)
}

export const deleteBearerRecord = (id: string): void => {
  writeEncryptedBearers(readEncryptedBearers().filter(r => r.id !== id))
}

// wipes every bearer record from this device outright - unlike forgetting
// just the linking key, this is not recoverable by restoring the same seed:
// the ciphertexts themselves are gone, so only a previously downloaded
// backup file can bring them back
export const clearAllBearers = (): void => {
  localStorage.removeItem(BEARERS_STORAGE_KEY)
}

// A single line of the wallet's activity log - one per important action
// (mint, split, combine, melt, transfer, receive, marking spent/unspent,
// clearing a spent note). `message` is already the full human-readable
// sentence (same convention as the toast notify() calls these are logged
// alongside) rather than structured fields the UI reassembles, so the log
// stays simple to read and to extend with new kinds later.
export type ActivityKind =
  | 'mint'
  | 'split'
  | 'combine'
  | 'melt'
  | 'transfer'
  | 'receive'
  | 'refresh'
  | 'spent'
  | 'unspent'
  | 'deleted'

export type ActivityEvent = {
  id: string
  kind: ActivityKind
  message: string
  createdAt: number
}

export type EncryptedActivityRecord = {id: string} & EncryptedRecordParts

const ACTIVITY_STORAGE_KEY = 'lnurlcash_activity'
// bounds how far back the log ever reaches - a wallet used for years
// shouldn't grow localStorage without limit over entries nobody's read
// that far back; the oldest simply roll off once this many are kept
const MAX_ACTIVITY_ENTRIES = 500

export const newActivityId = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(8)))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')

export const readEncryptedActivity = (): EncryptedActivityRecord[] => {
  const raw = localStorage.getItem(ACTIVITY_STORAGE_KEY)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

const writeEncryptedActivity = (records: EncryptedActivityRecord[]): void => {
  localStorage.setItem(ACTIVITY_STORAGE_KEY, JSON.stringify(records))
}

// same tolerance as loadBearers - an entry that fails to decrypt with this
// key (written by a different seed) is skipped, not destroyed
export const loadActivity = async (
  aesKey: CryptoKey
): Promise<ActivityEvent[]> => {
  const events: ActivityEvent[] = []
  for (const record of readEncryptedActivity()) {
    try {
      const event = await decryptRecord<Omit<ActivityEvent, 'id'>>(
        aesKey,
        record
      )
      events.push({...event, id: record.id})
    } catch {
      // undecryptable with this key - leave it in place
    }
  }
  return events.sort((a, b) => b.createdAt - a.createdAt)
}

// append-only (the log never edits or removes a single entry, only clears
// outright - see clearAllActivity) - records are stored oldest-first so
// trimming to the cap is just dropping off the front
export const persistActivityEvent = async (
  aesKey: CryptoKey,
  event: ActivityEvent
): Promise<void> => {
  const {id, ...plain} = event
  const parts = await encryptRecord(aesKey, plain)
  const records = readEncryptedActivity()
  records.push({id, ...parts})
  writeEncryptedActivity(records.slice(-MAX_ACTIVITY_ENTRIES))
}

export const clearAllActivity = (): void => {
  localStorage.removeItem(ACTIVITY_STORAGE_KEY)
}

// Backup file: everything exactly as it sits in localStorage - bearer
// ciphertexts always, the linking-key record only when it is itself
// password-encrypted. A plaintext linking key never leaves the device in a
// backup; the seed phrase is the recovery path for it instead. Trusted
// mints are plain (not secret - a mintPubkey is public), included as-is.
export type BackupFile = {
  type: 'lnurlwallet-backup'
  version: 1
  createdAt: number
  linkingKey?: StoredSecret
  bearers: EncryptedBearerRecord[]
  trustedMints?: TrustedMint[]
}

export const buildBackup = (): BackupFile => {
  const backup: BackupFile = {
    type: 'lnurlwallet-backup',
    version: 1,
    createdAt: Date.now(),
    bearers: readEncryptedBearers(),
    trustedMints: trustedMints()
  }
  if (savedKeyIsEncrypted()) {
    backup.linkingKey = getSavedLinkingKeyStored()!
  }
  return backup
}

export type RestoreResult = {
  added: number
  skipped: number
  linkingKeyRestored: boolean
  // true when the backup carried a linking key but this device already had
  // one, so it was deliberately NOT installed (see below) - distinct from
  // "no key in this backup at all". The bearer records above still merged
  // in regardless, but they were encrypted under the backup's own seed, not
  // whatever wallet is active on this device - unless that's the exact same
  // seed, they won't decrypt here, and the caller (Backup.tsx) should say so
  // rather than let that read as a silent no-op.
  linkingKeySkipped: boolean
  trustedMintsAdded: number
}

// merges a backup into localStorage: bearer records are added by id (already
// present ids are left as-is), the backup's linking key is only installed
// when this device has none yet - never overwriting an existing wallet.
// That guard is deliberate (a stale/wrong backup must never clobber a
// wallet already holding funds), but it means restore order matters: a
// device that already has ANY wallet - even one just freshly created,
// unrelated to this backup - silently keeps its own key, and this backup's
// bearers merge into storage without ever becoming visible, since they
// don't decrypt under a different key. See linkingKeySkipped above.
export const applyBackup = (data: unknown): RestoreResult => {
  const backup = data as BackupFile
  if (
    backup?.type !== 'lnurlwallet-backup' ||
    backup.version !== 1 ||
    !Array.isArray(backup.bearers)
  ) {
    throw new Error('Not a valid LNURLwallet backup file.')
  }
  const existing = readEncryptedBearers()
  const existingIds = new Set(existing.map(r => r.id))
  let added = 0
  let skipped = 0
  for (const record of backup.bearers) {
    if (
      typeof record?.id !== 'string' ||
      typeof record?.iv !== 'string' ||
      typeof record?.ciphertext !== 'string'
    ) {
      skipped++
      continue
    }
    if (existingIds.has(record.id)) {
      skipped++
      continue
    }
    existing.push({id: record.id, iv: record.iv, ciphertext: record.ciphertext})
    existingIds.add(record.id)
    added++
  }
  writeEncryptedBearers(existing)

  let linkingKeyRestored = false
  let linkingKeySkipped = false
  if (backup.linkingKey) {
    if (savedKeyExists()) {
      linkingKeySkipped = true
    } else {
      restoreLinkingKeyStored(backup.linkingKey)
      linkingKeyRestored = true
    }
  }

  const trustedMintsAdded = Array.isArray(backup.trustedMints)
    ? mergeTrustedMints(backup.trustedMints)
    : 0

  return {
    added,
    skipped,
    linkingKeyRestored,
    linkingKeySkipped,
    trustedMintsAdded
  }
}
