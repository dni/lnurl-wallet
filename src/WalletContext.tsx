import type {Accessor, JSX} from 'solid-js'
import {createContext, createSignal, onMount, useContext} from 'solid-js'

import {
  deriveWalletLinkingKey,
  deriveBearerAesKey,
  saveLinkingKey,
  savedKeyExists,
  savedKeyIsEncrypted,
  getPlainLinkingKey,
  decryptSavedLinkingKey,
  clearSavedLinkingKey,
  linkingPubKeyHex
} from './keys'
import type {Bearer} from './storage'
import {
  loadBearers,
  persistBearer,
  deleteBearerRecord,
  newBearerId
} from './storage'
import {serverOf} from './lnurlcash'

// 'none': no wallet on this device yet -> setup
// 'locked': linking key present but password-encrypted -> unlock
// 'unlocked': linking key (and thus the bearer AES key) in memory
export type WalletState = 'none' | 'locked' | 'unlocked'

export type NewBearer = {
  url: string
  callback: string
  amount: number
  verified: boolean
}

export type WalletContextType = {
  state: Accessor<WalletState>
  bearers: Accessor<Bearer[]>
  pubkey: Accessor<string | null>
  encrypted: () => boolean
  setup: (seedPhrase: string, password?: string) => Promise<void>
  unlock: (password?: string) => Promise<void>
  lock: () => void
  forgetWallet: () => void
  addBearer: (note: NewBearer) => Promise<Bearer>
  updateBearer: (
    id: string,
    changes: Partial<Omit<Bearer, 'id'>>
  ) => Promise<void>
  removeBearer: (id: string) => void
  reloadBearers: () => Promise<void>
  // re-reads localStorage after something outside this context changed it
  // (e.g. a backup restore installing a linking key on a fresh device)
  refreshState: () => void
}

const WalletContext = createContext<WalletContextType>()

// a plaintext-stored key also starts 'locked' - the provider's onMount
// unlocks it immediately without a password, keeping a single code path
// for deriving the AES key and loading bearers
const initialState = (): WalletState => (savedKeyExists() ? 'locked' : 'none')

export const WalletProvider = (props: {children: JSX.Element}) => {
  const [state, setState] = createSignal<WalletState>(initialState())
  const [bearers, setBearers] = createSignal<Bearer[]>([])
  const [pubkey, setPubkey] = createSignal<string | null>(null)
  let aesKey: CryptoKey | null = null

  const activate = async (linkingKey: Uint8Array) => {
    aesKey = await deriveBearerAesKey(linkingKey)
    setPubkey(linkingPubKeyHex(linkingKey))
    setBearers(await loadBearers(aesKey))
    setState('unlocked')
  }

  const setup = async (seedPhrase: string, password?: string) => {
    const linkingKey = deriveWalletLinkingKey(seedPhrase)
    await saveLinkingKey(linkingKey, password)
    await activate(linkingKey)
  }

  const unlock = async (password?: string) => {
    const linkingKey = savedKeyIsEncrypted()
      ? await decryptSavedLinkingKey(password || '')
      : getPlainLinkingKey()
    if (!linkingKey) throw new Error('No wallet on this device.')
    await activate(linkingKey)
  }

  // only meaningful for a password-encrypted key - a plaintext one would
  // just auto-unlock again, so the UI only offers Lock when encrypted() is true
  const lock = () => {
    if (!savedKeyIsEncrypted()) return
    aesKey = null
    setPubkey(null)
    setBearers([])
    setState('locked')
  }

  // wipes the linking key from this device - bearer ciphertexts stay in
  // localStorage, recoverable later by restoring the same seed phrase
  const forgetWallet = () => {
    clearSavedLinkingKey()
    aesKey = null
    setPubkey(null)
    setBearers([])
    setState('none')
  }

  const requireKey = (): CryptoKey => {
    if (!aesKey) throw new Error('Wallet is locked.')
    return aesKey
  }

  const addBearer = async (note: NewBearer): Promise<Bearer> => {
    const now = Date.now()
    const bearer: Bearer = {
      id: newBearerId(),
      ...note,
      createdAt: now,
      updatedAt: now
    }
    await persistBearer(requireKey(), bearer)
    setBearers(prev => [bearer, ...prev])
    return bearer
  }

  const updateBearer = async (
    id: string,
    changes: Partial<Omit<Bearer, 'id'>>
  ) => {
    const current = bearers().find(b => b.id === id)
    if (!current) return
    const updated: Bearer = {...current, ...changes, updatedAt: Date.now()}
    await persistBearer(requireKey(), updated)
    setBearers(prev => prev.map(b => (b.id === id ? updated : b)))
  }

  const removeBearer = (id: string) => {
    deleteBearerRecord(id)
    setBearers(prev => prev.filter(b => b.id !== id))
  }

  const reloadBearers = async () => {
    setBearers(await loadBearers(requireKey()))
  }

  const refreshState = () => {
    if (state() === 'unlocked') return
    setState(initialState())
  }

  onMount(() => {
    if (state() === 'locked' && !savedKeyIsEncrypted()) {
      unlock().catch(() => setState('none'))
    }
  })

  return (
    <WalletContext.Provider
      value={{
        state,
        bearers,
        pubkey,
        encrypted: savedKeyIsEncrypted,
        setup,
        unlock,
        lock,
        forgetWallet,
        addBearer,
        updateBearer,
        removeBearer,
        reloadBearers,
        refreshState
      }}
    >
      {props.children}
    </WalletContext.Provider>
  )
}

export const useWallet = () => {
  const context = useContext(WalletContext)
  if (!context) {
    throw new Error('useWallet: cannot find a WalletContext')
  }
  return context
}

// bearers grouped by issuing server, for the wallet page's per-server sections
export const groupByServer = (bearers: Bearer[]): [string, Bearer[]][] => {
  const groups = new Map<string, Bearer[]>()
  for (const bearer of bearers) {
    const server = serverOf(bearer.url)
    const list = groups.get(server) || []
    list.push(bearer)
    groups.set(server, list)
  }
  return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))
}
