# Setup Guide

This takes the Rogue Assembly Chain Coordinator from GitHub to a working shared faction queue.

## 1. Requirements

You need:

- This GitHub repository.
- A Cloudflare account.
- Node.js installed locally, or a GitHub Codespace.
- Wrangler, installed through this project's npm dependencies.

## 2. Install dependencies

From the repository root:

```bash
npm install
```

Then sign in to Cloudflare:

```bash
npx wrangler login
```

## 3. Create the D1 database

Run:

```bash
npx wrangler d1 create rogue-assembly-chain
```

Cloudflare will return a database ID.

Copy the example configuration:

```bash
cp wrangler.toml.example wrangler.toml
```

Open `wrangler.toml` and replace:

```text
REPLACE_WITH_YOUR_D1_DATABASE_ID
```

with the database ID Cloudflare returned.

The real `wrangler.toml` is ignored by Git so your deployment-specific configuration does not need to be committed.

## 4. Initialize the database

Run:

```bash
npm run db:init
```

This creates the shared queue, watcher slots, application state, and audit log.

## 5. Create the session signing secret

Generate a strong random secret. For example:

```bash
python -c "import secrets; print(secrets.token_hex(32))"
```

Then run:

```bash
npx wrangler secret put SESSION_SECRET
```

Paste the generated value when Wrangler asks for it.

Do not commit this secret to GitHub.

## 6. Deploy the Worker

Run:

```bash
npm run deploy
```

Wrangler will return a URL similar to:

```text
https://rogue-assembly-chain-api.YOUR-SUBDOMAIN.workers.dev
```

Test:

```text
https://YOUR-WORKER-URL/health
```

You should receive JSON with `"ok": true`.

## 7. Connect the userscript to the Worker

Open:

```text
userscript/rogue-assembly-chain.user.js
```

Find:

```js
const BACKEND_URL = "https://YOUR-WORKER.workers.dev";
```

Replace it with the actual Worker URL.

Commit that change to `main`.

## 8. Tampermonkey installation

Faction members can install from:

```text
https://raw.githubusercontent.com/PurpleZyn/rogue-assembly-chain-coordinator/main/userscript/rogue-assembly-chain.user.js
```

The userscript uses the same GitHub file for its update URL, so future version bumps can be distributed through the repository.

Desktop users enter a Torn public-access API key in the script's settings panel. The key is stored locally and is sent to the Worker only during authentication.

## 9. Torn PDA installation

Use the same raw GitHub userscript URL in Torn PDA's custom userscript feature.

The script contains the Torn PDA API-key placeholder:

```text
###PDA-APIKEY###
```

so Torn PDA users can use the key already configured in the app.

## 10. First multi-user test

Before faction-wide distribution:

1. Player A opens Torn and takes the Primary Watcher role.
2. Player B clicks **Request Hit**.
3. Confirm both devices show Player B in the shared queue.
4. Player A clicks **Call Next**.
5. Confirm Player B sees **YOU'RE UP**.
6. Player B manually performs their Torn attack.
7. Player B clicks **Hit Done**.
8. Confirm the request disappears.
9. Test the Backup Watcher role.
10. Test Skip Current and Reset Queue.

## Current configuration

- Faction: Rogue Assembly
- Faction ID: `54651`
- Session lifetime: 24 hours
- Watcher stale timeout: 180 seconds
- Queue polling: adaptive while Torn is visible
- Chain status: Torn official API
- Shared queue state: Cloudflare Worker + D1

## Privacy and gameplay boundaries

The Worker verifies the player's Torn identity and faction membership using the supplied public-access API key but does not write that API key to D1.

The script coordinates faction members only. It does not click attack, submit attacks, or otherwise perform Torn gameplay actions automatically.
