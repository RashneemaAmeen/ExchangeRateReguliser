import type { Request, Response } from 'express';
import type { AppConfig } from '../config.js';
import { normaliseCurrencyCode, parseCurrencyList } from '../lib/currency.js';
import { parsePositiveDecimal } from '../lib/decimal.js';
import { AppError } from '../lib/errors.js';
import { compareSources, type RateSourceRegistry } from '../services/rateSources.js';

const isTrue = (v: unknown) => v === 'true' || v === '1';

export function createExchangeRateController(sources: RateSourceRegistry, config: AppConfig) {
  /**
   * ?provider=exchangerate-api | currencyapi-com | oanda (defaults to the existing integration).
   * ?rateType=midpoint|bid|ask previews another OANDA rate type; it only affects this read and never the ERP rates.
   */
  const rateTypeOf = (req: Request) => (typeof req.query.rateType === 'string' && req.query.rateType ? req.query.rateType : undefined);
  const serviceOf = (req: Request) =>
    sources.get(typeof req.query.provider === 'string' ? req.query.provider : undefined).ratesFor(rateTypeOf(req));
  const targetOf = (req: Request) =>
    req.query.target === undefined ? config.targetCurrency : normaliseCurrencyCode(req.query.target, 'target');

  return {
    /** GET /api/exchange-rates?target=AED&currencies=USD,EUR&refresh=true  (currencies=all for every currency) */
    async list(req: Request, res: Response) {
      const target = targetOf(req);
      const currencies =
        req.query.currencies === 'all' ? ('all' as const) : parseCurrencyList(req.query.currencies);
      const result = await serviceOf(req).getRates(
        target,
        currencies === 'all' ? 'all' : currencies.length ? currencies : config.defaultCurrencies,
        isTrue(req.query.refresh),
      );
      res.json(result);
    },

    /** GET /api/exchange-rates/:currency */
    async single(req: Request, res: Response) {
      const target = targetOf(req);
      const code = normaliseCurrencyCode(req.params.currency);
      if (code === target) {
        throw new AppError(400, 'VALIDATION_ERROR', `${code} is the target currency; its rate is always 1.`);
      }
      const result = await serviceOf(req).getRates(target, [code], isTrue(req.query.refresh));
      const rate = result.rates[0];
      if (!rate) {
        throw new AppError(404, 'UNSUPPORTED_CURRENCY', `${code} is not available from ${result.provider.name}.`);
      }
      const { rates: _rates, unsupported: _u, ...meta } = result;
      res.json({ ...meta, rate });
    },

    /** GET /api/exchange-rates/currencies */
    async currencies(req: Request, res: Response) {
      const target = targetOf(req);
      res.json({ target, currencies: await serviceOf(req).getSupportedCurrencies(target) });
    },

    /** GET /api/exchange-rates/status */
    status(req: Request, res: Response) {
      res.json(serviceOf(req).getStatus());
    },

    /** GET /api/providers – selectable rate providers (no secrets). */
    providers(_req: Request, res: Response) {
      res.json({ default: sources.default.id, providers: sources.describe() });
    },

    /** GET /api/exchange-rates/compare?target=AED&currencies=USD,EUR&refresh=true – all providers side by side (read-only). */
    async compare(req: Request, res: Response) {
      const target = targetOf(req);
      const list = parseCurrencyList(req.query.currencies);
      const currencies = list.length ? list : config.defaultCurrencies;
      res.json(await compareSources(sources, config, target, currencies, isTrue(req.query.refresh), rateTypeOf(req)));
    },

    /** GET /api/exchange-rates/convert?from=USD&to=INR&amount=100 */
    async convert(req: Request, res: Response) {
      const target = targetOf(req);
      const from = normaliseCurrencyCode(req.query.from, 'from');
      const to = normaliseCurrencyCode(req.query.to, 'to');
      const amount = parsePositiveDecimal(req.query.amount);
      if (!amount) {
        throw new AppError(400, 'VALIDATION_ERROR', 'amount must be a positive decimal number with up to 15 integer and 12 fraction digits.');
      }
      res.json(await serviceOf(req).convert(target, from, to, amount));
    },

    /** GET /api/exchange-rates/history?currency=USD&days=7 */
    async history(req: Request, res: Response) {
      const target = targetOf(req);
      const currency = normaliseCurrencyCode(req.query.currency, 'currency');
      const days = req.query.days === undefined ? 7 : Number(req.query.days);
      if (!Number.isInteger(days) || days < 1 || days > 31) {
        throw new AppError(400, 'VALIDATION_ERROR', 'days must be an integer between 1 and 31.');
      }
      res.json(await serviceOf(req).getHistory(target, currency, days));
    },
  };
}
