import type {Component} from 'solid-js'
import {Show, createSignal, onCleanup, onMount} from 'solid-js'

export type ScannerProps = {
  // called once with the first QR payload that `accept` (if given) lets through
  onScan: (value: string) => void
  accept?: (value: string) => boolean
}

// Camera QR scanning via the native BarcodeDetector API - no scanning
// library, which keeps this static bundle small. Browsers without it
// (currently Firefox) get a hint to use Paste instead.
const Scanner: Component<ScannerProps> = props => {
  let videoRef: HTMLVideoElement | undefined
  let stream: MediaStream | null = null
  let timer: ReturnType<typeof setInterval> | null = null
  const [error, setError] = createSignal<string | null>(null)
  const supported = 'BarcodeDetector' in window

  const stop = () => {
    if (timer) clearInterval(timer)
    timer = null
    stream?.getTracks().forEach(track => track.stop())
    stream = null
  }

  onMount(async () => {
    if (!supported) return
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {facingMode: 'environment'}
      })
    } catch {
      setError('Camera access was denied - paste the token instead.')
      return
    }
    if (!videoRef) return
    videoRef.srcObject = stream
    await videoRef.play()

    const detector = new (window as any).BarcodeDetector({
      formats: ['qr_code']
    })
    timer = setInterval(async () => {
      if (!videoRef || videoRef.readyState < 2) return
      try {
        const codes = await detector.detect(videoRef)
        for (const code of codes) {
          const value = String(code.rawValue || '')
          if (!value) continue
          if (props.accept && !props.accept(value)) continue
          stop()
          props.onScan(value)
          return
        }
      } catch {
        // a single failed detection pass is not fatal - just try again
      }
    }, 250)
  })

  onCleanup(stop)

  return (
    <Show
      when={supported}
      fallback={
        <p class="warning">
          This browser has no built-in QR detector (BarcodeDetector API). Use
          the Paste action instead.
        </p>
      }
    >
      <Show
        when={error()}
        fallback={
          // playsinline/muted so iOS Safari renders the stream inline
          // instead of forcing fullscreen playback
          <video ref={videoRef} class="scanner" playsinline muted />
        }
      >
        <p class="warning">{error()}</p>
      </Show>
    </Show>
  )
}
export default Scanner
