from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from backend.services.wright import WrightParcelService


load_dotenv()

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"

app = FastAPI(title="ParcelPicker", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

parcel_service = WrightParcelService()


class LookupRequest(BaseModel):
    address: str = Field(min_length=4, max_length=200)


class LookupResponse(BaseModel):
    address: str
    parcel_id: str
    owner_name: str
    site_address: str
    geometry: dict | None
    source: str
    matched_by: str


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/api/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/lookup", response_model=LookupResponse)
async def lookup(request: LookupRequest) -> LookupResponse:
    try:
        result = await parcel_service.lookup(request.address)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    if result is None:
        raise HTTPException(
            status_code=404,
            detail="No parcel match found for the provided address.",
        )

    return LookupResponse(
        address=request.address,
        parcel_id=result.parcel_id,
        owner_name=result.owner_name,
        site_address=result.site_address,
        geometry=result.geometry,
        source=result.source,
        matched_by=result.matched_by,
    )


if __name__ == "__main__":
    import uvicorn

    host = os.getenv("HOST", "0.0.0.0")
    port = int(os.getenv("PORT", "8090"))
    uvicorn.run("backend.main:app", host=host, port=port, reload=False)
