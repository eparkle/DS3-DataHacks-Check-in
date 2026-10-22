"""
Generate QR images whose payload is each attendee’s short code (e.g. DH26-H001).

Codes are created in Supabase by next_attendee_code() when an application is accepted.

Usage:
    pip install -r requirements.txt
    python generate_checkin_codes.py
    python generate_checkin_codes.py --event-id 96f5c446-76df-4001-948c-67c01a56ebcf
"""

from __future__ import annotations

import argparse
import re
from pathlib import Path

import qrcode

from supabase_roster import load_roster

QR_DIR = Path("qr_codes")


def slug(value: str) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9]+", "-", value).strip("-").lower()
    return cleaned or "attendee"


def qr_filename(row: dict) -> str:
    return f"{row['code']}__{slug(row['name'] or row['email'])}.png"


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate check-in QR codes from attendees.")
    parser.add_argument("--event-id", help="events.id (defaults to EVENT_ID or the latest coded event)")
    parser.add_argument("--out", type=Path, default=QR_DIR, help="Output directory (default: qr_codes)")
    args = parser.parse_args()

    event, roster = load_roster(args.event_id)
    args.out.mkdir(exist_ok=True)

    if not roster:
        print(f"No attendees for {event['name']} ({event['id']}).")
        print("Accept applications after setting events.code so upsert_attendee can fill public.attendees.")
        return

    for row in roster:
        img = qrcode.make(row["code"])
        img.save(args.out / qr_filename(row))

    counts = {role: 0 for role in ("hacker", "judge", "mentor")}
    for row in roster:
        for role in row["roles"]:
            if role in counts:
                counts[role] += 1

    print(f"Generated {len(roster)} QR codes -> {args.out}/")
    print(f"  Event: {event['name']} ({event['code']})")
    print(f"  {counts['hacker']} hackers, {counts['judge']} judges, {counts['mentor']} mentors")
    print("Each QR encodes attendees.code (what check_in_by_code expects).")


if __name__ == "__main__":
    main()
