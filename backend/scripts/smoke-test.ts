/**
 * Live smoke test against the REAL providers (needs internet).
 * Run: npm run smoke   (from the repo root or backend/)
 * Verifies each provider responds, includes the required currencies, and that
 * the USD->AED rate is consistent with the AED peg (3.6725).
 */
import { loadConfig } from '../src/config.js';
import { Decimal } from '../src/lib/decimal.js';
import { createProvider } from '../src/providers/index.js';
import { normaliseRate } from '../src/services/rateMath.js';

const REQUIRED = ['USD', 'EUR', 'GBP', 'INR', 'SAR', 'CNY'];
const config = loadConfig();
let failures = 0;

for (const id of ['open-er-api', 'currency-api']) {
  const provider = createProvider(id, config);
  process.stdout.write(`\n[${id}] fetching latest ${config.targetCurrency} rates... `);
  try {
    const t0 = Date.now();
    const snap = await provider.fetchLatest(config.targetCurrency);
    console.log(`OK in ${Date.now() - t0} ms – effective ${snap.effectiveDate}, ${Object.keys(snap.quotes).length} ISO currencies`);
    for (const code of REQUIRED) {
      const r = normaliseRate(snap, code, config.rateDecimalPlaces);
      console.log(`   ${r.direction.padEnd(32)} (provider quote 1 ${config.targetCurrency} = ${r.inverseRate} ${code})`);
    }
    const usd = new Decimal(normaliseRate(snap, 'USD', 8).rate);
    const drift = usd.minus('3.6725').abs();
    if (drift.gt('0.001')) {
      failures++;
      console.log(`   !! USD/AED ${usd} deviates from peg 3.6725 by ${drift}`);
    } else {
      console.log(`   USD/AED peg check passed (|${usd} - 3.6725| = ${drift.toFixed(8)})`);
    }
    if (provider.fetchHistorical) {
      const d = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
      const h = await provider.fetchHistorical(config.targetCurrency, d);
      console.log(`   history ${d}: ${normaliseRate(h, 'USD', 8).direction} (snapshot date ${h.effectiveDate})`);
    }
  } catch (e) {
    failures++;
    console.log(`FAILED – ${(e as Error).message}`);
  }
}

console.log(failures ? `\n${failures} check(s) failed.` : '\nAll live provider checks passed.');
process.exit(failures ? 1 : 0);
