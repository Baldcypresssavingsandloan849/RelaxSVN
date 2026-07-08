/// <reference types="vite/client" />

import type { SvnDesktopApi } from '../../shared/types';

declare global {
  interface Window {
    svnDesktop: SvnDesktopApi;
  }
}
