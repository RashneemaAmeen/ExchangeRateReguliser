import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createProviderChain } from './providers/index.js';
import type { DailyRateJob } from './services/dailyRateJob.js';

const config = loadConfig();
const providers = createProviderChain(config);
const app = createApp({ config, providers });

app.listen(config.port, () => {
  console.log(`Exchange Rate POC API listening on http://localhost:${config.port}`);
  console.log(`  Target currency : ${config.targetCurrency}`);
  console.log(`  Providers       : ${providers.map((p) => p.info.id).join(' -> ')}`);
  console.log(`  Cache TTL       : ${config.cacheTtlSeconds}s`);
  const d = config.dailyFetch;
  console.log(
    `  Auto update     : ${d.enabled ? `every day at ${d.time} (${d.timeZone}) – ${d.providers.join(", ")}` : "disabled"}`,
  );
  console.log(
    config.erpEditor.passcode
      ? `  Rate editor     : ${config.erpEditor.name} (only this user can edit rates)`
      : '  Rate editor     : not set – add ERP_EDITOR_PASSCODE to backend/.env to allow manual edits',
  );
  (app.locals.dailyJob as DailyRateJob).start();
});
