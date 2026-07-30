import type {Component} from 'solid-js'

import {copyToClipboard} from '../helpers'
import {QRCodeSVG, ErrorCorrectionLevel} from 'solid-qr-code'

export interface QrProps {
  value: string
  width?: number
  height?: number
}

const Qr: Component<QrProps> = (props: QrProps) => {
  // the actual on-screen size is controlled by CSS (.qrcode scales the SVG
  // to fill its box - see style.scss) - this only sets the coordinate
  // space the library draws into, so a higher default gives denser codes
  // (e.g. a long bolt11 invoice vs. a short LNURL) more sub-pixel
  // precision before that scaling, instead of looking uneven/blurry
  const width = props.width || 256
  const height = props.height || 256
  return (
    <div class="qrcode" onClick={() => copyToClipboard(props.value)}>
      <QRCodeSVG
        {...props}
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
}
export default Qr
