export function normalizeSeed(seed: number) {
  if (!Number.isFinite(seed)) {
    return 1;
  }

  const normalized = Math.abs(Math.trunc(seed)) % 2147483647;
  return normalized === 0 ? 1 : normalized;
}

export function nextRandom(seed: number) {
  const nextSeed = (seed * 48271) % 2147483647;
  return {
    seed: nextSeed,
    value: nextSeed / 2147483647,
  };
}

export function sampleExponentialMs(ratePerHour: number, seed: number) {
  if (!Number.isFinite(ratePerHour) || ratePerHour <= 0) {
    return {
      seed,
      intervalMs: Number.POSITIVE_INFINITY,
    };
  }

  const { seed: nextSeed, value } = nextRandom(seed);
  const safeValue = Math.min(1 - 1e-9, Math.max(1e-9, value));
  const intervalHours = -Math.log(1 - safeValue) / ratePerHour;

  return {
    seed: nextSeed,
    intervalMs: intervalHours * 60 * 60 * 1000,
  };
}
