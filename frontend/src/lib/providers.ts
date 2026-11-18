import type { ProviderId } from '../types/api';

/** One badge colour per provider, used everywhere a provider is named (dashboard, comparison, ERP rows). */
export function providerTone(id: string): 'info' | 'violet' | 'orange' {
  return id === 'oanda' ? 'orange' : id === 'currencyapi-com' ? 'violet' : 'info';
}

export const PROVIDER_IDS: ProviderId[] = ['exchangerate-api', 'currencyapi-com', 'oanda'];
