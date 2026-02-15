from __future__ import annotations

import csv
import io
import logging
import os
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from backend.db import ParcelDatabase
from backend.services.llm import LLMConfig, LLMService
from backend.services.runner import ParcelLookupRunner, load_lookup_settings
from backend.services.wright import WrightParcelService


load_dotenv()

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logger = logging.getLogger(__name__)

ROOT_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = ROOT_DIR / "backend" / "static"
DEFAULT_DB_PATH = ROOT_DIR / "data" / "app.db"

app = FastAPI(title="ParcelPicker", version="0.5.6")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


def _env_bool(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


db = ParcelDatabase(db_path=os.getenv("DB_PATH", str(DEFAULT_DB_PATH)))
llm_service = LLMService(
    LLMConfig(
        provider=os.getenv("LLM_PROVIDER", "openai"),
        model=os.getenv("LLM_MODEL", "gpt-4o-mini"),
        openai_api_key=os.getenv("OPENAI_API_KEY"),
        openrouter_api_key=os.getenv("OPENROUTER_API_KEY"),
        enabled=_env_bool("ENABLE_LLM_ASSIST", False),
    )
)
parcel_service = WrightParcelService(
    timeout_seconds=float(os.getenv("REQUEST_TIMEOUT_SECONDS", "20")),
    max_retries=int(os.getenv("REQUEST_RETRIES", "2")),
    retry_backoff_seconds=float(os.getenv("RETRY_BACKOFF_SECONDS", "0.8")),
    min_interval_seconds=float(os.getenv("MIN_REQUEST_INTERVAL_SECONDS", "0.15")),
)
lookup_runner = ParcelLookupRunner(
    db=db,
    parcel_service=parcel_service,
    llm_service=llm_service,
    settings=load_lookup_settings(),
)


class LookupRequest(BaseModel):
    address: str = Field(min_length=4, max_length=200)
    rings: int = Field(default=0, ge=0, le=2)
    use_llm: bool = False


class PointLookupRequest(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    rings: int = Field(default=0, ge=0, le=2)
    use_llm: bool = False


class ParcelResponse(BaseModel):
    parcel_id: str
    owner_name: str
    normalized_owner_name: str
    site_address: str
    geometry: dict[str, Any] | None
    source: str
    matched_by: str
    ring_number: int
    is_seed: bool


class RunResponse(BaseModel):
    id: int
    input_address: str
    rings_requested: int
    status: str
    provider: str
    llm_enabled: bool
    seed_parcel_id: str | None
    summary: str | None
    error: str | None
    created_at: str
    completed_at: str | None
    parcel_count: int
    owner_count: int
    parcels: list[ParcelResponse]
    from_cache: bool = False


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/api/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/providers/status")
async def provider_status() -> dict[str, Any]:
    return {
        "parcel_provider": "wright_county_arcgis",
        "llm": {
            "enabled": llm_service.is_available,
            "configured_provider": os.getenv("LLM_PROVIDER", "openai"),
            "configured_model": os.getenv("LLM_MODEL", "gpt-4o-mini"),
        },
    }


@app.post("/api/lookup", response_model=RunResponse)
async def lookup(request: LookupRequest) -> RunResponse:
    run = await lookup_runner.run_lookup(
        input_address=request.address,
        rings_requested=request.rings,
        use_llm=request.use_llm,
    )
    if run["status"] == "failed":
        raise HTTPException(status_code=502, detail=run.get("error", "Lookup failed."))
    if run["status"] == "not_found":
        raise HTTPException(status_code=404, detail=run.get("error", "No parcel found."))
    return _to_run_response(run)


@app.post("/api/lookup/point", response_model=RunResponse)
async def lookup_point(request: PointLookupRequest) -> RunResponse:
    run = await lookup_runner.run_lookup_from_point(
        lon=request.lon,
        lat=request.lat,
        rings_requested=request.rings,
        use_llm=request.use_llm,
    )
    if run["status"] == "failed":
        raise HTTPException(status_code=502, detail=run.get("error", "Lookup failed."))
    if run["status"] == "not_found":
        raise HTTPException(status_code=404, detail=run.get("error", "No parcel found."))
    return _to_run_response(run)


@app.get("/api/runs")
async def list_runs(limit: int = 20) -> list[dict[str, Any]]:
    safe_limit = max(1, min(limit, 100))
    return db.list_runs(limit=safe_limit)


@app.get("/api/runs/{run_id}", response_model=RunResponse)
async def get_run(run_id: int) -> RunResponse:
    run = db.get_run(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="Run not found.")
    return _to_run_response(run)


@app.get("/api/runs/{run_id}/geojson")
async def get_run_geojson(run_id: int) -> JSONResponse:
    run = db.get_run(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="Run not found.")

    features: list[dict[str, Any]] = []
    for parcel in run["parcels"]:
        geometry = parcel.get("geometry")
        if not geometry:
            continue
        features.append(
            {
                "type": "Feature",
                "geometry": geometry,
                "properties": {
                    "run_id": run_id,
                    "ring_number": parcel.get("ring_number"),
                    "is_seed": parcel.get("is_seed"),
                    "parcel_id": parcel.get("parcel_id"),
                    "owner_name": parcel.get("owner_name"),
                    "normalized_owner_name": parcel.get("normalized_owner_name"),
                    "site_address": parcel.get("site_address"),
                    "matched_by": parcel.get("matched_by"),
                    "source": parcel.get("source"),
                },
            }
        )

    return JSONResponse(
        {
            "type": "FeatureCollection",
            "name": f"run_{run_id}",
            "features": features,
        }
    )


@app.get("/api/runs/{run_id}/csv")
async def get_run_csv(run_id: int) -> PlainTextResponse:
    run = db.get_run(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="Run not found.")

    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(
        [
            "run_id",
            "ring_number",
            "is_seed",
            "parcel_id",
            "owner_name",
            "normalized_owner_name",
            "site_address",
            "matched_by",
            "source",
        ]
    )
    for parcel in run["parcels"]:
        writer.writerow(
            [
                run_id,
                parcel.get("ring_number", ""),
                int(bool(parcel.get("is_seed", False))),
                parcel.get("parcel_id", ""),
                parcel.get("owner_name", ""),
                parcel.get("normalized_owner_name", ""),
                parcel.get("site_address", ""),
                parcel.get("matched_by", ""),
                parcel.get("source", ""),
            ]
        )

    content = buf.getvalue()
    headers = {"Content-Disposition": f'attachment; filename="run_{run_id}.csv"'}
    return PlainTextResponse(content=content, media_type="text/csv", headers=headers)


def _to_run_response(run: dict[str, Any]) -> RunResponse:
    parcels = [
        ParcelResponse(
            parcel_id=item["parcel_id"],
            owner_name=item.get("owner_name") or "",
            normalized_owner_name=item.get("normalized_owner_name") or "",
            site_address=item.get("site_address") or "",
            geometry=item.get("geometry"),
            source=item.get("source") or "",
            matched_by=item.get("matched_by") or "",
            ring_number=int(item.get("ring_number", 0)),
            is_seed=bool(item.get("is_seed", False)),
        )
        for item in run.get("parcels", [])
    ]

    return RunResponse(
        id=int(run["id"]),
        input_address=run["input_address"],
        rings_requested=int(run["rings_requested"]),
        status=run["status"],
        provider=run["provider"],
        llm_enabled=bool(run["llm_enabled"]),
        seed_parcel_id=run.get("seed_parcel_id"),
        summary=run.get("summary"),
        error=run.get("error"),
        created_at=run["created_at"],
        completed_at=run.get("completed_at"),
        parcel_count=int(run.get("parcel_count", 0)),
        owner_count=int(run.get("owner_count", 0)),
        parcels=parcels,
        from_cache=bool(run.get("from_cache", False)),
    )


if __name__ == "__main__":
    import uvicorn

    host = os.getenv("HOST", "0.0.0.0")
    port = int(os.getenv("PORT", "8091"))
    logger.info("starting_parcelpicker host=%s port=%s", host, port)
    uvicorn.run("backend.main:app", host=host, port=port, reload=False)
