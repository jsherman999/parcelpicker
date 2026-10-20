// Small shared helpers for the in-browser build.

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Escape untrusted text (county-supplied owner names, parcel IDs) before
// interpolating it into HTML.
export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// fetch() with an AbortController-based timeout so a hung request can't stall a run.
export async function fetchWithTimeout(url, options = {}, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Raised when a run uses up its request budget. The runner treats it as a
// limit (the run is "capped") once it has a seed, like reaching maxParcels.
export class BudgetExceededError extends Error {
  constructor(maxRequests) {
    super(
      `Request budget of ${maxRequests} exceeded while querying parcel providers. ` +
        "Increase maxRequests if needed."
    );
    this.name = "BudgetExceededError";
  }
}

// Request budget mirrors backend/services/base.py RequestBudget.
export class RequestBudget {
  constructor(maxRequests) {
    this.maxRequests = maxRequests;
    this.usedRequests = 0;
  }

  consume() {
    this.usedRequests += 1;
    if (this.usedRequests > this.maxRequests) throw new BudgetExceededError(this.maxRequests);
  }
}
