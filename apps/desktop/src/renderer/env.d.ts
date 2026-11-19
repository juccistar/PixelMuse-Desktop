import type { NativeDesktopApi } from '../shared/native-contracts';

declare global {
  interface Window {
    ecomgen: NativeDesktopApi;
  }
}

export {};
