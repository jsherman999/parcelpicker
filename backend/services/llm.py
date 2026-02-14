from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

import httpx


OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions"
OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions"


@dataclass(slots=True)
class LLMConfig:
    provider: str
    model: str
    openai_api_key: str | None
    openrouter_api_key: str | None
    enabled: bool


class LLMService:
    def __init__(self, config: LLMConfig) -> None:
        self._config = config

    @property
    def is_available(self) -> bool:
        if not self._config.enabled:
            return False

        provider = self._config.provider.lower().strip()
        if provider == "openai":
            return bool(self._config.openai_api_key)
        if provider == "openrouter":
            return bool(self._config.openrouter_api_key)
        return False

    async def normalize_owner_name(self, owner_name: str) -> str:
        if not owner_name.strip() or not self.is_available:
            return owner_name.strip()

        prompt = (
            "Normalize this parcel owner name for grouping without guessing new facts. "
            "Keep legal identity intact (LLC, TRUST, INC), remove extra punctuation/spaces, "
            "and return only the normalized owner name on one line. "
            f"Input: {owner_name}"
        )
        response_text = await self._chat(prompt)
        normalized = response_text.strip().strip('"')
        if not normalized:
            return owner_name.strip()
        return normalized

    async def summarize_lookup(
        self,
        *,
        input_address: str,
        rings_requested: int,
        parcel_count: int,
        owner_count: int,
    ) -> str | None:
        if not self.is_available:
            return None

        prompt = (
            "Write a concise 1-2 sentence summary for a parcel lookup run. "
            "Do not invent facts. "
            f"Address: {input_address}. Rings requested: {rings_requested}. "
            f"Parcels found: {parcel_count}. Unique owners: {owner_count}."
        )
        summary = await self._chat(prompt)
        text = summary.strip()
        return text if text else None

    async def _chat(self, prompt: str) -> str:
        provider = self._config.provider.lower().strip()
        if provider == "openai":
            return await self._chat_openai(prompt)
        if provider == "openrouter":
            return await self._chat_openrouter(prompt)
        raise RuntimeError(f"Unsupported LLM provider: {self._config.provider}")

    async def _chat_openai(self, prompt: str) -> str:
        api_key = self._config.openai_api_key or ""
        payload = {
            "model": self._config.model,
            "temperature": 0,
            "messages": [
                {
                    "role": "system",
                    "content": "You are a precise data-normalization assistant.",
                },
                {"role": "user", "content": prompt},
            ],
        }
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }
        return await self._run_chat_request(OPENAI_CHAT_URL, headers, payload)

    async def _chat_openrouter(self, prompt: str) -> str:
        api_key = self._config.openrouter_api_key or ""
        payload = {
            "model": self._config.model,
            "temperature": 0,
            "messages": [
                {
                    "role": "system",
                    "content": "You are a precise data-normalization assistant.",
                },
                {"role": "user", "content": prompt},
            ],
        }
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "HTTP-Referer": "http://localhost:8090",
            "X-Title": "ParcelPicker",
        }
        return await self._run_chat_request(OPENROUTER_CHAT_URL, headers, payload)

    async def _run_chat_request(
        self,
        url: str,
        headers: dict[str, str],
        payload: dict[str, Any],
    ) -> str:
        timeout = httpx.Timeout(20.0)
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.post(url, headers=headers, json=payload)
            response.raise_for_status()
            data = response.json()

        try:
            return str(data["choices"][0]["message"]["content"])
        except Exception as exc:
            raise RuntimeError(f"LLM response parse failed: {json.dumps(data)[:300]}") from exc
