/// <reference types="vite/client" />

import type { BrowserApi } from '../../shared/types'

declare global {
  interface Window {
    browserApi: BrowserApi
  }
}

export {}
