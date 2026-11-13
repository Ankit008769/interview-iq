# Sharing the app from a laptop (free)

While the Google Cloud staging project has no billing, the whole app can still be shared from the
development laptop. That includes the local AI models and the database. It goes through a **Cloudflare quick
tunnel**, which needs no Cloudflare account and no card.

## Steps (Windows)

1. Get `cloudflared` from Cloudflare's official releases:
   https://github.com/cloudflare/cloudflared/releases. Use `cloudflared-windows-amd64.exe` and check its
   SHA-256 against the one listed on the release page. Keep it outside the repo, for example in
   `E:\InterviewIQ\tools\cloudflared.exe`.
2. Make sure MongoDB and the local models are running, as for local development ([LOCAL_MODELS.md](LOCAL_MODELS.md)).
3. Build the website once: `cd client && npm run build`.
4. Start sharing from the repo root:

   ```
   node deploy/share-tunnel.mjs --port 5100 --cloudflared E:\InterviewIQ\tools\cloudflared.exe
   ```

   The script prints a link such as `https://some-words.trycloudflare.com`. Send it to the people who should
   try the app.
5. Press Ctrl+C to stop. The link stops working at once, and the next start gets a new link.

If the models are not on Ollama's default port, set `LLM_BASE_URL` first, for example
`set LLM_BASE_URL=http://127.0.0.1:11435/v1`.

## What the script sets

The shared copy reads `server/.env` like local development, then overrides these settings:

| Setting | Value | Why |
|---|---|---|
| `SERVE_CLIENT` | `true` | It serves the built website itself, so the site and the API share one address |
| `PORT` | `--port` (5100) | Leaves local development on 5000 and 5173 |
| `CLIENT_ORIGIN` | The tunnel address | Sign-in and every write check the origin, and email links point there |
| `COOKIE_SECURE` | `true` | Session cookies are sent only over HTTPS |
| `TRUST_PROXY_HOPS` | `1` | Per-visitor limits see the visitor's address forwarded by the tunnel |
| `PASSPORT_ISSUER_HOST` | The tunnel host | Skill passports issued while sharing verify at that address; they stop verifying once the link changes |

## Limits and cautions

- **The laptop does all the work.** It must stay on and connected. AI answers are as slow as they are
  locally, roughly 20–150 seconds, and several people at once will queue.
- **Anyone with the link can open the app**, create an account and use the AI, within the app's normal
  quotas. Share it only with people you trust, and stop sharing when you are done.
- **Quick tunnels are for testing and demos.** Cloudflare gives no uptime guarantee, and the address
  changes on every start. A fixed address would need a named tunnel, with a free Cloudflare account and a
  domain.
- **The database is the same one** local development uses. Accounts and interviews created through the link
  are real local data.
- **What doesn't work yet:**
  - the coding lab needs the sandboxed runner, which is not running locally;
  - voice answers need the local speech model to be running.
