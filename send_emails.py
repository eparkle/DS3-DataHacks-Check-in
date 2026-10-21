"""
Create an Apple Wallet pass for each accepted attendee (barcode = user UUID)
and email it.

Roster comes from Supabase v_checkin_list, not a CSV.

Usage:
    pip install -r requirements.txt
    python send_emails.py --dry-run
    python send_emails.py
    python send_emails.py --email someone@ucsd.edu
"""

from __future__ import annotations

import argparse
import json
import os
import smtplib
import ssl
import time
from email.message import EmailMessage
from pathlib import Path

import requests

from supabase_roster import load_roster, require_env, role_labels

WALLETWALLET_URL = "https://api.walletwallet.dev/api/passes?format=pkpass"
ORG_NAME = "DataHacks"
PASS_DIR = Path("wallet_passes")


def build_pass_payload(event_name: str, row: dict) -> dict:
    return {
        "barcodeValue": row["user_id"],
        "barcodeFormat": "QR",
        "logoText": event_name,
        "organizationName": ORG_NAME,
        "primaryFields": [{"label": role_labels(row["roles"]).upper(), "value": row["name"]}],
        "secondaryFields": [
            {"label": "TEAM", "value": row.get("team") or "—"},
            {"label": "CODE", "value": row["user_id"]},
        ],
    }


def get_or_create_pass(event_name: str, row: dict, api_key: str) -> Path:
    PASS_DIR.mkdir(exist_ok=True)
    cache_path = PASS_DIR / f"{row['user_id']}.pkpass"
    if cache_path.exists():
        return cache_path

    resp = requests.post(
        WALLETWALLET_URL,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        data=json.dumps(build_pass_payload(event_name, row)),
        timeout=30,
    )
    resp.raise_for_status()
    cache_path.write_bytes(resp.content)
    return cache_path


def build_email(from_addr: str, event_name: str, row: dict, pkpass_path: Path) -> EmailMessage:
    roles = role_labels(row["roles"])
    msg = EmailMessage()
    msg["Subject"] = f"Your {event_name} check-in pass"
    msg["From"] = from_addr
    msg["To"] = row["email"]
    msg.set_content(
        f"Hi {row['name']},\n\n"
        f"You're registered for {event_name} as a {roles}.\n\n"
        f"Open the attachment on your iPhone to add your check-in pass to Apple Wallet, "
        f"or show the QR code at the registration desk.\n\n"
        f"Your check-in code is your account ID:\n{row['user_id']}\n\n"
        f"See you there!"
    )
    with open(pkpass_path, "rb") as f:
        msg.add_attachment(
            f.read(),
            maintype="application",
            subtype="vnd.apple.pkpass",
            filename=f"{row['user_id']}.pkpass",
        )
    return msg


def main() -> None:
    parser = argparse.ArgumentParser(description="Email Apple Wallet check-in passes from Supabase.")
    parser.add_argument("--event-id", help="events.id (defaults to EVENT_ID or the latest event)")
    parser.add_argument("--dry-run", action="store_true", help="List recipients; do not generate or send")
    parser.add_argument("--email", help="Send to this address only")
    parser.add_argument("--limit", type=int, default=0, help="Send at most N emails")
    args = parser.parse_args()

    event, roster = load_roster(args.event_id)
    if args.email:
        target = args.email.strip().lower()
        roster = [row for row in roster if row["email"].lower() == target]
        if not roster:
            raise SystemExit(f"No accepted attendee with email {args.email}")

    missing_email = [row for row in roster if not row["email"]]
    roster = [row for row in roster if row["email"]]
    if args.limit:
        roster = roster[: args.limit]

    print(f"Event: {event['name']} ({event['id']})")
    print(f"Recipients: {len(roster)}")
    for row in missing_email:
        print(f"  skip (no email): {row['name']} {row['user_id']}")

    if args.dry_run:
        for row in roster:
            print(f"  would send -> {row['email']} ({role_labels(row['roles'])}) {row['user_id']}")
        return

    if not roster:
        print("Nobody to email.")
        return

    api_key = require_env("WALLETWALLET_API_KEY")
    gmail_address = require_env("GMAIL_ADDRESS")
    gmail_password = require_env("GMAIL_APP_PASSWORD")
    delay = float(os.environ.get("SEND_DELAY_SECONDS") or "1")

    sent, failed = 0, []
    context = ssl.create_default_context()
    with smtplib.SMTP_SSL("smtp.gmail.com", 465, context=context) as server:
        server.login(gmail_address, gmail_password)
        for row in roster:
            try:
                pkpass_path = get_or_create_pass(event["name"], row, api_key)
                server.send_message(build_email(gmail_address, event["name"], row, pkpass_path))
                sent += 1
                print(f"[{sent}/{len(roster)}] sent -> {row['email']} ({row['user_id']})")
            except Exception as exc:
                failed.append((row["email"], str(exc)))
                print(f"FAILED -> {row['email']}: {exc}")
            time.sleep(delay)

    print(f"\nDone. Sent {sent}/{len(roster)}.")
    if failed:
        print(f"{len(failed)} failed:")
        for email, err in failed:
            print(f"  {email}: {err}")


if __name__ == "__main__":
    main()
