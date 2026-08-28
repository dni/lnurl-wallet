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
  // ports already granted for this origin - reconnecting to one needs no
  // user gesture, unlike requestPort()
  getPorts(): Promise<SerialPort[]>
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

// ---- Web NFC (Chrome on Android only) ----
// used by helpers.ts's readNfcTag() to read an NFC tag's URL/text record as
// an alternative to camera-scanning its QR code or pasting it by hand - a
// global constructor, not a Navigator property, unlike Serial/Bluetooth
// above. Minimal surface only - just what readNfcTag actually calls.
interface NDEFRecord {
  readonly recordType: string
  readonly data?: DataView
  readonly encoding?: string
}

interface NDEFMessage {
  readonly records: NDEFRecord[]
}

interface NDEFReadingEvent extends Event {
  readonly message: NDEFMessage
}

interface NDEFReader extends EventTarget {
  scan(): Promise<void>
  onreading: ((event: NDEFReadingEvent) => void) | null
  onreadingerror: ((event: Event) => void) | null
}

declare var NDEFReader: {
  prototype: NDEFReader
  new (): NDEFReader
}
