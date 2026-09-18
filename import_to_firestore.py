"""
Step 2 of 3: Bulk-import registrants_export.json into your Firestore "registrants"
collection. Uses the Admin SDK, which bypasses your security rules entirely, so
this must be run from your own machine (never in a browser).

Setup:
    1. Firebase console -> Project settings -> Service accounts
       -> "Generate new private key" -> save as serviceAccountKey.json (same folder)
    2. pip install firebase-admin
    3. python import_to_firestore.py
"""

import json

import firebase_admin
from firebase_admin import credentials, firestore

SERVICE_ACCOUNT_PATH = "datahacks-check-in-firebase-adminsdk-fbsvc-0de05fae2e.json"
INPUT_JSON = "registrants_export.json"
BATCH_SIZE = 450  # Firestore batched writes cap out at 500 operations

cred = credentials.Certificate(SERVICE_ACCOUNT_PATH)
firebase_admin.initialize_app(cred)
db = firestore.client()


def chunked(items, size):
    for i in range(0, len(items), size):
        yield items[i : i + size]


def main():
    with open(INPUT_JSON, encoding="utf-8") as f:
        rows = json.load(f)

    total = 0
    for chunk in chunked(rows, BATCH_SIZE):
        batch = db.batch()
        for row in chunk:
            ref = db.collection("registrants").document(row["id"])
            batch.set(
                ref,
                {
                    "name": row["name"],
                    "email": row["email"],
                    "role": row["role"],
                    "team": row.get("team", ""),
                    "checkedIn": False,
                    "checkedInAt": None,
                },
            )
        batch.commit()
        total += len(chunk)
        print(f"Imported {total}/{len(rows)}...")

    print(f"Done. {total} registrants now in Firestore.")


if __name__ == "__main__":
    main()
