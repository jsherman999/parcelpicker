// Small shared helpers for the in-browser build.

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

// Request budget mirrors backend/services/base.py RequestBudget.
export class RequestBudget {
  constructor(maxRequests) {
    this.maxRequests = maxRequests;
    this.usedRequests = 0;
  }

  consume() {
    this.usedRequests += 1;
    if (this.usedRequests > this.maxRequests) {
      throw new Error(
        "Request budget exceeded while querying parcel providers. " +
          "Increase maxRequests if needed."
      );
    }
  }
}
