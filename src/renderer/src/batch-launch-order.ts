import type { BrowserProfileView } from '../../shared/types'

export const BATCH_LAUNCH_GAP_MS = 1_500

export function orderBatchLaunchProfiles(profiles: BrowserProfileView[]): BrowserProfileView[] {
  return [...profiles].sort((first, second) =>
    first.serialNumber - second.serialNumber || first.id.localeCompare(second.id)
  )
}

export function waitForBatchLaunchGap(milliseconds = BATCH_LAUNCH_GAP_MS): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
