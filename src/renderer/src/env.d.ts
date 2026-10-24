/// <reference types="vite/client" />
import type { GalaxyApi } from '@shared/api'

declare global {
  interface Window {
    galaxy: GalaxyApi
  }
}

export {}
