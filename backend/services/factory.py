from __future__ import annotations

import httpx

from backend.services.hennepin import HennepinParcelProvider
from backend.services.provider import ParcelProvider
from backend.services.stlouis import StLouisParcelProvider
from backend.services.wright import WrightParcelService


# Registry of all supported county providers.
# New providers should be imported and added here.
_PROVIDER_REGISTRY: dict[str, type[ParcelProvider]] = {
    "wright": WrightParcelService,
    "hennepin": HennepinParcelProvider,
    "st_louis": StLouisParcelProvider,
}


def get_provider(
    county: str,
    *,
    client: httpx.AsyncClient | None = None,
    timeout_seconds: float = 20.0,
    max_retries: int = 2,
    retry_backoff_seconds: float = 0.8,
    min_interval_seconds: float = 0.15,
) -> ParcelProvider:
    """Instantiate a parcel provider for the given county.

    Args:
        county: County slug (e.g. "wright", "hennepin", "st_louis").
        client: Optional shared HTTP client.
        timeout_seconds: Per-request timeout.
        max_retries: Number of retries on transient failures.
        retry_backoff_seconds: Base backoff between retries.
        min_interval_seconds: Minimum interval between requests.

    Returns:
        A ParcelProvider instance for the requested county.

    Raises:
        ValueError: If the county slug is not recognized.
    """
    key = county.strip().lower()
    cls = _PROVIDER_REGISTRY.get(key)
    if cls is None:
        available = ", ".join(sorted(_PROVIDER_REGISTRY))
        raise ValueError(
            f"Unknown county provider '{county}'. Available: {available}"
        )

    # Wright-specific kwargs; future providers may need their own.
    if cls is WrightParcelService:
        return WrightParcelService(
            client=client,
            timeout_seconds=timeout_seconds,
            max_retries=max_retries,
            retry_backoff_seconds=retry_backoff_seconds,
            min_interval_seconds=min_interval_seconds,
        )

    # Fallback for providers that accept standard init.
    return cls(  # type: ignore[return-value]
        client=client,
        timeout_seconds=timeout_seconds,
        max_retries=max_retries,
        retry_backoff_seconds=retry_backoff_seconds,
        min_interval_seconds=min_interval_seconds,
    )


def list_counties() -> list[str]:
    """Return all supported county slugs."""
    return sorted(_PROVIDER_REGISTRY)


def register_provider(slug: str, provider_cls: type[ParcelProvider]) -> None:
    """Register a new county provider. Used by new providers at import time."""
    _PROVIDER_REGISTRY[slug] = provider_cls
