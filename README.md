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

## Signing in

Organizers can use **Sign in with Google** (the same Google sign-in as the DataHacks site) or an email and password. Either way, the account needs an `organizer` row in `event_roles`; anyone else is signed out on that device with "This Google account isn't an organizer."

Google sends people back to the page they started on, so that URL has to be in Supabase's **Redirect URLs** (Authentication → URL Configuration), for example `https://datahacks-check-in.vercel.app/**`, `https://datahacks-check-in-*-datahacks.vercel.app/**` for Vercel previews and `http://localhost:5173/**` for `npm run dev`. A URL that isn't allowed falls back to the Site URL.

## Choosing the event

After sign-in the app lists every event you are an organizer of (`event_roles` joined to `events`, events with a `code` only) and shows the one you're checking into as the event code in the top bar (tap it to switch). It defaults to the last event you picked on that device (localStorage), otherwise the newest event (`starts_at`, latest first). Switching asks for confirmation; every check-in, undo, roster tab, CSV export and live update then uses the selected event.

If your organizer events can't be loaded (the query fails), the app falls back to `VITE_EVENT_ID` (if set) or the newest event with a code, and shows a fallback warning above the scanner.

To check people into an event, your account needs an organizer row for it, for example:

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
| Scan / manual / list check-in | `check_in_by_code(p_event_id, p_code, p_checked_in_at, p_client_id, p_source)` |
| Duplicate scan | RPC returns `{ status: "dupe" }` |
| Undo | `undo_check_in(p_event_id, p_code, p_expected_checked_in_at, p_source)` |
| Meal / swag scan | `record_scan(p_event_id, p_code, p_scan_type_id, p_scanned_at, p_client_id, p_source)`; types from `scan_types`, who already had one from `checkin_events` |
| Not on roster | `lookup_not_on_roster(p_event_id, p_code_or_email)`, then `accept_walk_in(p_event_id, p_application_id)` |
| Live updates | Realtime on `attendees` |
| Waiver on file | `attendees.waiver_signed_at` (roster) and `waiver_signed_at` in the `check_in_by_code` result |
| ID check | `attendees.affiliation` and `attendees.is_18_plus_on_event_day` (roster and `check_in_by_code`) |
| "Checked in 10:42 by Evan" | `attendees.checked_in_by` → `profiles` first name |

The extra parameters, tables and columns come from the site repo's check-in log + scans migration. The app works on a database without them: an RPC that answers PGRST202 to the new parameters is called again the old way (and remembered for the session), the roster loads without missing columns, and with no `scan_types` table there's no mode switch.

## Meals and swag

When the event has active scan types (set up in the organizer console), a chip on the camera's top-left picks what scans record: **Check-in** (default) or a scan type such as "Lunch · Sat". In a scan mode the chip, the camera edge, the Record button and the result card turn indigo, and the card names the scan type:

- ✓ Lunch · Sat (recorded)
- amber "Already had Lunch · Sat" with the first time and who scanned it (one per person per scan type)
- amber "Not checked in yet" (still recorded, flagged for organizers)
- red "Not on roster"

The phone remembers the mode per event, and switching events goes back to Check-in. The roster tabs' Check in buttons always check in. Offline, scans are saved like check-ins and deduped against the scan types' saved lists and what's waiting to sync.

## Not on the roster, walk-ins and ID

A code or email that doesn't check in is looked up (`lookup_not_on_roster`): waitlisted (asked for a spot / offered one), marked no-show, not accepted, never applied, or another event. For a waitlisted hacker or a no-show, **Accept walk-in** / **Let in** (with a confirm) calls `accept_walk_in` and checks them in straight away if there's an open spot, or says "No open spots". Walk-ins need a connection.

A fresh check-in shows the school (hackers) or organization, and for hackers "18+", amber "Check ID: age unknown" or red "Under 18". The age is worked out by the database from the application's birthdate and the event's start date; the birthdate itself never reaches the desk.

## Liability waiver

The scan card and each roster row show whether the person's liability waiver is on file: a quiet "Waiver ✓", or an amber "No waiver". On the scan card, "No waiver · Sign now" opens a sheet with a QR code to the waiver page of their portal (`https://datahacks.ds3ucsd.com/portal/<hacker|mentor|judge|hybrid>/waiver`; set `VITE_PORTAL_URL` to point at another site). The QR is drawn on the device with zxing-wasm's writer, loaded the first time it's needed. The sheet flips to "Waiver on file" when the roster update arrives over Realtime.

The site records waivers (`public.waivers`, copied onto `attendees.waiver_signed_at` by the site repo's `waivers_on_file` migration). On a database without that column the roster loads without it and no waiver marker is shown.

Codes: `DH26-H001` (hacker), `DH26-J001` (judge), `DH26-M001` (mentor), `DH26-B001` (mentor+judge). Email still resolves to a code if that person is on the roster.

## QR codes and email passes

```bash
pip install -r requirements.txt
python generate_checkin_codes.py
python send_emails.py --dry-run
python send_emails.py
```

Both scripts take `--event-id <events.id>` (or `EVENT_ID` in `.env`). Without either they use the newest event with a code, so pass `--event-id` and check the `Event:` line of a `--dry-run` before sending.

Scripts read `attendees` with `SUPABASE_SERVICE_ROLE_KEY`. QR / Wallet barcodes are `attendees.code`. Successful sends set `emailed_at`; use `--resend` to email those people again.

Do not put the service role key in Vercel or the frontend. `send_emails.py` also needs `WALLETWALLET_API_KEY`, `GMAIL_ADDRESS`, and `GMAIL_APP_PASSWORD`. Passes are cached in `wallet_passes/<code>.pkpass`.
