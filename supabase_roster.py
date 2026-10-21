"""Load accepted check-in attendees from Supabase (v_checkin_list + teams)."""

from __future__ import annotations

import os
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


def rest_get(path: str, params: dict | None = None) -> list:
    query = f"?{urlencode(params, doseq=True)}" if params else ""
    url = f"{supabase_url()}/rest/v1/{path}{query}"
    headers = {
        "apikey": supabase_key(),
        "Authorization": f"Bearer {supabase_key()}",
        "Accept": "application/json",
    }
    rows = []
    start = 0
    while True:
        page_headers = {
            **headers,
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


def load_event(event_id: str | None = None) -> dict:
    event_id = (event_id or os.environ.get("EVENT_ID") or "").strip()
    if event_id:
        rows = rest_get("events", {"id": f"eq.{event_id}", "select": "id,name,starts_at"})
        if not rows:
            raise SystemExit(f"No event with id {event_id}")
        return rows[0]

    rows = rest_get(
        "events",
        {
            "select": "id,name,starts_at",
            "order": "starts_at.desc.nullslast",
        },
    )
    if not rows:
        raise SystemExit('No rows in the "events" table.')
    return rows[0]


def display_name(row: dict) -> str:
    name = " ".join(
        part for part in (row.get("first_name"), row.get("last_name")) if part
    ).strip()
    return name or row.get("email") or row.get("user_id") or ""


def role_labels(roles: list[str]) -> str:
    return ", ".join(ROLE_LABELS.get(role, role.title()) for role in roles) or "Attendee"


def _teams_by_user(event_id: str) -> dict[str, str]:
    rows = rest_get(
        "team_members",
        {
            "event_id": f"eq.{event_id}",
            "select": "user_id,teams(name)",
        },
    )
    out = {}
    for row in rows:
        team = row.get("teams") or {}
        name = team.get("name") if isinstance(team, dict) else None
        if name and row.get("user_id"):
            out[row["user_id"]] = name
    return out


def load_roster(event_id: str | None = None) -> tuple[dict, list[dict]]:
    event = load_event(event_id)
    teams = _teams_by_user(event["id"])
    raw = rest_get(
        "v_checkin_list",
        {
            "event_id": f"eq.{event['id']}",
            "select": "event_id,user_id,first_name,last_name,email,roles",
            "order": "last_name.asc.nullslast,first_name.asc.nullslast",
        },
    )

    roster = []
    seen = set()
    for row in raw:
        user_id = row.get("user_id")
        if not user_id or user_id in seen:
            continue
        seen.add(user_id)
        roles = [r for r in (row.get("roles") or []) if r]
        roster.append(
            {
                "user_id": user_id,
                "first_name": row.get("first_name") or "",
                "last_name": row.get("last_name") or "",
                "name": display_name(row),
                "email": (row.get("email") or "").strip(),
                "roles": roles,
                "team": teams.get(user_id, ""),
            }
        )
    return event, roster
