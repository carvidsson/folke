import "server-only";

/**
 * Price list for cost tracking, in SEK per million tokens.
 *
 * Prices are configured here when a provider and model are approved and
 * reviewed regularly. Unknown models are recorded with cost 0 and a warning,
 * so usage is never lost even if the price list lags behind.
 */
interface ModelPrice {
  inputSekPerMTok: number;
  outputSekPerMTok: number;
}

const PRICES: Record<string, ModelPrice> = {
  "mock:mock": { inputSekPerMTok: 0, outputSekPerMTok: 0 },
};

export function estimateCostSek(provider: string, model: string, inputTokens: number, outputTokens: number): number {
  const price = PRICES[`${provider}:${model}`];
  if (!price) {
    console.warn(`[pricing] no price configured for ${provider}:${model}`);
    return 0;
  }
  const cost = (inputTokens * price.inputSekPerMTok + outputTokens * price.outputSekPerMTok) / 1_000_000;
  return Math.round(cost * 10_000) / 10_000;
}
