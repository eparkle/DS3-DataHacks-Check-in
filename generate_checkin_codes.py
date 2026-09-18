"""
Step 1 of 3: Generate unique check-in IDs + QR code images from your roster.

Input:  roster.csv          (columns: name,email,role,team)
Output: qr_codes/*.png       (one QR image per person, filename = their ID)
        registrants_export.json  (feeds into import_to_firestore.py and send_emails.py)

Usage:
    pip install qrcode[pil]
    python generate_checkin_codes.py
"""

import csv
import json
from pathlib import Path

import qrcode

CSV_PATH = "roster.csv"
QR_DIR = Path("qr_codes")
OUTPUT_JSON = "registrants_export.json"
EVENT_CODE = "DH26"  # short prefix so IDs read as e.g. DH26-P001, DH26-J001


def load_roster(csv_path):
    rows = []
    with open(csv_path, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for i, row in enumerate(reader, start=2):  # start=2: row 1 is the header
            name = (row.get("name") or "").strip()
            email = (row.get("email") or "").strip()
            role = (row.get("role") or "").strip().lower()
            team = (row.get("team") or "").strip()
            if not name or not email:
                raise ValueError(f"Row {i}: missing name or email")
            if role not in ("participant", "judge"):
                raise ValueError(f"Row {i}: role must be 'participant' or 'judge', got '{role}'")
            rows.append({"name": name, "email": email, "role": role, "team": team})
    return rows


def assign_ids(rows):
    counters = {"participant": 0, "judge": 0}
    seen_emails = set()
    for row in rows:
        if row["email"].lower() in seen_emails:
            raise ValueError(f"Duplicate email in CSV: {row['email']}")
        seen_emails.add(row["email"].lower())

        counters[row["role"]] += 1
        prefix = "P" if row["role"] == "participant" else "J"
        row["id"] = f"{EVENT_CODE}-{prefix}{counters[row['role']]:03d}"
    return rows


def generate_qr_codes(rows, out_dir):
    out_dir.mkdir(exist_ok=True)
    for row in rows:
        img = qrcode.make(row["id"])
        img.save(out_dir / f"{row['id']}.png")


def main():
    rows = load_roster(CSV_PATH)
    rows = assign_ids(rows)
    generate_qr_codes(rows, QR_DIR)

    with open(OUTPUT_JSON, "w", encoding="utf-8") as f:
        json.dump(rows, f, indent=2)

    participants = sum(1 for r in rows if r["role"] == "participant")
    judges = sum(1 for r in rows if r["role"] == "judge")
    print(f"Generated {len(rows)} QR codes -> {QR_DIR}/")
    print(f"  {participants} participants, {judges} judges")
    print(f"Wrote {OUTPUT_JSON} (used by the next two scripts)")


if __name__ == "__main__":
    main()
