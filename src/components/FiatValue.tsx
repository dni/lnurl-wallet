import type {Component} from 'solid-js'
import {Show} from 'solid-js'

import {formatFiat} from '../currency'

export type FiatValueProps = {
  // msat, matching every other amount in this codebase (see helpers.ts's
  // own msatToSats) - converted to sats internally before pricing
  msat: number
}

// renders nothing when no currency is selected or no rate has been fetched
// yet (see currency.ts's formatFiat) - a caller never needs its own <Show>
// around this
const FiatValue: Component<FiatValueProps> = props => {
  const fiat = () => formatFiat(Math.floor(props.msat / 1000))
  return (
    <Show when={fiat()}>
      <span class="fiat-value">&#8776;&nbsp;{fiat()}</span>
    </Show>
  )
}
export default FiatValue
