# Rogue Assembly Chain Watcher

A local Torn userscript for the person actively running a Rogue Assembly chain.

**v0.2.0 removes the shared backend entirely.** There is no Cloudflare Worker, no shared database, and faction members do not need to install anything.

The watcher keeps one persistent local rotation and manually scans visible faction chat for simple commands:

- `!hit` — join the rotation. A member only needs to do this once; after each completed hit they move to the back automatically and stay in the rotation.
- `!cancel` — leave the rotation.

## Watcher workflow

1. Open Torn and keep faction chat visible.
2. Members type `!hit` when they want into the ongoing rotation.
3. Click **Scan Faction Chat** in the watcher panel.
4. The script adds/removes members from the local rotation.
5. Click **Call Next**. The script prepares the call message in faction chat.
6. The watcher reviews it and presses Enter manually.
7. When that member finishes, click **Hit Complete + Next**.
8. The completed hitter moves to the back and the next member becomes current.
9. Repeat until members use `!cancel` or the watcher removes them.

The userscript never sends chat automatically and never performs attacks.

## Features

- Persistent round-robin rotation stored locally in the watcher browser.
- Manual **Scan Faction Chat** command processing.
- `!hit` joins once and remains in rotation across repeated hits.
- `!cancel` removes a member.
- **Call Next**, **Hit Complete + Next**, and **Skip / Rotate** controls.
- Manual add/remove fallback.
- Fills the faction chat input with call/rotation messages when Torn's chat DOM can be identified; otherwise copies the message to the clipboard.
- Optional Torn public API key for chain count and timeout.
- Tampermonkey-compatible and designed to remain Torn PDA-friendly.
- No backend hosting requirement.

## Install

Open the raw userscript URL with Tampermonkey:

`https://raw.githubusercontent.com/PurpleZyn/rogue-assembly-chain-coordinator/main/userscript/rogue-assembly-chain.user.js`

The script includes `@updateURL` and `@downloadURL` metadata pointing to the same GitHub file.

## First test

See [`docs/SETUP.md`](docs/SETUP.md).

## Important testing note

Torn's chat markup can change. The first v0.2 test intentionally reports when it can see a `!hit`/`!cancel` command but cannot identify the sender. If that happens, capture a screenshot of the open faction chat and the script panel; the selector can then be tuned without changing the rotation design.

## License

GPL-3.0-only
