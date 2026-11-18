import { ErpPreview, type ErpState } from '../components/ErpPreview';
import type { ProviderId, ProviderOption } from '../types/api';

/** Page 2 – ERP Integration: Zybo-style Branches Exchange Rate screen (simulation only). */
export function ErpIntegrationPage(props: {
  erp: ErpState;
  provider: ProviderId;
  onProviderChange: (p: ProviderId) => void;
  providerOptions: ProviderOption[];
  countryCode: string | null;
  onCountryChange: (code: string) => void;
}) {
  return <ErpPreview {...props} />;
}
