// Lookup guardrails + per-request settings.
// Ports the defaults from backend/.env.example / load_lookup_settings().

export const SETTINGS = {
  maxParcels: 150,
  maxRequests: 80,
  adjacentLimitPerParcel: 50,
  maxLlmNormalizations: 25,
  retentionDays: 30,
};

export const REQUEST = {
  timeoutMs: 20000,
  retries: 2,
  backoffMs: 800,
  minIntervalMs: 150,
};
