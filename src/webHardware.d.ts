// Minimal ambient declarations for the two experimental Web APIs
// device.ts's transports depend on (Web Serial, Web Bluetooth) - Chrome/Edge
// only, feature-detected at runtime (SerialTransport.isSupported() /
// BleTransport.isSupported()). Neither ships in TypeScript's bundled DOM
// lib; this is only the surface device.ts actually calls, not the full spec.

interface SerialPort {
  readonly readable: ReadableStream<Uint8Array> | null
  readonly writable: WritableStream<Uint8Array> | null
  open(options: {baudRate: number}): Promise<void>
  close(): Promise<void>
}

interface Serial extends EventTarget {
  requestPort(): Promise<SerialPort>
}

interface BluetoothRemoteGATTCharacteristic extends EventTarget {
  writeValueWithoutResponse(data: BufferSource): Promise<void>
  startNotifications(): Promise<BluetoothRemoteGATTCharacteristic>
  readonly value: DataView | null
}

interface BluetoothRemoteGATTService {
  getCharacteristic(uuid: string): Promise<BluetoothRemoteGATTCharacteristic>
}

interface BluetoothRemoteGATTServer {
  connect(): Promise<BluetoothRemoteGATTServer>
  getPrimaryService(uuid: string): Promise<BluetoothRemoteGATTService>
  disconnect(): void
}

interface BluetoothDevice extends EventTarget {
  readonly gatt?: BluetoothRemoteGATTServer
}

interface Bluetooth {
  requestDevice(options: {
    filters: {services: string[]}[]
  }): Promise<BluetoothDevice>
}

interface Navigator {
  readonly serial?: Serial
  readonly bluetooth?: Bluetooth
}
