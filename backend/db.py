from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from threading import Lock
from typing import Any


class ParcelDatabase:
    def __init__(self, db_path: str) -> None:
        self._db_path = Path(db_path)
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = Lock()
        self._conn = sqlite3.connect(self._db_path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._init_schema()

    def _init_schema(self) -> None:
        with self._lock:
            self._conn.executescript(
                """
                PRAGMA journal_mode=WAL;

                CREATE TABLE IF NOT EXISTS lookup_runs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    input_address TEXT NOT NULL,
                    rings_requested INTEGER NOT NULL,
                    status TEXT NOT NULL,
                    provider TEXT NOT NULL,
                    llm_enabled INTEGER NOT NULL,
                    seed_parcel_id TEXT,
                    summary TEXT,
                    error TEXT,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    completed_at TEXT
                );

                CREATE TABLE IF NOT EXISTS parcels (
                    parcel_id TEXT PRIMARY KEY,
                    owner_name TEXT,
                    normalized_owner_name TEXT,
                    site_address TEXT,
                    geometry_json TEXT,
                    source TEXT,
                    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                );

                CREATE TABLE IF NOT EXISTS run_parcels (
                    run_id INTEGER NOT NULL,
                    parcel_id TEXT NOT NULL,
                    ring_number INTEGER NOT NULL,
                    is_seed INTEGER NOT NULL,
                    matched_by TEXT,
                    PRIMARY KEY (run_id, parcel_id),
                    FOREIGN KEY (run_id) REFERENCES lookup_runs (id),
                    FOREIGN KEY (parcel_id) REFERENCES parcels (parcel_id)
                );
                """
            )
            self._conn.commit()

    def create_run(
        self,
        *,
        input_address: str,
        rings_requested: int,
        provider: str,
        llm_enabled: bool,
    ) -> int:
        with self._lock:
            cur = self._conn.execute(
                """
                INSERT INTO lookup_runs (
                    input_address,
                    rings_requested,
                    status,
                    provider,
                    llm_enabled
                ) VALUES (?, ?, 'running', ?, ?)
                """,
                (input_address, rings_requested, provider, int(llm_enabled)),
            )
            self._conn.commit()
            return int(cur.lastrowid)

    def complete_run(
        self,
        run_id: int,
        *,
        status: str,
        seed_parcel_id: str | None,
        summary: str | None,
        error: str | None,
    ) -> None:
        with self._lock:
            self._conn.execute(
                """
                UPDATE lookup_runs
                SET status = ?,
                    seed_parcel_id = ?,
                    summary = ?,
                    error = ?,
                    completed_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                (status, seed_parcel_id, summary, error, run_id),
            )
            self._conn.commit()

    def upsert_parcel(
        self,
        *,
        parcel_id: str,
        owner_name: str,
        normalized_owner_name: str,
        site_address: str,
        geometry: dict[str, Any] | None,
        source: str,
    ) -> None:
        with self._lock:
            self._conn.execute(
                """
                INSERT INTO parcels (
                    parcel_id,
                    owner_name,
                    normalized_owner_name,
                    site_address,
                    geometry_json,
                    source,
                    updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(parcel_id) DO UPDATE SET
                    owner_name = excluded.owner_name,
                    normalized_owner_name = excluded.normalized_owner_name,
                    site_address = excluded.site_address,
                    geometry_json = excluded.geometry_json,
                    source = excluded.source,
                    updated_at = CURRENT_TIMESTAMP
                """,
                (
                    parcel_id,
                    owner_name,
                    normalized_owner_name,
                    site_address,
                    json.dumps(geometry) if geometry is not None else None,
                    source,
                ),
            )
            self._conn.commit()

    def add_run_parcel(
        self,
        *,
        run_id: int,
        parcel_id: str,
        ring_number: int,
        is_seed: bool,
        matched_by: str,
    ) -> None:
        with self._lock:
            self._conn.execute(
                """
                INSERT OR REPLACE INTO run_parcels (
                    run_id,
                    parcel_id,
                    ring_number,
                    is_seed,
                    matched_by
                )
                VALUES (?, ?, ?, ?, ?)
                """,
                (run_id, parcel_id, ring_number, int(is_seed), matched_by),
            )
            self._conn.commit()

    def get_parcel(self, parcel_id: str) -> dict[str, Any] | None:
        with self._lock:
            cur = self._conn.execute(
                """
                SELECT parcel_id, owner_name, normalized_owner_name, site_address,
                       geometry_json, source
                FROM parcels
                WHERE parcel_id = ?
                """,
                (parcel_id,),
            )
            row = cur.fetchone()

        if row is None:
            return None

        payload = dict(row)
        geometry_json = payload.get("geometry_json")
        payload["geometry"] = json.loads(geometry_json) if geometry_json else None
        payload.pop("geometry_json", None)
        return payload

    def list_runs(self, limit: int = 20) -> list[dict[str, Any]]:
        with self._lock:
            cur = self._conn.execute(
                """
                SELECT id, input_address, rings_requested, status, provider,
                       llm_enabled, seed_parcel_id, summary, error, created_at,
                       completed_at
                FROM lookup_runs
                ORDER BY id DESC
                LIMIT ?
                """,
                (limit,),
            )
            rows = cur.fetchall()
        return [dict(row) for row in rows]

    def get_run(self, run_id: int) -> dict[str, Any] | None:
        with self._lock:
            run_row = self._conn.execute(
                """
                SELECT id, input_address, rings_requested, status, provider,
                       llm_enabled, seed_parcel_id, summary, error, created_at,
                       completed_at
                FROM lookup_runs
                WHERE id = ?
                """,
                (run_id,),
            ).fetchone()

            if run_row is None:
                return None

            parcel_rows = self._conn.execute(
                """
                SELECT rp.parcel_id,
                       rp.ring_number,
                       rp.is_seed,
                       rp.matched_by,
                       p.owner_name,
                       p.normalized_owner_name,
                       p.site_address,
                       p.geometry_json,
                       p.source
                FROM run_parcels rp
                JOIN parcels p ON p.parcel_id = rp.parcel_id
                WHERE rp.run_id = ?
                ORDER BY rp.ring_number ASC, rp.is_seed DESC, rp.parcel_id ASC
                """,
                (run_id,),
            ).fetchall()

        run = dict(run_row)
        parcels: list[dict[str, Any]] = []
        for row in parcel_rows:
            item = dict(row)
            geometry_json = item.get("geometry_json")
            item["geometry"] = json.loads(geometry_json) if geometry_json else None
            item.pop("geometry_json", None)
            item["is_seed"] = bool(item["is_seed"])
            parcels.append(item)

        run["parcels"] = parcels
        run["parcel_count"] = len(parcels)
        run["owner_count"] = len(
            {
                (parcel.get("normalized_owner_name") or parcel.get("owner_name") or "").strip().upper()
                for parcel in parcels
                if (parcel.get("normalized_owner_name") or parcel.get("owner_name"))
            }
        )
        return run
