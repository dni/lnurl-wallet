import type {DeviceInfo} from './device'

// Turns get_info's capabilities/inputs into the sentence a person reads.
//
// The wallet has been guessing: "confirm on your device" was written when both
// boards had two buttons. It is wrong on a one-button board, meaningless on a
// touchscreen, and misleading on a vault whose cancel button is wedged.
//
// Pure functions over DeviceInfo, so the wording is tested, not eyeballed.
// One rule throughout: never claim more than the device reported. Older
// firmware sends neither field, so the fallback must be true everywhere.

// What the owner will have to do on the device when it asks. Shown for the
// whole session, not only while something is pending, so every variant is
// worded as a condition - a bare imperative reads as "do this now" and sends
// people looking at a vault that is idle and has nothing to show them.
// Always returns a usable sentence; the generic one is correct everywhere,
// just less helpful.
export const approvalInstruction = (info: DeviceInfo | null): string => {
  const caps = info?.capabilities
  if (!caps) return 'Confirm on your vault when it asks.'

  // gated:false refuses every gated command outright. Say so before the
  // owner discovers it via an `unsupported` reply.
  if (!caps.gated) {
    return 'This vault cannot ask you to confirm, so it will refuse anything that needs approval.'
  }

  if (caps.buttons >= 2) {
    return 'When your vault asks, hold its confirm button for two seconds to approve, or press the other button to cancel.'
  }
  if (caps.buttons === 1) {
    // No cancel gesture exists here; someone hunting for one just waits.
    return 'When your vault asks, hold its button for two seconds to approve. It has no cancel button, so to refuse, leave it alone and let the request time out.'
  }
  if (caps.touch) {
    return 'When your vault asks, swipe to approve, or dismiss the prompt to cancel.'
  }
  // No buttons, no touch, but it claims it can ask. Don't invent a gesture.
  return 'Confirm on your vault when it asks.'
}

// A fault worth raising, or null. About consequence, not diagnosis: "cancel
// is stuck" is a fact about a GPIO; the owner needs what it means for them.
export const inputWarning = (info: DeviceInfo | null): string | null => {
  const inputs = info?.inputs
  if (!inputs) return null

  const confirmStuck = inputs.confirm === 'stuck'
  const cancelStuck = inputs.cancel === 'stuck'

  if (confirmStuck && cancelStuck) {
    return 'Neither button on this vault is responding, so it cannot approve or refuse anything. Requests that need confirming will time out. Unplug it and reconnect, and if that does not clear it the buttons need looking at.'
  }
  if (confirmStuck) {
    // The worse of the two: every gated command is dead.
    return 'This vault’s confirm button is not responding, so nothing on it can be approved. Anything that needs approval will time out. Unplug it and reconnect, and if that does not clear it the button needs looking at.'
  }
  if (cancelStuck) {
    return 'This vault’s cancel button is not responding. It is still safe to use - a stuck button cannot approve anything on its own - but you can no longer refuse a request on the device. To refuse one, leave it alone and let it time out.'
  }
  return null
}

// True when a physically-gated command cannot succeed on this device at all,
// so a caller can disable the control rather than offer an action that will
// come back `unsupported`.
export const gatedCommandsUnavailable = (info: DeviceInfo | null): boolean => {
  const caps = info?.capabilities
  if (!caps) return false // unknown is not the same as broken
  if (!caps.gated) return true
  return info?.inputs?.confirm === 'stuck'
}

// Whether this vault can show a note as a QR for an in-person handoff.
// A note-sized code is ~45 modules square including its quiet zone, and a
// panel that cannot give each module a pixel cannot render a scannable one.
// The T-Dongle-S3 (80x160) sits on that line. 0 means the panel never came up.
export const QR_MIN_PANEL_PIXELS = 45

export const canShowQrHandoff = (info: DeviceInfo | null): boolean => {
  const display = info?.capabilities?.display
  if (!display) return false
  const shorter = Math.min(display.width, display.height)
  return shorter >= QR_MIN_PANEL_PIXELS
}
