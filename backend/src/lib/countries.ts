import { AppError } from './errors.js';

/**
 * Countries shown in the ERP Integration Preview, mirroring Zybo's "Branches Exchange Rate" screen.
 * Rates are approved at COUNTRY level: an approved rate applies to every branch in that country.
 * Branch data is not modelled in the POC (no Zybo connection).
 */
export interface ErpCountry {
  /** ISO 3166-1 alpha-2 code. */
  code: string;
  name: string;
  /** The country's base (functional) currency – rates are expressed as units of this per 1 foreign unit. */
  baseCurrency: string;
}

export const ERP_COUNTRIES: readonly ErpCountry[] = [
  { code: 'AE', name: 'United Arab Emirates', baseCurrency: 'AED' },
  { code: 'SA', name: 'Saudi Arabia', baseCurrency: 'SAR' },
  { code: 'BH', name: 'Bahrain', baseCurrency: 'BHD' },
  { code: 'CN', name: 'China', baseCurrency: 'CNY' },
  { code: 'IN', name: 'India', baseCurrency: 'INR' },
  { code: 'KW', name: 'Kuwait', baseCurrency: 'KWD' },
  { code: 'OM', name: 'Oman', baseCurrency: 'OMR' },
  { code: 'QA', name: 'Qatar', baseCurrency: 'QAR' },
  { code: 'TH', name: 'Thailand', baseCurrency: 'THB' },
  { code: 'GB', name: 'United Kingdom', baseCurrency: 'GBP' },
  { code: 'US', name: 'United States', baseCurrency: 'USD' },
];

export function findCountry(code: string): ErpCountry {
  const c = ERP_COUNTRIES.find((x) => x.code === code.trim().toUpperCase());
  if (!c) {
    throw new AppError(400, 'VALIDATION_ERROR', `Unknown ERP country "${code}". Expected one of: ${ERP_COUNTRIES.map((x) => x.code).join(', ')}.`);
  }
  return c;
}

/** The country whose base currency is the company's functional currency (falls back to the first). */
export function defaultCountry(functionalCurrency: string): ErpCountry {
  return ERP_COUNTRIES.find((c) => c.baseCurrency === functionalCurrency) ?? ERP_COUNTRIES[0]!;
}
