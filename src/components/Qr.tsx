import type {Component} from 'solid-js'
import {Show} from 'solid-js'

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
    <Show when={props.href} fallback={code}>
      <a class="qrcode-link" href={props.href}>
        {code}
      </a>
    </Show>
  )
}
export default Qr
