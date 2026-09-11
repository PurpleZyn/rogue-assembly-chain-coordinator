# Rogue Assembly Chain Coordinator

A cross-platform Torn userscript for coordinating Rogue Assembly faction chains without automating gameplay.

The script is designed to run in both **Tampermonkey** on desktop and **Torn PDA** on mobile. It provides a shared chain-watcher panel and a live hit-request queue so faction members can request a turn, see their position, and know when they have been called.

## What v0.1 does

- Authenticates a player with a Torn **public-access API key**.
- Verifies that the player belongs to **Rogue Assembly [54651]**.
- Does **not** store Torn API keys on the backend.
- Creates a short-lived signed session token after verification.
- Lets a member claim the **Primary Watcher** or **Backup Watcher** role.
- Lets members **Request Hit**, see their queue position, cancel a request, and mark a called hit complete.
- Lets watchers **Call Next**, **Skip Current**, and **Reset Queue** for a new chain session.
- Shows the current Torn faction chain count and timeout using Torn's official API.
- Uses normal HTTP polling so the same userscript can work in Torn PDA as well as Tampermonkey.
- Pauses aggressive refreshing while the Torn page is hidden.
- Never clicks attack, performs attacks, or submits Torn gameplay actions automatically.

## Project layout

```text
userscript/rogue-assembly-chain.user.js   Torn/Torn PDA userscript
worker/src/index.js                       Cloudflare Worker REST API
migrations/001_init.sql                   D1 database schema
wrangler.toml.example                     Cloudflare configuration template
package.json                              Wrangler/dev scripts
docs/SETUP.md                             Deployment and installation guide
```

## Architecture

```text
                    Torn official API
                         /       \
                        /         \
               identity/faction   chain status
                      |               |
                      v               v
Tampermonkey / Torn PDA userscript -------------------+
          |                                            |
          | HTTPS REST                                 |
          v                                            |
Cloudflare Worker <----> Cloudflare D1                 |
  authentication       shared queue/watchers           |
          |                                            |
          +--- verifies key with Torn API -------------+
```

GitHub distributes the userscript and keeps updates in one place. Cloudflare Worker + D1 provide the shared state that all faction members see.

## Safety / Torn scripting compliance

The tool intentionally does not automate gameplay. Queue actions only coordinate faction members. A player still manually navigates Torn and manually performs every attack.

Torn data used by the script comes from Torn's official API. The shared queue is data created by this tool itself.

## Setup

See [`docs/SETUP.md`](docs/SETUP.md).

## License

GPL-3.0-only
