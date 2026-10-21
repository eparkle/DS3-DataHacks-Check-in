# DS3 DataHacks Check-In

QR check-in desk for DataHacks. Organizers sign in, scan an attendee’s user UUID (or paste their email), and the app calls the Supabase `check_in_attendee` RPC.

The live roster comes from `v_checkin_list` (accepted hackers, mentors, and judges). Check-in writes a row to `checkins`.

## Local

```bash
npm install
cp .env.example .env
# fill VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY
npm run dev
```

Open http://localhost:5173 and sign in with an **organizer** account.

That account must have `event_roles.role = 'organizer'` for the event. The RPC and RLS both depend on `is_event_staff()`.

Current event in this project:

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

## Vercel

1. Import this repo in Vercel (framework: Vite).
2. Set the same env vars as `.env.example`:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
3. Deploy.

```bash
npx vercel
```

Vite inlines `VITE_*` variables at **build** time, so change them in Vercel and redeploy if they rotate.

## How check-in maps to Supabase

| App action | Backend |
| --- | --- |
| Load attendees | `v_checkin_list` filtered by the latest `events` row |
| Scan / manual check-in | `check_in_attendee(p_event_id, p_user_id)` |
| Duplicate scan | RPC returns `already_checked_in: true` |
| Team column | `team_members` + `teams` (blank if RLS blocks it) |

QR payloads should be the attendee `profiles.id` UUID. Email works as a fallback once that person is on the roster.

## Organizer setup checklist

1. Create the staff user in Supabase Auth.
2. Ensure they have a `profiles` row (`id` = auth user id).
3. Insert `event_roles (event_id, user_id, role)` with `role = 'organizer'`.
4. Accept hacker / mentor / judge applications so `promote_accepted` fills `event_roles` and they appear on `v_checkin_list`.

## QR codes and email passes

Both scripts read accepted attendees from `v_checkin_list`. The QR / Wallet barcode is the attendee’s `profiles.id` UUID (what the desk scans).

Put `SUPABASE_SERVICE_ROLE_KEY` in `.env` (Dashboard → Settings → API). The anon key cannot read the full roster because of RLS. Do not put the service role key in Vercel or the frontend.

```bash
pip install -r requirements.txt
python generate_checkin_codes.py
python send_emails.py --dry-run
python send_emails.py
```

`send_emails.py` also needs `WALLETWALLET_API_KEY`, `GMAIL_ADDRESS`, and `GMAIL_APP_PASSWORD`. Passes are cached in `wallet_passes/<user_id>.pkpass` so a retry does not burn WalletWallet quota.
