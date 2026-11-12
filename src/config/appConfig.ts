/**
 * @file appConfig.ts
 * @description Centralized storage key and public origin helper for VoxTab.
 */

export interface AppConfig {
  appName: string;
  storageKey: string;
}

export const APP_CONFIG: AppConfig = {
  appName: 'VoxTab',
  storageKey: 'voxtab_ledger_vault_v1',
};

/**
 * Public origin for links opened outside this browser tab: PayPal return/cancel URLs and share links.
 */
export function getPublicAppOrigin(): string {
  if (typeof window !== 'undefined') {
    return window.location.origin;
  }
  return (process.env.NEXT_PUBLIC_APP_URL || '').trim().replace(/\/+$/, '');
}
