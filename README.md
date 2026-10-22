# DS3 DataHacks Check-In

QR check-in desk for DataHacks. Organizers sign in, scan an attendee code such as `DH26-H001`, and the app calls `check_in_by_code`.

The live roster is `public.attendees`, filled automatically when an application is **accepted** (`upsert_attendee`). Check-in writes `attendees.checked_in_at`.

## Local

```bash
npm install
cp .env.example .env
# fill VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY
npm run dev
```

Open http://localhost:5173 and sign in with an **organizer** account (`event_roles.role = 'organizer'`).

Current event:

```sql
-- DataHacks 2026
-- events.id = 96f5c446-76df-4001-948c-67c01a56ebcf
insert into public.event_roles (event_id, user_id, role)
values (
  '96f5c446-76df-4001-948c-67c01a56ebcf',
  '<organizer-auth-user-uuid>',
  'organizer'
);
```

Apply the check-in SQL in the Supabase SQL Editor first so `events.code`, `attendees`, `check_in_by_code`, and `undo_check_in` exist.

## How check-in maps to Supabase

| App action | Backend |
| --- | --- |
| Load roster | `attendees` for the event with a `code` |
| Scan / manual / list check-in | `check_in_by_code(p_event_id, p_code)` |
| Duplicate scan | RPC returns `{ status: "dupe" }` |
| Undo | `undo_check_in(p_event_id, p_code)` |
| Live updates | Realtime on `attendees` |

Codes: `DH26-H001` (hacker), `DH26-J001` (judge), `DH26-M001` (mentor), `DH26-B001` (mentor+judge). Email still resolves to a code if that person is on the roster.

## QR codes and email passes

```bash
pip install -r requirements.txt
python generate_checkin_codes.py
python send_emails.py --dry-run
python send_emails.py
```

Scripts read `attendees` with `SUPABASE_SERVICE_ROLE_KEY`. QR / Wallet barcodes are `attendees.code`. Successful sends set `emailed_at`; use `--resend` to email those people again.

Do not put the service role key in Vercel or the frontend. `send_emails.py` also needs `WALLETWALLET_API_KEY`, `GMAIL_ADDRESS`, and `GMAIL_APP_PASSWORD`. Passes are cached in `wallet_passes/<code>.pkpass`.
