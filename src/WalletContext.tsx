import type {Accessor, JSX} from 'solid-js'
import {
  createContext,
  createEffect,
  createSignal,
  onCleanup,
  onMount,
  useContext
} from 'solid-js'
import toast from 'solid-toast'

import {notify, NotifyKind} from './helpers'
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
import type {Bearer, ActivityEvent, ActivityKind} from './storage'
import {
  loadBearers,
  persistBearer,
  deleteBearerRecord,
  clearAllBearers,
  newBearerId,
  loadActivity,
  persistActivityEvent,
  clearAllActivity,
  newActivityId
} from './storage'
import {serverOf} from './lnurlcash'
import {lockTrustedMint} from './trustedMints'

// 'none': no wallet on this device yet -> setup
// 'locked': linking key present but password-encrypted -> unlock
// 'unlocked': linking key (and thus the bearer AES key) in memory
export type WalletState = 'none' | 'locked' | 'unlocked'

export type NewBearer = {
  url: string
  callback: string
  amount: number
  verified: boolean
  mintPubkey?: string
  deviceId?: string
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
  activity: Accessor<ActivityEvent[]>
  // fire-and-forget from a caller's point of view - failures are swallowed
  // (see logActivity) so a full log can never block or fail the action it's
  // recording
  logActivity: (kind: ActivityKind, message: string) => void
  clearActivity: () => void
}

const WalletContext = createContext<WalletContextType>()

// idle-timeout auto-lock: only meaningful for a password-encrypted key (see
// lock() below, which no-ops otherwise) - 5 minutes with no activity
// anywhere in the tab locks the wallet, with a 30s warning toast first so a
// holder who's just reading (not moving the mouse) can stay unlocked
// instead of getting dropped back to the unlock screen mid-task
const AUTO_LOCK_MS = 5 * 60 * 1000
const LOCK_WARNING_MS = 30 * 1000

// a plaintext-stored key also starts 'locked' - the provider's onMount
// unlocks it immediately without a password, keeping a single code path
// for deriving the AES key and loading bearers
const initialState = (): WalletState => (savedKeyExists() ? 'locked' : 'none')

export const WalletProvider = (props: {children: JSX.Element}) => {
  const [state, setState] = createSignal<WalletState>(initialState())
  const [bearers, setBearers] = createSignal<Bearer[]>([])
  const [activity, setActivity] = createSignal<ActivityEvent[]>([])
  const [pubkey, setPubkey] = createSignal<string | null>(null)
  let aesKey: CryptoKey | null = null

  // idle-timeout auto-lock bookkeeping - see AUTO_LOCK_MS/LOCK_WARNING_MS
  let lastActivity = Date.now()
  let warningToastId: string | null = null
  const [warningSecondsLeft, setWarningSecondsLeft] = createSignal<
    number | null
  >(null)

  const dismissWarning = () => {
    if (warningToastId) {
      toast.dismiss(warningToastId)
      warningToastId = null
    }
    setWarningSecondsLeft(null)
  }

  // any real interaction - a passive activity event, or the warning toast's
  // own button - restarts the 5-minute clock and clears the countdown,
  // whichever the holder notices first
  const postponeLock = () => {
    lastActivity = Date.now()
    dismissWarning()
  }

  const showLockWarning = () => {
    if (warningToastId) return
    warningToastId = toast.custom(
      <span>
        Locking due to inactivity in {warningSecondsLeft()}s.&nbsp;
        <button onClick={postponeLock}>Stay unlocked</button>
      </span>,
      {duration: Infinity}
    )
  }

  const activate = async (linkingKey: Uint8Array) => {
    aesKey = await deriveBearerAesKey(linkingKey)
    setPubkey(linkingPubKeyHex(linkingKey))
    const loaded = await loadBearers(aesKey)
    setBearers(loaded)
    setActivity(await loadActivity(aesKey))
    // grandfather in every mint already backing a held bearer as trusted -
    // holding funds there already implied trusting it, long before this
    // list existed to ask about it
    for (const bearer of loaded) {
      if (bearer.mintPubkey) {
        lockTrustedMint(serverOf(bearer.url), bearer.mintPubkey)
      }
    }
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
    dismissWarning()
    aesKey = null
    setPubkey(null)
    setBearers([])
    setActivity([])
    setState('locked')
  }

  // wipes this wallet from the device entirely - the linking key, every
  // bearer record, and the activity log. Not recoverable by restoring the
  // same seed afterward (the ciphertexts themselves are gone); only a
  // backup downloaded before this runs can bring the notes back - the UI
  // should prompt for one
  const forgetWallet = () => {
    clearSavedLinkingKey()
    clearAllBearers()
    clearAllActivity()
    aesKey = null
    setPubkey(null)
    setBearers([])
    setActivity([])
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
    // holding a bearer from this mint trusts it by default, whether it was
    // already trusted (from a lookup, a manual add, or another bearer) or
    // not - this is the one path that never asks (see trustedMints.ts)
    if (bearer.mintPubkey) {
      lockTrustedMint(serverOf(bearer.url), bearer.mintPubkey)
    }
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
    if (updated.mintPubkey) {
      lockTrustedMint(serverOf(updated.url), updated.mintPubkey)
    }
  }

  const removeBearer = (id: string) => {
    deleteBearerRecord(id)
    setBearers(prev => prev.filter(b => b.id !== id))
  }

  const reloadBearers = async () => {
    setBearers(await loadBearers(requireKey()))
  }

  // best-effort and silent on failure - a wallet action that already
  // succeeded (the note was split/melted/whatever) must never surface an
  // error, or leave itself un-undoable, just because the log entry for it
  // couldn't be written
  const logActivity = (kind: ActivityKind, message: string) => {
    if (!aesKey) return
    const event: ActivityEvent = {
      id: newActivityId(),
      kind,
      message,
      createdAt: Date.now()
    }
    setActivity(prev => [event, ...prev])
    persistActivityEvent(aesKey, event).catch(() => {})
  }

  const clearActivity = () => {
    clearAllActivity()
    setActivity([])
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

  // ticks once a second while unlocked and encrypted (the only state auto-
  // lock applies to - lock() itself is a no-op otherwise), comparing wall-
  // clock time against lastActivity rather than relying on a single
  // setTimeout, since a backgrounded tab throttles timers but Date.now()
  // still reflects real elapsed time whenever this next gets to run
  createEffect(() => {
    if (state() !== 'unlocked' || !savedKeyIsEncrypted()) {
      dismissWarning()
      return
    }
    lastActivity = Date.now()
    const interval = setInterval(() => {
      const elapsed = Date.now() - lastActivity
      if (elapsed >= AUTO_LOCK_MS) {
        lock()
        notify('Wallet locked due to inactivity.', NotifyKind.ERROR)
      } else if (elapsed >= AUTO_LOCK_MS - LOCK_WARNING_MS) {
        setWarningSecondsLeft(Math.ceil((AUTO_LOCK_MS - elapsed) / 1000))
        showLockWarning()
      } else if (warningToastId) {
        dismissWarning()
      }
    }, 1000)
    onCleanup(() => clearInterval(interval))
  })

  // warns before a refresh, tab close, or navigating away while unlocked
  // and encrypted - aesKey lives in memory only (see activate/lock above),
  // so any of those effectively re-locks the wallet, requiring the
  // password again to get back in. Skipped for a plaintext-stored key,
  // which just silently re-unlocks itself on load (see the onMount above)
  // - nothing is actually at stake there, so nothing to warn about
  createEffect(() => {
    if (state() !== 'unlocked' || !savedKeyIsEncrypted()) return
    const warnBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      // legacy assignment some browsers still require to trigger the
      // native confirm prompt at all - the string itself is ignored by
      // every modern browser, which shows its own generic "leave site?"
      // wording instead (a security measure against fake warning text)
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', warnBeforeUnload)
    onCleanup(() =>
      window.removeEventListener('beforeunload', warnBeforeUnload)
    )
  })

  onMount(() => {
    // once the warning is up, passive activity (just moving the mouse
    // toward the toast) is deliberately ignored - only its own "Stay
    // unlocked" button (postponeLock) dismisses it, so the button can't
    // vanish out from under the pointer a moment before the click lands
    const registerActivity = () => {
      if (state() === 'unlocked' && !warningToastId) lastActivity = Date.now()
    }
    const events = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll']
    for (const event of events) {
      window.addEventListener(event, registerActivity, {passive: true})
    }
    onCleanup(() => {
      for (const event of events) {
        window.removeEventListener(event, registerActivity)
      }
    })
  })

  return (
    <WalletContext.Provider
      value={{
        state,
        bearers,
        activity,
        logActivity,
        clearActivity,
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
