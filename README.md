# CreateClub Codenames

This project is set up as a simple Vercel app:

- `codenames.html` is the frontend.
- `api/game.js` is the serverless API.
- `supabase/schema.sql` creates the database tables and seeds the card words.

## 1. Create Supabase

1. Create a new Supabase project.
2. Open the SQL Editor.
3. Run `supabase/schema.sql`.
4. Confirm that these tables exist:
   - `codenames_words`
   - `games`
   - `game_messages`

## 2. Add Vercel env vars

In your Vercel project settings, add:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Use the project URL and service role key from Supabase.

## 3. Install and run locally

```bash
npm install
vercel dev
```

Then open:

```text
http://localhost:3000/codenames.html
```

## 4. Deploy

Push this folder to GitHub and import it into Vercel, or deploy from the CLI:

```bash
vercel
```

## How it works

- Creating a room generates a board using words pulled from `codenames_words`.
- The API stores the current board in the `games` table.
- Chat messages are stored in `game_messages`.
- Clients poll `/api/game` every few seconds to stay in sync.

## Notes

- This version is intentionally lightweight: no auth and no realtime subscriptions yet.
- The service role key stays server-side inside the Vercel function.
- If you want, the next good upgrade would be Supabase Realtime so turns and reveals update instantly instead of polling.
