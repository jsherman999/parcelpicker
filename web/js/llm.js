// Browser port of backend/services/llm.py.
// Config (provider/model/key) is supplied by the user and stored only in this
// browser's localStorage. Calls go directly to the provider (CORS-verified for
// OpenAI and OpenRouter). Every method degrades gracefully: on missing config
// or any error it returns the deterministic fallback, so the app never blocks.

const STORAGE_KEY = "pp.llm";

const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";
const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";

const DEFAULTS = { provider: "openai", model: "gpt-4o-mini", apiKey: "", enabled: true };

export class LLMService {
  constructor() {
    this._config = LLMService._load();
  }

  static _load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        return {
          provider: parsed.provider || DEFAULTS.provider,
          model: parsed.model || DEFAULTS.model,
          apiKey: parsed.apiKey || "",
          enabled: parsed.enabled !== false,
        };
      }
    } catch (err) {
      // ignore malformed storage
    }
    return { ...DEFAULTS };
  }

  getConfig() {
    return { ...this._config };
  }

  saveConfig(patch) {
    this._config = { ...this._config, ...patch };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this._config));
    } catch (err) {
      // storage may be unavailable (private mode); keep in-memory config
    }
  }

  get isAvailable() {
    return Boolean(this._config.enabled && this._config.apiKey && this._config.provider);
  }

  async normalizeOwnerName(ownerName) {
    const owner = String(ownerName || "").trim();
    if (!owner || !this.isAvailable) return owner;

    const prompt =
      "Normalize this parcel owner name for grouping without guessing new facts. " +
      "Keep legal identity intact (LLC, TRUST, INC), remove extra punctuation/spaces, " +
      "and return only the normalized owner name on one line. " +
      `Input: ${owner}`;
    try {
      const text = await this._chat(prompt);
      const normalized = text.trim().replace(/^"|"$/g, "");
      return normalized || owner;
    } catch (err) {
      return owner;
    }
  }

  async summarizeLookup({ inputAddress, ringsRequested, parcelCount, ownerCount }) {
    if (!this.isAvailable) return null;

    const prompt =
      "Write a concise 1-2 sentence summary for a parcel lookup run. " +
      "Do not invent facts. " +
      `Address: ${inputAddress}. Rings requested: ${ringsRequested}. ` +
      `Parcels found: ${parcelCount}. Unique owners: ${ownerCount}.`;
    try {
      const text = (await this._chat(prompt)).trim();
      return text || null;
    } catch (err) {
      return null;
    }
  }

  async _chat(prompt) {
    const { provider, model, apiKey } = this._config;
    const url = provider === "openrouter" ? OPENROUTER_CHAT_URL : OPENAI_CHAT_URL;

    const headers = {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    };
    if (provider === "openrouter") {
      headers["HTTP-Referer"] = location.origin;
      headers["X-Title"] = "ParcelPicker";
    }

    const body = JSON.stringify({
      model,
      temperature: 0,
      messages: [
        { role: "system", content: "You are a precise data-normalization assistant." },
        { role: "user", content: prompt },
      ],
    });

    const res = await fetch(url, { method: "POST", headers, body });
    if (!res.ok) {
      const text = (await res.text()).slice(0, 300);
      throw new Error(`LLM HTTP ${res.status}: ${text}`);
    }
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (content === undefined || content === null) {
      throw new Error("LLM response missing content");
    }
    return String(content);
  }
}
