/**
 * @file i18n.tsx
 * @description Silent background IP-based PayPal currency detector.
 * - Never prompts for browser geolocation permissions.
 * - Maps PayPal-eligible countries to their supported PayPal currency.
 * - Strictly defaults to USD ($) for non-PayPal countries or when offline.
 */
'use client';

import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';

export type SupportedCurrencyCode = 'USD' | 'EUR' | 'GBP' | 'CAD' | 'AUD' | 'JPY' | 'SGD' | 'CHF';

export const CURRENCY_STORAGE_KEY = 'voxtab_currency';

export interface CurrencyMeta {
  code: SupportedCurrencyCode;
  symbol: string;
  zeroDecimal: boolean;
}

export const CURRENCY_MAP: Record<SupportedCurrencyCode, CurrencyMeta> = {
  USD: { code: 'USD', symbol: '$', zeroDecimal: false },
  EUR: { code: 'EUR', symbol: '€', zeroDecimal: false },
  GBP: { code: 'GBP', symbol: '£', zeroDecimal: false },
  CAD: { code: 'CAD', symbol: 'CA$', zeroDecimal: false },
  AUD: { code: 'AUD', symbol: 'A$', zeroDecimal: false },
  JPY: { code: 'JPY', symbol: '¥', zeroDecimal: true },
  SGD: { code: 'SGD', symbol: 'S$', zeroDecimal: false },
  CHF: { code: 'CHF', symbol: 'CHF ', zeroDecimal: false },
};

const EURO_COUNTRIES = new Set([
  'AT', 'BE', 'CY', 'EE', 'FI', 'FR', 'DE', 'GR', 'IE', 'IT',
  'LV', 'LT', 'LU', 'MT', 'NL', 'PT', 'SK', 'SI', 'ES', 'HR',
]);

/**
 * Maps an ISO-3166 alpha-2 country code to a PayPal currency code.
 * Non-PayPal-eligible countries strictly fall back to USD ($).
 */
export function countryToPayPalCurrency(countryCode?: string | null): SupportedCurrencyCode {
  const cc = (countryCode || '').trim().toUpperCase();
  if (!cc) return 'USD';
  if (cc === 'US') return 'USD';
  if (cc === 'GB' || cc === 'UK') return 'GBP';
  if (cc === 'CA') return 'CAD';
  if (cc === 'AU') return 'AUD';
  if (cc === 'JP') return 'JPY';
  if (cc === 'SG') return 'SGD';
  if (cc === 'CH' || cc === 'LI') return 'CHF';
  if (EURO_COUNTRIES.has(cc)) return 'EUR';
  return 'USD';
}

export function getCurrencyMeta(code?: string | null): CurrencyMeta {
  if (code && code in CURRENCY_MAP) {
    return CURRENCY_MAP[code as SupportedCurrencyCode];
  }
  return CURRENCY_MAP.USD;
}

export function getActiveCurrencyCode(): SupportedCurrencyCode {
  if (typeof window === 'undefined') return 'USD';
  try {
    const saved = sessionStorage.getItem(CURRENCY_STORAGE_KEY);
    if (saved && saved in CURRENCY_MAP) {
      return saved as SupportedCurrencyCode;
    }
  } catch {}
  return 'USD';
}

export function formatMoneyCents(cents: number, currencyCodeOverride?: string): string {
  const code = currencyCodeOverride || getActiveCurrencyCode();
  const meta = getCurrencyMeta(code);
  const isNeg = cents < 0;
  const absCents = Math.abs(Number(cents) || 0);
  const amount = absCents / 100;
  const formatted = meta.zeroDecimal ? Math.round(amount).toLocaleString() : amount.toFixed(2);
  return `${isNeg ? '-' : ''}${meta.symbol}${formatted}`;
}

interface CurrencyContextValue {
  currency: SupportedCurrencyCode;
  currencyMeta: CurrencyMeta;
  fmtMoney: (cents: number) => string;
}

const CurrencyContext = createContext<CurrencyContextValue>({
  currency: 'USD',
  currencyMeta: CURRENCY_MAP.USD,
  fmtMoney: (cents) => formatMoneyCents(cents, 'USD'),
});

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [currency, setCurrency] = useState<SupportedCurrencyCode>('USD');

  useEffect(() => {
    let cancelled = false;

    try {
      const cached = sessionStorage.getItem(CURRENCY_STORAGE_KEY);
      if (cached && cached in CURRENCY_MAP) {
        setCurrency(cached as SupportedCurrencyCode);
        return;
      }
    } catch {}

    // Silent background IP check (zero browser permission prompts)
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);

    fetch('https://ipwho.is/', { signal: controller.signal })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled) return;
        const detected =
          data?.success !== false && typeof data?.country_code === 'string'
            ? countryToPayPalCurrency(data.country_code)
            : 'USD';
        setCurrency(detected);
        try {
          sessionStorage.setItem(CURRENCY_STORAGE_KEY, detected);
        } catch {}
      })
      .catch(() => {
        // Silently keep USD ($) on any network error or blocker
      })
      .finally(() => clearTimeout(timer));

    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, []);

  const fmtMoney = useCallback(
    (cents: number) => formatMoneyCents(cents, currency),
    [currency]
  );

  const currencyMeta = getCurrencyMeta(currency);

  return (
    <CurrencyContext.Provider value={{ currency, currencyMeta, fmtMoney }}>
      {children}
    </CurrencyContext.Provider>
  );
}

export function useI18n() {
  return useContext(CurrencyContext);
}
