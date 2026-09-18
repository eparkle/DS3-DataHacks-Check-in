"""
Step 3 of 3: Email every registrant their personal QR code as an attachment.

Setup:
    1. Use a Gmail (or UCSD Google Workspace) account you don't mind sending from.
    2. Turn on 2-Step Verification, then generate an "App Password":
       https://myaccount.google.com/apppasswords
    3. Fill in GMAIL_ADDRESS / GMAIL_APP_PASSWORD below.
    4. python send_emails.py

Notes:
    - Regular Gmail accounts cap out around 500 sends/day; UCSD Workspace accounts
      are usually higher (~2000/day). With ~550 people you should fit in one run
      on a Workspace account - on a personal Gmail, consider splitting into two days.
    - This re-sends to everyone in registrants_export.json every time you run it.
      If you need to resume after a failure partway through, comment out rows
      you've already confirmed were sent, or filter the JSON before rerunning.
"""

import json
import smtplib
import ssl
import time
from email.message import EmailMessage
from pathlib import Path

GMAIL_ADDRESS = "evanpark.contact@gmail.com"
GMAIL_APP_PASSWORD = "nsby hvjn uezp xvsl"  # 16-char app password, not your login password
EVENT_NAME = "DataHacks 2026"
CHECKIN_INSTRUCTIONS = "Show this QR code (on your phone or printed) at the registration desk to check in."

QR_DIR = Path("qr_codes")
INPUT_JSON = "registrants_export.json"
SEND_DELAY_SECONDS = 1  # gentle pacing so Gmail doesn't flag this as spam


def build_message(row):
    msg = EmailMessage()
    msg["Subject"] = f"Your {EVENT_NAME} check-in QR code"
    msg["From"] = GMAIL_ADDRESS
    msg["To"] = row["email"]
    msg.set_content(
        f"Hi {row['name']},\n\n"
        f"You're registered for {EVENT_NAME} as a {row['role']}.\n\n"
        f"{CHECKIN_INSTRUCTIONS}\n\n"
        f"Your code: {row['id']}\n\n"
        f"See you there!"
    )
    qr_path = QR_DIR / f"{row['id']}.png"
    with open(qr_path, "rb") as img:
        msg.add_attachment(img.read(), maintype="image", subtype="png", filename=f"{row['id']}.png")
    return msg


def main():
    with open(INPUT_JSON, encoding="utf-8") as f:
        rows = json.load(f)

    context = ssl.create_default_context()
    sent, failed = 0, []

    with smtplib.SMTP_SSL("smtp.gmail.com", 465, context=context) as server:
        server.login(GMAIL_ADDRESS, GMAIL_APP_PASSWORD)
        for row in rows:
            try:
                server.send_message(build_message(row))
                sent += 1
                print(f"[{sent}/{len(rows)}] sent -> {row['email']}")
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
