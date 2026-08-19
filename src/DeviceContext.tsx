import type {Accessor, JSX} from 'solid-js'
import {createContext, createSignal, onMount, useContext} from 'solid-js'

import {
  DeviceClient,
  SerialTransport,
  BleTransport,
  type DeviceInfo,
  type DeviceNote,
  type DeviceTransport
} from './device'
import {HeartwoodTransport} from './heartwoodTransport'
import {notify, NotifyKind} from './helpers'
import {drainPendingDeviceOps} from './deviceQueue'

export type DeviceConnectionState = 'disconnected' | 'connecting' | 'connected'

export type DeviceTransportKind = 'serial' | 'ble' | 'heartwood'

// Which transport last worked, so the next load can bring the vault back
// without a chooser. Not a secret and not note data - plain localStorage,
// same as trustedMints.ts.
const LAST_TRANSPORT_KEY = 'lnurlvault.lastTransport'

const readLastTransport = (): DeviceTransportKind | null => {
  try {
    const raw = localStorage.getItem(LAST_TRANSPORT_KEY)
    return raw === 'serial' || raw === 'ble' || raw === 'heartwood' ? raw : null
  } catch {
    return null
  }
}

const rememberTransport = (kind: DeviceTransportKind | null): void => {
  try {
    if (kind) localStorage.setItem(LAST_TRANSPORT_KEY, kind)
    else localStorage.removeItem(LAST_TRANSPORT_KEY)
  } catch {
    // private browsing, quota - reconnect is a convenience, never required
  }
}

export type DeviceContextType = {
  connectionState: Accessor<DeviceConnectionState>
  info: Accessor<DeviceInfo | null>
  notes: Accessor<DeviceNote[]>
  serialSupported: boolean
  bleSupported: boolean
  connectSerial: () => Promise<void>
  connectBle: () => Promise<void>
  // a Heartwood signer's note locker - same command set over its own
  // binary-framed WebSerial (see heartwoodTransport.ts)
  connectHeartwood: () => Promise<void>
  disconnect: () => Promise<void>
  // true while the on-load silent reconnect is still running, so the pairing
  // UI can hold off offering buttons the owner is about to not need
  reconnecting: Accessor<boolean>
  refresh: () => Promise<void>
  rename: (id: string, label: string) => Promise<void>
  deleteNote: (id: string) => Promise<void>
  // exposed for a later phase (device-backed secrets in the rotate/split/
  // merge/melt flows) - the pairing UI itself never needs it directly
  client: Accessor<DeviceClient | null>
}

const DeviceContext = createContext<DeviceContextType>()

export const DeviceProvider = (props: {children: JSX.Element}) => {
  const [connectionState, setConnectionState] =
    createSignal<DeviceConnectionState>('disconnected')
  const [info, setInfo] = createSignal<DeviceInfo | null>(null)
  const [notes, setNotes] = createSignal<DeviceNote[]>([])
  const [client, setClient] = createSignal<DeviceClient | null>(null)
  const [reconnecting, setReconnecting] = createSignal(false)

  const teardown = () => {
    setClient(null)
    setConnectionState('disconnected')
    setInfo(null)
    setNotes([])
  }

  const refresh = async () => {
    const current = client()
    if (!current) return
    const [deviceInfo, deviceNotes] = await Promise.all([
      current.getInfo(),
      current.listAllNotes()
    ])
    setInfo(deviceInfo)
    setNotes(deviceNotes)
  }

  // shared by connectSerial/connectBle - only the transport's own
  // requestAndConnect() differs between them
  //
  // NOTE on device identity: the vault protocol (docs/PROTOCOL.md in
  // ../../lnurl-vault) exposes NO stable per-device identity to pin to.
  // get_info reports fw_version and board - self-reported software/
  // hardware CLASS identifiers every unit of a build shares - plus
  // volatile diagnostics (boot_count, free_heap), and no other command
  // carries a device key or serial either. Trust-on-first-use pinning is
  // therefore deliberately NOT implemented here: a physically swapped (or
  // hostile) vault answering the same protocol is indistinguishable from
  // the previously paired one, and no pseudo-identity derived from
  // fw_version/board would change that. The mitigations that do exist
  // live elsewhere: every plaintext export is gated by a physical button
  // press on the device itself, and pending-op recovery (deviceQueue.ts)
  // only ever pushes confirm/mark_spent at note ids this wallet staged.
  const connectWith = async (
    requestAndConnect: () => Promise<DeviceTransport>,
    kind?: DeviceTransportKind
  ) => {
    if (connectionState() !== 'disconnected') return
    setConnectionState('connecting')
    try {
      const transport = await requestAndConnect()
      const newClient = new DeviceClient(transport)
      newClient.onDisconnect(teardown)
      setClient(newClient)
      setConnectionState('connected')
      if (kind) rememberTransport(kind)
      // reconciles any confirm/mark_spent this device missed from a
      // previous session that dropped mid-operation (see deviceQueue.ts) -
      // drainPendingDeviceOps never throws, it just leaves whatever didn't
      // go through queued for the next connect to retry
      await drainPendingDeviceOps(newClient)
      try {
        await refresh()
      } catch (err) {
        // paired but the first read failed - stay connected, the pairing
        // UI can retry with its own Refresh button rather than unwind an
        // otherwise-live session over one flaky read
        notify((err as Error).message, NotifyKind.ERROR)
      }
    } catch (err) {
      setConnectionState('disconnected')
      // the browser's own device chooser being dismissed isn't a real
      // error - both WebSerial and Web Bluetooth reject requestPort/
      // requestDevice with this DOMException name on cancel
      if ((err as Error)?.name !== 'NotFoundError') {
        notify((err as Error).message, NotifyKind.ERROR)
      }
    }
  }

  const connectSerial = () =>
    connectWith(() => SerialTransport.requestAndConnect(), 'serial')
  const connectBle = () =>
    connectWith(() => BleTransport.requestAndConnect(), 'ble')
  const connectHeartwood = () =>
    connectWith(() => HeartwoodTransport.requestAndConnect(), 'heartwood')

  // Does what answered actually speak the vault protocol? getPorts() hands
  // back every port this origin was ever granted, so a reconnect must not
  // assume the first one is a vault - see SerialTransport.tryReconnect.
  const probe = async (transport: DeviceTransport): Promise<boolean> => {
    try {
      await new DeviceClient(transport).getInfo()
      return true
    } catch {
      return false
    }
  }

  // On load, bring back the vault the owner already granted, with no click.
  // Only for a transport that has worked here before: an unprompted scan of
  // every granted port on a wallet nobody has ever paired is noise.
  //
  // Heartwood is deliberately not auto-reconnected. It rides the same
  // WebSerial permission with different framing (heartwoodTransport.ts), and
  // guessing wrong means talking newline JSON at a binary-framed signer.
  onMount(async () => {
    const last = readLastTransport()
    if (!last || last === 'heartwood') return
    if (connectionState() !== 'disconnected') return
    setReconnecting(true)
    try {
      const transport =
        last === 'serial'
          ? await SerialTransport.tryReconnect(probe)
          : await BleTransport.tryReconnect(probe)
      if (!transport) return
      const newClient = new DeviceClient(transport)
      newClient.onDisconnect(teardown)
      setClient(newClient)
      setConnectionState('connected')
      await drainPendingDeviceOps(newClient)
      await refresh().catch(() => {})
    } catch {
      // nothing granted, unplugged, or in use elsewhere. Silent by design:
      // this runs without anyone asking for it, so it must never interrupt
    } finally {
      setReconnecting(false)
    }
  })

  const disconnect = async () => {
    const current = client()
    if (current) await current.disconnect().catch(() => {})
    // An explicit disconnect is a decision, so stop bringing it back.
    rememberTransport(null)
    teardown()
  }

  const rename = async (id: string, label: string) => {
    const current = client()
    if (!current) return
    await current.rename(id, label)
    await refresh()
  }

  const deleteNote = async (id: string) => {
    const current = client()
    if (!current) return
    await current.delete(id)
    await refresh()
  }

  return (
    <DeviceContext.Provider
      value={{
        connectionState,
        info,
        notes,
        serialSupported: SerialTransport.isSupported(),
        bleSupported: BleTransport.isSupported(),
        connectSerial,
        connectBle,
        connectHeartwood,
        disconnect,
        reconnecting,
        refresh,
        rename,
        deleteNote,
        client
      }}
    >
      {props.children}
    </DeviceContext.Provider>
  )
}

export const useDevice = () => {
  const context = useContext(DeviceContext)
  if (!context) {
    throw new Error('useDevice: cannot find a DeviceContext')
  }
  return context
}
