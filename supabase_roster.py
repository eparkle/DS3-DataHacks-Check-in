"""Load the check-in roster from public.attendees."""

from __future__ import annotations

import os
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlencode

import requests
from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent / ".env")

ROLE_LABELS = {
    "hacker": "Hacker",
    "judge": "Judge",
    "mentor": "Mentor",
}

PAGE_SIZE = 1000


def require_env(*names: str, required: bool = True) -> str:
    for name in names:
        value = (os.environ.get(name) or "").strip()
        if value:
            return value
    if required:
        joined = " or ".join(names)
        raise SystemExit(f"Missing {joined}. Add it to .env (see .env.example).")
    return ""


def supabase_url() -> str:
    return require_env("SUPABASE_URL", "VITE_SUPABASE_URL").rstrip("/")


def supabase_key() -> str:
    return require_env("SUPABASE_SERVICE_ROLE_KEY")


def _headers() -> dict:
    key = supabase_key()
    return {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Accept": "application/json",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }


def rest_get(path: str, params: dict | None = None) -> list:
    query = f"?{urlencode(params, doseq=True)}" if params else ""
    url = f"{supabase_url()}/rest/v1/{path}{query}"
    rows = []
    start = 0
    while True:
        page_headers = {
            **_headers(),
            "Range-Unit": "items",
            "Range": f"{start}-{start + PAGE_SIZE - 1}",
        }
        resp = requests.get(url, headers=page_headers, timeout=30)
        resp.raise_for_status()
        chunk = resp.json()
        if not isinstance(chunk, list):
            raise RuntimeError(f"Unexpected response from {path}: {chunk}")
        rows.extend(chunk)
        if len(chunk) < PAGE_SIZE:
            break
        start += PAGE_SIZE
    return rows


def rest_patch(path: str, params: dict, body: dict) -> list:
    query = f"?{urlencode(params, doseq=True)}"
    url = f"{supabase_url()}/rest/v1/{path}{query}"
    resp = requests.patch(url, headers=_headers(), json=body, timeout=30)
    resp.raise_for_status()
    data = resp.json()
    return data if isinstance(data, list) else []


def load_event(event_id: str | None = None) -> dict:
    event_id = (event_id or os.environ.get("EVENT_ID") or "").strip()
    if event_id:
        rows = rest_get("events", {"id": f"eq.{event_id}", "select": "id,name,starts_at,code"})
        if not rows:
            raise SystemExit(f"No event with id {event_id}")
        event = rows[0]
    else:
        rows = rest_get(
            "events",
            {
                "select": "id,name,starts_at,code",
                "order": "starts_at.desc.nullslast",
            },
        )
        if not rows:
            raise SystemExit('No rows in the "events" table.')
        event = next((row for row in rows if row.get("code")), rows[0])

    if not event.get("code"):
        raise SystemExit(
            f"Event {event['id']} has no code. Run the check-in SQL, then: "
            f"update public.events set code = 'DH26' where id = '{event['id']}';"
        )
    return event


def role_labels(roles: list[str]) -> str:
    return ", ".join(ROLE_LABELS.get(role, role.title()) for role in roles) or "Attendee"


def load_roster(event_id: str | None = None) -> tuple[dict, list[dict]]:
    event = load_event(event_id)
    raw = rest_get(
        "attendees",
        {
            "event_id": f"eq.{event['id']}",
            "select": "id,event_id,code,name,email,roles,team,emailed_at,checked_in_at",
            "order": "code.asc",
        },
    )

    roster = []
    seen = set()
    for row in raw:
        code = (row.get("code") or "").upper()
        if not code or code in seen:
            continue
        seen.add(code)
        roster.append(
            {
                "id": row.get("id"),
                "code": code,
                "name": row.get("name") or row.get("email") or code,
                "email": (row.get("email") or "").strip(),
                "roles": [r for r in (row.get("roles") or []) if r],
                "team": row.get("team") or "",
                "emailed_at": row.get("emailed_at"),
                "checked_in_at": row.get("checked_in_at"),
            }
        )
    return event, roster


def mark_emailed(event_id: str, code: str) -> None:
    rest_patch(
        "attendees",
        {"event_id": f"eq.{event_id}", "code": f"eq.{code}"},
        {"emailed_at": datetime.now(timezone.utc).isoformat()},
    )
