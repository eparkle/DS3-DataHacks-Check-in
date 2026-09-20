"""
Step 3 of 3: Generate a real, signed Apple Wallet pass (.pkpass) for every
registrant via WalletWallet's API (no Apple Developer account needed - they
sign passes with their own certificate), then email each person their pass.

Setup:
    1. Sign up free at https://www.walletwallet.dev/signup/ (email only, no card).
       Free tier covers 1,000 passes/month - plenty for 450+100 people.
    2. Grab your API key from the WalletWallet dashboard.
    3. Set up a Gmail app password for sending (a normal consumer Gmail
       account, not a UCSD Workspace one - see earlier chat notes on why).
    4. pip install requests
    5. python send_emails.py

Notes:
    - Each person gets ONE pass, fetched once and cached to wallet_passes/<id>.pkpass
      so re-running this script after a partial failure doesn't re-spend your
      WalletWallet quota on people who already got a pass generated.
    - The .pkpass file is attached with the special Apple Wallet MIME type, so
      Mail/Gmail/Outlook on an iPhone shows a native "Add to Apple Wallet"
      button automatically - no extra HTML needed in the email body.
    - Regular Gmail accounts cap out around 500 sends/day; UCSD Workspace
      accounts are usually higher (~2000/day). With ~550 people you should fit
      in one run on a Workspace account - on personal Gmail, consider splitting
      across two days.
"""

import json
import smtplib
import ssl
import time
from email.message import EmailMessage
from pathlib import Path

import requests

# ---- WalletWallet ----
WALLETWALLET_API_KEY = "ww_live_187cdccce94d9f721284c84fee55f36c"
WALLETWALLET_URL = "https://api.walletwallet.dev/api/passes?format=pkpass"
ORG_NAME = "DataHacks"
EVENT_NAME = "DataHacks 2026"

# ---- Email (Gmail SMTP with an app password) ----
GMAIL_ADDRESS = "evanpark.contact@gmail.com"
GMAIL_APP_PASSWORD = "jozb ytlb pbpo aspp"
SEND_DELAY_SECONDS = 1  # gentle pacing so Gmail doesn't flag this as spam

INPUT_JSON = "registrants_export.json"
PASS_DIR = Path("wallet_passes")

ROLE_LABELS = {"participant": "Participant", "judge": "Judge", "mentor": "Mentor"}


def build_pass_payload(row):
    """Shape one registrant's data into a WalletWallet pass request body."""
    return {
        "barcodeValue": row["id"],
        "barcodeFormat": "QR",
        "logoText": EVENT_NAME,
        "organizationName": ORG_NAME,
        "primaryFields": [{"label": ROLE_LABELS[row["role"]].upper(), "value": row["name"]}],
        "secondaryFields": [
            {"label": "TEAM", "value": row.get("team") or "—"},
            {"label": "CODE", "value": row["id"]},
        ],
    }


def get_or_create_pass(row):
    """Fetch a .pkpass for this person, using a local cache so reruns don't
    re-generate passes for people who already have one."""
    PASS_DIR.mkdir(exist_ok=True)
    cache_path = PASS_DIR / f"{row['id']}.pkpass"
    if cache_path.exists():
        return cache_path

    resp = requests.post(
        WALLETWALLET_URL,
        headers={
            "Authorization": f"Bearer {WALLETWALLET_API_KEY}",
            "Content-Type": "application/json",
        },
        data=json.dumps(build_pass_payload(row)),
        timeout=30,
    )
    resp.raise_for_status()
    cache_path.write_bytes(resp.content)
    return cache_path


def build_email(row, pkpass_path):
    msg = EmailMessage()
    msg["Subject"] = f"Your {EVENT_NAME} check-in pass"
    msg["From"] = GMAIL_ADDRESS
    msg["To"] = row["email"]
    msg.set_content(
        f"Hi {row['name']},\n\n"
        f"You're registered for {EVENT_NAME} as a {ROLE_LABELS[row['role']]}.\n\n"
        f"Open the attachment on your iPhone to add your check-in pass to Apple Wallet, "
        f"or just show this email at the registration desk.\n\n"
        f"Your code: {row['id']}\n\nSee you there!"
    )
    with open(pkpass_path, "rb") as f:
        # This exact MIME type is what makes iOS Mail offer "Add to Apple Wallet".
        msg.add_attachment(
            f.read(),
            maintype="application",
            subtype="vnd.apple.pkpass",
            filename=f"{row['id']}.pkpass",
        )
    return msg


def main():
    with open(INPUT_JSON, encoding="utf-8") as f:
        rows = json.load(f)

    sent, failed = 0, []

    context = ssl.create_default_context()
    with smtplib.SMTP_SSL("smtp.gmail.com", 465, context=context) as server:
        server.login(GMAIL_ADDRESS, GMAIL_APP_PASSWORD)

        for row in rows:
            try:
                pkpass_path = get_or_create_pass(row)
                server.send_message(build_email(row, pkpass_path))
                sent += 1
                print(f"[{sent}/{len(rows)}] sent -> {row['email']} ({row['id']})")
            except Exception as e:
                failed.append((row["email"], str(e)))
                print(f"FAILED -> {row['email']}: {e}")
            time.sleep(SEND_DELAY_SECONDS)

    print(f"\nDone. Sent {sent}/{len(rows)}.")
    if failed:
        print(f"{len(failed)} failed:")
        for email, err in failed:
            print(f"  {email}: {err}")


if __name__ == "__main__":
    main()
