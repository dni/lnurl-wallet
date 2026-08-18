import type {Accessor, JSX} from 'solid-js'
import {createContext, createSignal, useContext} from 'solid-js'

import {
  DeviceClient,
  SerialTransport,
  BleTransport,
  type DeviceInfo,
  type DeviceNote
} from './device'
import {notify, NotifyKind} from './helpers'
import {drainPendingDeviceOps} from './deviceQueue'

export type DeviceConnectionState = 'disconnected' | 'connecting' | 'connected'

export type DeviceContextType = {
  connectionState: Accessor<DeviceConnectionState>
  info: Accessor<DeviceInfo | null>
  notes: Accessor<DeviceNote[]>
  serialSupported: boolean
  bleSupported: boolean
  connectSerial: () => Promise<void>
  connectBle: () => Promise<void>
  disconnect: () => Promise<void>
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
  const connectWith = async (
    requestAndConnect: () => Promise<SerialTransport | BleTransport>
  ) => {
    if (connectionState() !== 'disconnected') return
    setConnectionState('connecting')
    try {
      const transport = await requestAndConnect()
      const newClient = new DeviceClient(transport)
      newClient.onDisconnect(teardown)
      setClient(newClient)
      setConnectionState('connected')
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
    connectWith(() => SerialTransport.requestAndConnect())
  const connectBle = () => connectWith(() => BleTransport.requestAndConnect())

  const disconnect = async () => {
    const current = client()
    if (current) await current.disconnect().catch(() => {})
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
        disconnect,
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
