import { describe, expect, it, vi } from 'vitest'
import type { BrowserProfileView } from '../../shared/types'
import { orderBatchLaunchProfiles, waitForBatchLaunchGap } from './batch-launch-order'

function profile(id: string, serialNumber: number): BrowserProfileView {
  return { id, serialNumber } as BrowserProfileView
}

describe('batch launch ordering', () => {
  it('uses permanent environment numbers instead of selection or update order', () => {
    expect(orderBatchLaunchProfiles([
      profile('late', 18),
      profile('first', 2),
      profile('middle', 9)
    ]).map((item) => item.serialNumber)).toEqual([2, 9, 18])
  })

  it('paces launches instead of releasing a concurrent group', async () => {
    vi.useFakeTimers()
    const gap = waitForBatchLaunchGap(1_500)
    let settled = false
    void gap.then(() => { settled = true })
    await vi.advanceTimersByTimeAsync(1_499)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toBe(true)
    vi.useRealTimers()
  })
})
