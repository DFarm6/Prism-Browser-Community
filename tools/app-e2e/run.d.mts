export interface CleanupDependencies {
  remove?: (
    path: string,
    options: { recursive: true; force: true }
  ) => Promise<void>
  wait?: (milliseconds: number) => Promise<void>
  attempts?: number
}

export function cleanupRetryDelay(attempt: number): number
export function removeTemporaryTree(path: string, dependencies?: CleanupDependencies): Promise<void>
