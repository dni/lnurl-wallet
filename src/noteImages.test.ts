import {describe, expect, it} from 'vitest'

import {payRequestImage} from './noteImages'

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUg=='
const JPEG_B64 = '/9j/4AAQSkZJRg=='

const metadata = (entries: unknown): string => JSON.stringify(entries)

describe('payRequestImage', () => {
  it('returns a data URL for a png metadata entry', () => {
    const result = payRequestImage(
      metadata([
        ['text/plain', 'mint me'],
        ['image/png;base64', PNG_B64]
      ])
    )
    expect(result).toBe(`data:image/png;base64,${PNG_B64}`)
  })

  it('returns a data URL for a jpeg metadata entry', () => {
    const result = payRequestImage(metadata([['image/jpeg;base64', JPEG_B64]]))
    expect(result).toBe(`data:image/jpeg;base64,${JPEG_B64}`)
  })

  it('returns null when metadata has no image entry', () => {
    expect(payRequestImage(metadata([['text/plain', 'mint me']]))).toBeNull()
  })

  it('returns null for malformed metadata', () => {
    expect(payRequestImage('not json')).toBeNull()
    expect(payRequestImage(metadata({}))).toBeNull()
    expect(payRequestImage(metadata('just a string'))).toBeNull()
  })

  it('ignores unknown image types', () => {
    expect(
      payRequestImage(metadata([['image/svg+xml;base64', PNG_B64]]))
    ).toBeNull()
  })

  it('skips entries that are not valid base64', () => {
    const result = payRequestImage(
      metadata([
        ['image/png;base64', 'not base64!!!'],
        ['image/jpeg;base64', JPEG_B64]
      ])
    )
    expect(result).toBe(`data:image/jpeg;base64,${JPEG_B64}`)
  })

  it('skips oversized entries', () => {
    const huge = 'A'.repeat(262_148)
    expect(payRequestImage(metadata([['image/png;base64', huge]]))).toBeNull()
  })
})
