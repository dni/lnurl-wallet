import type {Component} from 'solid-js'
import {Show} from 'solid-js'
import {IoDownloadSharp} from 'solid-icons/io'

import {copyToClipboard} from '../helpers'
import {QRCodeSVG, ErrorCorrectionLevel} from 'solid-qr-code'

export interface QrProps {
  value: string
  width?: number
  height?: number
  // e.g. `lightning:${invoice}` - wraps the code in a link so a phone can
  // offer its own "open in wallet" picker on tap, same as scanning it would
  href?: string
}

const Qr: Component<QrProps> = (props: QrProps) => {
  // the actual on-screen size is controlled by CSS (.qrcode scales the SVG
  // to fill its box - see style.scss) - this only sets the coordinate
  // space the library draws into, so a higher default gives denser codes
  // (e.g. a long bolt11 invoice vs. a short LNURL) more sub-pixel
  // precision before that scaling, instead of looking uneven/blurry
  const width = props.width || 256
  const height = props.height || 256
  let frameRef: HTMLDivElement | undefined

  // QRCodeSVG renders straight into the DOM with no ref of its own, so the
  // rendered <svg> is pulled back out of frameRef rather than built again
  // from props here - keeps the downloaded file pixel-identical to what's
  // on screen
  const download = (e: MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const svg = frameRef?.querySelector('svg')
    if (!svg) return
    const source = new XMLSerializer().serializeToString(svg)
    const blob = new Blob([source], {type: 'image/svg+xml'})
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'qrcode.svg'
    a.click()
    URL.revokeObjectURL(url)
  }

  const code = (
    <div class="qrcode" onClick={() => copyToClipboard(props.value)}>
      <QRCodeSVG
        backgroundColor="white"
        backgroundAlpha={1}
        foregroundColor="black"
        foregroundAlpha={1}
        width={width}
        height={height}
        value={props.value}
        level={ErrorCorrectionLevel.LOW}
      />
    </div>
  )
  return (
    <div class="qr-frame" ref={frameRef}>
      <Show when={props.href} fallback={code}>
        <a class="qrcode-link" href={props.href}>
          {code}
        </a>
      </Show>
      <button
        type="button"
        class="icon-btn qr-download-btn"
        title="Download QR code as SVG"
        onClick={download}
      >
        <IoDownloadSharp />
      </button>
    </div>
  )
}
export default Qr
