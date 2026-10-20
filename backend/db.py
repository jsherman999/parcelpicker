from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from threading import Lock
from typing import Any

from backend.services.parcel import (
    RECORD_VERSION,
    ParcelRecord,
    count_owners,
    county_from_source_id,
    input_label,
    migrate_input,
    migrate_matched_by,
    to_parcel,
    to_run_parcel,
)

# A parcel is identified by (county, parcel_id), and an address alias by
# (county, normalized_address): parcel IDs and street addresses repeat across
# counties. A run is single-county, so run_parcels joins parcels on the run's
# county.
SCHEMA = """
CREATE TABLE IF NOT EXISTS lookup_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    county TEXT NOT NULL,
    input_json TEXT NOT NULL,
    input_label TEXT NOT NULL,
    rings_requested INTEGER NOT NULL,
    status TEXT NOT NULL,
    capped_by TEXT,
    source_id TEXT NOT NULL,
    llm_enabled INTEGER NOT NULL,
    seed_parcel_id TEXT,
    summary TEXT,
    error TEXT,
    record_version INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_runs_county_seed
ON lookup_runs(county, seed_parcel_id);

CREATE TABLE IF NOT EXISTS parcels (
    county TEXT NOT NULL,
    parcel_id TEXT NOT NULL,
    owner_name TEXT,
    site_address TEXT,
    market_value REAL,
    market_value_year TEXT,
    land_use TEXT,
    geometry_json TEXT,
    source_id TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (county, parcel_id)
);

CREATE TABLE IF NOT EXISTS run_parcels (
    run_id INTEGER NOT NULL,
    parcel_id TEXT NOT NULL,
    ring_number INTEGER NOT NULL,
    is_seed INTEGER NOT NULL,
    matched_by TEXT,
    normalized_owner_name TEXT,
    PRIMARY KEY (run_id, parcel_id),
    FOREIGN KEY (run_id) REFERENCES lookup_runs (id)
);

CREATE TABLE IF NOT EXISTS parcel_address_aliases (
    county TEXT NOT NULL,
    normalized_address TEXT NOT NULL,
    parcel_id TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (county, normalized_address)
);
"""

_RUN_COLUMNS = """
    id, county, input_json, input_label, rings_requested, status, capped_by,
    source_id, llm_enabled, seed_parcel_id, summary, error, record_version,
    created_at, completed_at
"""

_PARCEL_COLUMNS = """
    p.county, p.parcel_id, p.owner_name, p.site_address, p.market_value,
    p.market_value_year, p.land_use, p.geometry_json, p.source_id
"""


def _row_to_parcel(row: sqlite3.Row, **overrides: Any) -> ParcelRecord:
    item = dict(row)
    geometry_json = item.pop("geometry_json", None)
    item["geometry"] = json.loads(geometry_json) if geometry_json else None
    return to_parcel(item, **overrides)


def _row_to_run(row: sqlite3.Row) -> dict[str, Any]:
    run = dict(row)
    run["input"] = json.loads(run.pop("input_json"))
    run["llm_enabled"] = bool(run["llm_enabled"])
    return run


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
            self._conn.execute("PRAGMA journal_mode=WAL")
            if self._needs_county_migration():
                self._migrate_to_county_schema()
            self._conn.executescript(SCHEMA)
            self._conn.execute("PRAGMA foreign_keys=ON")
            self._conn.commit()

    def _needs_county_migration(self) -> bool:
        columns = {
            row["name"] for row in self._conn.execute("PRAGMA table_info(lookup_runs)")
        }
        return bool(columns) and "county" not in columns

    def _migrate_to_county_schema(self) -> None:
        """Rebuild a pre-county database in place.

        The county comes from the old provider/source label. Rows whose county
        can't be inferred are dropped, as are the old address aliases (cache
        only). Migrated runs keep their history but get record_version 1, so
        they are never reused as cache hits.
        """
        conn = self._conn
        conn.execute("PRAGMA foreign_keys=OFF")
        try:
            old_runs = conn.execute("SELECT * FROM lookup_runs").fetchall()
            old_parcels = conn.execute("SELECT * FROM parcels").fetchall()
            old_run_parcels = conn.execute("SELECT * FROM run_parcels").fetchall()

            conn.execute("BEGIN")
            for table in ("run_parcels", "parcel_address_aliases", "parcels", "lookup_runs"):
                conn.execute(f"DROP TABLE IF EXISTS {table}")
            for statement in SCHEMA.split(";"):
                if statement.strip():
                    conn.execute(statement)

            run_county: dict[int, str] = {}
            for run in old_runs:
                county = county_from_source_id(run["provider"])
                if county is None:
                    continue
                run_county[run["id"]] = county
                run_input = migrate_input(run["input_address"])
                conn.execute(
                    f"INSERT INTO lookup_runs ({_RUN_COLUMNS}) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)",
                    (
                        run["id"],
                        county,
                        json.dumps(run_input),
                        input_label(run_input),
                        run["rings_requested"],
                        run["status"],
                        # Before capped_by, max_parcels was the only cap.
                        "max_parcels" if run["status"] == "capped" else None,
                        run["provider"],
                        run["llm_enabled"],
                        run["seed_parcel_id"],
                        run["summary"],
                        run["error"],
                        run["created_at"],
                        run["completed_at"],
                    ),
                )

            owner_by_parcel: dict[str, str | None] = {}
            for parcel in old_parcels:
                owner_by_parcel[parcel["parcel_id"]] = parcel["normalized_owner_name"]
                county = county_from_source_id(parcel["source"])
                if county is None:
                    continue
                conn.execute(
                    "INSERT INTO parcels (county, parcel_id, owner_name, site_address, "
                    "geometry_json, source_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (
                        county,
                        parcel["parcel_id"],
                        parcel["owner_name"],
                        parcel["site_address"],
                        parcel["geometry_json"],
                        parcel["source"],
                        parcel["updated_at"],
                    ),
                )

            for rp in old_run_parcels:
                if rp["run_id"] not in run_county:
                    continue
                conn.execute(
                    "INSERT INTO run_parcels (run_id, parcel_id, ring_number, is_seed, "
                    "matched_by, normalized_owner_name) VALUES (?, ?, ?, ?, ?, ?)",
                    (
                        rp["run_id"],
                        rp["parcel_id"],
                        rp["ring_number"],
                        rp["is_seed"],
                        migrate_matched_by(rp["matched_by"]),
                        owner_by_parcel.get(rp["parcel_id"]),
                    ),
                )
            conn.commit()
        except Exception:
            conn.rollback()
            raise

    def create_run(
        self,
        *,
        county: str,
        run_input: dict[str, Any],
        input_label: str,
        rings_requested: int,
        source_id: str,
        llm_enabled: bool,
    ) -> int:
        with self._lock:
            cur = self._conn.execute(
                """
                INSERT INTO lookup_runs (
                    county, input_json, input_label, rings_requested, status,
                    source_id, llm_enabled, record_version
                ) VALUES (?, ?, ?, ?, 'running', ?, ?, ?)
                """,
                (
                    county,
                    json.dumps(run_input),
                    input_label,
                    rings_requested,
                    source_id,
                    int(llm_enabled),
                    RECORD_VERSION,
                ),
            )
            self._conn.commit()
            return int(cur.lastrowid)

    def complete_run(
        self,
        run_id: int,
        *,
        status: str,
        capped_by: str | None = None,
        seed_parcel_id: str | None,
        summary: str | None,
        error: str | None,
    ) -> None:
        with self._lock:
            self._conn.execute(
                """
                UPDATE lookup_runs
                SET status = ?,
                    capped_by = ?,
                    seed_parcel_id = ?,
                    summary = ?,
                    error = ?,
                    completed_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                (status, capped_by, seed_parcel_id, summary, error, run_id),
            )
            self._conn.commit()

    def upsert_parcel(self, parcel: ParcelRecord) -> None:
        with self._lock:
            self._conn.execute(
                """
                INSERT INTO parcels (
                    county, parcel_id, owner_name, site_address, market_value,
                    market_value_year, land_use, geometry_json, source_id, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(county, parcel_id) DO UPDATE SET
                    owner_name = excluded.owner_name,
                    site_address = excluded.site_address,
                    market_value = excluded.market_value,
                    market_value_year = excluded.market_value_year,
                    land_use = excluded.land_use,
                    geometry_json = excluded.geometry_json,
                    source_id = excluded.source_id,
                    updated_at = CURRENT_TIMESTAMP
                """,
                (
                    parcel.county,
                    parcel.parcel_id,
                    parcel.owner_name,
                    parcel.site_address,
                    parcel.market_value,
                    parcel.market_value_year,
                    parcel.land_use,
                    json.dumps(parcel.geometry) if parcel.geometry is not None else None,
                    parcel.source_id,
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
        normalized_owner_name: str,
    ) -> None:
        with self._lock:
            self._conn.execute(
                """
                INSERT OR REPLACE INTO run_parcels (
                    run_id, parcel_id, ring_number, is_seed, matched_by,
                    normalized_owner_name
                )
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (run_id, parcel_id, ring_number, int(is_seed), matched_by, normalized_owner_name),
            )
            self._conn.commit()

    def list_runs(self, limit: int = 20) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute(
                f"SELECT {_RUN_COLUMNS} FROM lookup_runs ORDER BY id DESC LIMIT ?",
                (limit,),
            ).fetchall()
        return [_row_to_run(row) for row in rows]

    def upsert_address_alias(self, county: str, normalized_address: str, parcel_id: str) -> None:
        clean_address = normalized_address.strip()
        clean_parcel_id = parcel_id.strip()
        if not county or not clean_address or not clean_parcel_id:
            return

        with self._lock:
            self._conn.execute(
                """
                INSERT INTO parcel_address_aliases (
                    county, normalized_address, parcel_id, updated_at
                )
                VALUES (?, ?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(county, normalized_address) DO UPDATE SET
                    parcel_id = excluded.parcel_id,
                    updated_at = CURRENT_TIMESTAMP
                """,
                (county, clean_address, clean_parcel_id),
            )
            self._conn.commit()

    def resolve_address_alias(
        self,
        county: str,
        normalized_address: str,
        *,
        max_age_days: int,
    ) -> str | None:
        clean_address = normalized_address.strip()
        if not clean_address:
            return None
        cutoff = f"-{max(1, max_age_days)} days"
        with self._lock:
            row = self._conn.execute(
                """
                SELECT parcel_id
                FROM parcel_address_aliases
                WHERE county = ?
                  AND normalized_address = ?
                  AND updated_at >= datetime('now', ?)
                LIMIT 1
                """,
                (county, clean_address, cutoff),
            ).fetchone()
        if row is None:
            return None
        return str(row["parcel_id"]).strip() or None

    def get_recent_run_for_seed_parcel(
        self,
        *,
        county: str,
        seed_parcel_id: str,
        min_rings: int,
        max_age_days: int,
    ) -> dict[str, Any] | None:
        clean_seed = seed_parcel_id.strip()
        if not clean_seed:
            return None
        cutoff = f"-{max(1, max_age_days)} days"
        with self._lock:
            row = self._conn.execute(
                """
                SELECT id
                FROM lookup_runs
                WHERE county = ?
                  AND seed_parcel_id = ?
                  AND status IN ('completed', 'capped')
                  AND record_version >= ?
                  AND rings_requested >= ?
                  AND created_at >= datetime('now', ?)
                ORDER BY id DESC
                LIMIT 1
                """,
                (county, clean_seed, RECORD_VERSION, min_rings, cutoff),
            ).fetchone()

        if row is None:
            return None

        return self.get_run(int(row["id"]))

    def cleanup_expired_data(self, *, retention_days: int) -> None:
        cutoff = f"-{max(1, retention_days)} days"
        with self._lock:
            self._conn.execute(
                """
                DELETE FROM run_parcels
                WHERE run_id IN (
                    SELECT id FROM lookup_runs
                    WHERE created_at < datetime('now', ?)
                )
                """,
                (cutoff,),
            )
            self._conn.execute(
                "DELETE FROM lookup_runs WHERE created_at < datetime('now', ?)",
                (cutoff,),
            )
            self._conn.execute(
                "DELETE FROM parcel_address_aliases WHERE updated_at < datetime('now', ?)",
                (cutoff,),
            )
            self._conn.execute(
                """
                DELETE FROM parcels
                WHERE updated_at < datetime('now', ?)
                  AND NOT EXISTS (
                      SELECT 1 FROM run_parcels rp
                      JOIN lookup_runs lr ON lr.id = rp.run_id
                      WHERE lr.county = parcels.county AND rp.parcel_id = parcels.parcel_id
                  )
                  AND NOT EXISTS (
                      SELECT 1 FROM parcel_address_aliases a
                      WHERE a.county = parcels.county AND a.parcel_id = parcels.parcel_id
                  )
                """,
                (cutoff,),
            )
            self._conn.commit()

    def list_recent_cached_parcels(
        self,
        *,
        county: str,
        max_age_days: int,
    ) -> list[ParcelRecord]:
        cutoff = f"-{max(1, max_age_days)} days"
        with self._lock:
            rows = self._conn.execute(
                f"""
                SELECT DISTINCT {_PARCEL_COLUMNS}
                FROM parcels p
                JOIN run_parcels rp ON rp.parcel_id = p.parcel_id
                JOIN lookup_runs lr ON lr.id = rp.run_id AND lr.county = p.county
                WHERE p.county = ?
                  AND lr.status IN ('completed', 'capped')
                  AND lr.record_version >= ?
                  AND lr.created_at >= datetime('now', ?)
                  AND p.geometry_json IS NOT NULL
                """,
                (county, RECORD_VERSION, cutoff),
            ).fetchall()
        return [_row_to_parcel(row) for row in rows]

    def get_run(self, run_id: int) -> dict[str, Any] | None:
        with self._lock:
            run_row = self._conn.execute(
                f"SELECT {_RUN_COLUMNS} FROM lookup_runs WHERE id = ?",
                (run_id,),
            ).fetchone()

            if run_row is None:
                return None

            parcel_rows = self._conn.execute(
                f"""
                SELECT {_PARCEL_COLUMNS},
                       rp.ring_number, rp.is_seed, rp.matched_by,
                       rp.normalized_owner_name
                FROM run_parcels rp
                JOIN parcels p ON p.county = ? AND p.parcel_id = rp.parcel_id
                WHERE rp.run_id = ?
                ORDER BY rp.ring_number ASC, rp.is_seed DESC, rp.parcel_id ASC
                """,
                (run_row["county"], run_id),
            ).fetchall()

        run = _row_to_run(run_row)
        parcels = []
        for row in parcel_rows:
            item = dict(row)
            parcels.append(
                to_run_parcel(
                    _row_to_parcel(row),
                    ring_number=item["ring_number"],
                    is_seed=bool(item["is_seed"]),
                    normalized_owner_name=item["normalized_owner_name"] or "",
                )
            )

        run["parcels"] = parcels
        run["parcel_count"] = len(parcels)
        run["owner_count"] = count_owners(parcels)
        return run
