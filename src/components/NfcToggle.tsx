import type {Component} from 'solid-js'
import {Show} from 'solid-js'
import {MdSharpNfc} from 'solid-icons/md'

import {nfcSupported, readNfcTag} from '../helpers'

export type NfcToggleProps = {
  onScan: (value: string) => void
  accept?: (value: string) => boolean
}

// a tap-to-read alternative to ScanToggle's camera scan, same onScan/accept
// contract - drops into any existing paste-input-row unchanged. Web NFC is
// Chrome-on-Android only (see helpers.ts's nfcSupported), so this renders
// nothing at all anywhere else rather than a button that would just fail
// on click
const NfcToggle: Component<NfcToggleProps> = props => {
  const read = async () => {
    const value = await readNfcTag()
    if (value === null) return
    if (props.accept && !props.accept(value)) return
    props.onScan(value)
  }

  return (
    <Show when={nfcSupported()}>
      <button
        type="button"
        class="icon-btn paste-nfc-btn"
        title="Read an NFC tag"
        onClick={read}
      >
        <MdSharpNfc />
      </button>
    </Show>
  )
}
export default NfcToggle
