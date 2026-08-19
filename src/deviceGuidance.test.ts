import {describe, expect, it} from 'vitest'

import {
  approvalInstruction,
  inputWarning,
  gatedCommandsUnavailable,
  canShowQrHandoff,
  QR_MIN_PANEL_PIXELS
} from './deviceGuidance'
import type {DeviceCapabilities, DeviceInfo, DeviceInputs} from './device'

const info = (
  capabilities?: Partial<DeviceCapabilities>,
  inputs?: DeviceInputs
): DeviceInfo => ({
  fw_version: '0.0.7',
  note_count: 0,
  pending_count: 0,
  ...(capabilities
    ? {
        capabilities: {
          buttons: 2,
          touch: false,
          gated: true,
          display: {width: 320, height: 170},
          transports: ['serial', 'ble'],
          ...capabilities
        }
      }
    : {}),
  ...(inputs ? {inputs} : {})
})

describe('approvalInstruction', () => {
  it('names both buttons on a two-button vault', () => {
    const text = approvalInstruction(info({buttons: 2}))
    expect(text).toMatch(/hold/i)
    expect(text).toMatch(/cancel/i)
  })

  // The case the old generic wording got wrong. Someone hunting for a cancel
  // button that does not exist sits there until the request times out, which
  // is exactly what they should have been told to do on purpose.
  it('tells a one-button owner that timing out IS the refusal', () => {
    const text = approvalInstruction(info({buttons: 1}))
    expect(text).toMatch(/hold/i)
    expect(text).toMatch(/time out/i)
    expect(text).not.toMatch(/press the other button/i)
  })

  it('asks for a swipe on a touch-only vault', () => {
    const text = approvalInstruction(info({buttons: 0, touch: true}))
    expect(text).toMatch(/swipe/i)
  })

  // A build with no confirmation hook refuses every gated command outright.
  // Saying so beats letting someone find out by having an export refused.
  it('says up front when a vault cannot ask at all', () => {
    const text = approvalInstruction(info({gated: false}))
    expect(text).toMatch(/refuse/i)
    expect(text).not.toMatch(/hold/i)
  })

  // Older firmware sends no capabilities. The fallback has to be true on
  // every board, including ones that did not exist when it was written.
  it('falls back to wording that is true everywhere', () => {
    expect(approvalInstruction(info())).toBe(
      'Confirm on your vault when it asks.'
    )
    expect(approvalInstruction(null)).toBe(
      'Confirm on your vault when it asks.'
    )
  })

  // No buttons, no touch, but the device claims it can ask. Rather than
  // invent a gesture, say the safe thing.
  it('does not invent a gesture for hardware it does not model', () => {
    const text = approvalInstruction(
      info({buttons: 0, touch: false, gated: true})
    )
    expect(text).toBe('Confirm on your vault when it asks.')
  })
})

describe('inputWarning', () => {
  it('says nothing when both buttons are healthy', () => {
    expect(inputWarning(info({}, {confirm: 'ok', cancel: 'ok'}))).toBeNull()
  })

  it('says nothing when the firmware does not report inputs', () => {
    expect(inputWarning(info())).toBeNull()
    expect(inputWarning(null)).toBeNull()
  })

  // 'unknown' is not a fault. It means the device has not yet seen that pin
  // released, which is the ordinary state for the first few seconds of a boot.
  it('does not raise a fault for an undecided input', () => {
    expect(
      inputWarning(info({}, {confirm: 'unknown', cancel: 'unknown'}))
    ).toBeNull()
  })

  // The ESP32-S3 case. The important part is that the vault is still SAFE -
  // a stuck button cannot approve anything on its own - so the warning must
  // not read as "your money is at risk".
  it('explains a stuck cancel as a lost ability, not a danger', () => {
    const text = inputWarning(info({}, {confirm: 'ok', cancel: 'stuck'}))!
    expect(text).toMatch(/safe to use/i)
    expect(text).toMatch(/time out/i)
  })

  it('is blunter about a stuck confirm, which kills every gated command', () => {
    const text = inputWarning(info({}, {confirm: 'stuck', cancel: 'ok'}))!
    expect(text).toMatch(/nothing.*approved/i)
    expect(text).not.toMatch(/safe to use/i)
  })

  it('handles both at once without stacking two warnings', () => {
    const text = inputWarning(info({}, {confirm: 'stuck', cancel: 'stuck'}))!
    expect(text).toMatch(/neither/i)
  })
})

describe('gatedCommandsUnavailable', () => {
  it('is false on a healthy vault', () => {
    expect(
      gatedCommandsUnavailable(info({}, {confirm: 'ok', cancel: 'ok'}))
    ).toBe(false)
  })

  it('is true when the build has no confirmation wired', () => {
    expect(gatedCommandsUnavailable(info({gated: false}))).toBe(true)
  })

  it('is true when the confirm button itself is wedged', () => {
    expect(
      gatedCommandsUnavailable(info({}, {confirm: 'stuck', cancel: 'ok'}))
    ).toBe(true)
  })

  // A stuck CANCEL still leaves every gated command usable - it can be
  // approved, just not refused. Disabling the controls here would be wrong.
  it('is false when only cancel is wedged', () => {
    expect(
      gatedCommandsUnavailable(info({}, {confirm: 'ok', cancel: 'stuck'}))
    ).toBe(false)
  })

  // Silence from older firmware is not evidence of a fault.
  it('is false when the device says nothing about itself', () => {
    expect(gatedCommandsUnavailable(info())).toBe(false)
    expect(gatedCommandsUnavailable(null)).toBe(false)
  })
})

describe('canShowQrHandoff', () => {
  it('is true on a panel with room for a note-sized code', () => {
    expect(canShowQrHandoff(info({display: {width: 320, height: 170}}))).toBe(
      true
    )
  })

  // The T-Dongle-S3, 80x160, sits right on the line: 80 pixels across a
  // ~45-module code is under two pixels per module.
  it('is true at exactly the limit and false below it', () => {
    const at = {width: 160, height: QR_MIN_PANEL_PIXELS}
    const below = {width: 160, height: QR_MIN_PANEL_PIXELS - 1}
    expect(canShowQrHandoff(info({display: at}))).toBe(true)
    expect(canShowQrHandoff(info({display: below}))).toBe(false)
  })

  // A panel that never came up reports zero, and a QR nobody can see is not
  // a handoff.
  it('is false when the panel did not come up', () => {
    expect(canShowQrHandoff(info({display: {width: 0, height: 0}}))).toBe(false)
  })

  it('is false when the device does not describe its panel', () => {
    expect(canShowQrHandoff(info())).toBe(false)
    expect(canShowQrHandoff(null)).toBe(false)
  })
})
