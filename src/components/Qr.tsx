import type {Component} from 'solid-js'

import {copyToClipboard} from '../helpers'
import {QRCodeSVG, ErrorCorrectionLevel} from 'solid-qr-code'

export interface QrProps {
  value: string
  width?: number
  height?: number
}

const Qr: Component<QrProps> = (props: QrProps) => {
  const width = props.width || 200
  const height = props.height || 200
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
