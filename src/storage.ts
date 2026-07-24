import type {EncryptedRecordParts, StoredSecret} from './keys'
import {
  encryptRecord,
  decryptRecord,
  getSavedLinkingKeyStored,
  savedKeyExists,
  savedKeyIsEncrypted,
  restoreLinkingKeyStored
} from './keys'

// One bearer token held by this wallet - the decrypted, in-memory shape.
// `url` is the decoded token URL (the secret!); the displayable lnurlcash1
// form is re-encoded from it on demand.
export type Bearer = {
  id: string
  url: string
  amount: number // msat, last known - refreshed against the server on demand
  pending: boolean // minted but its invoice not yet paid
  createdAt: number
  updatedAt: number
}

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

// Backup file: everything exactly as it sits in localStorage - bearer
// ciphertexts always, the linking-key record only when it is itself
// password-encrypted. A plaintext linking key never leaves the device in a
// backup; the seed phrase is the recovery path for it instead.
export type BackupFile = {
  type: 'lnurlwallet-backup'
  version: 1
  createdAt: number
  linkingKey?: StoredSecret
  bearers: EncryptedBearerRecord[]
}

export const buildBackup = (): BackupFile => {
  const backup: BackupFile = {
    type: 'lnurlwallet-backup',
    version: 1,
    createdAt: Date.now(),
    bearers: readEncryptedBearers()
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
}

// merges a backup into localStorage: bearer records are added by id (already
// present ids are left as-is), the backup's linking key is only installed
// when this device has none yet - never overwriting an existing wallet
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
  if (backup.linkingKey && !savedKeyExists()) {
    restoreLinkingKeyStored(backup.linkingKey)
    linkingKeyRestored = true
  }
  return {added, skipped, linkingKeyRestored}
}
