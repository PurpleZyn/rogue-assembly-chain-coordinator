# Setup and Testing Guide — v0.2.0

There is no backend to deploy in v0.2.0. Only the chain watcher installs the userscript.

## Install in Tampermonkey

Open:

`https://raw.githubusercontent.com/PurpleZyn/rogue-assembly-chain-coordinator/main/userscript/rogue-assembly-chain.user.js`

Tampermonkey should offer to install **Rogue Assembly Chain Watcher**.

If it does not, create a new Tampermonkey script, replace its contents with the raw GitHub file, and save.

## Optional API key

The script does not need an API key for the local rotation itself.

A Torn public-access API key can be entered under **⚙ Settings** if you want the watcher panel to display the current faction chain count and timeout.

## Rotation behavior

The rotation is persistent and round-robin:

`A → B → C → D → A → B → ...`

A member types `!hit` once to join. They remain in the rotation after every hit until they type `!cancel` or the watcher removes them manually.

When the watcher clicks **Hit Complete + Next**, the current hitter moves to the back automatically.

## First test

Start with 2–3 people before using it for a real chain.

1. Open Torn on the watcher account with the userscript enabled.
2. Open the faction chat and keep it visible.
3. Have Player A type `!hit`.
4. Have Player B type `!hit`.
5. Click **Scan Faction Chat**.
6. Confirm A and B appear in the rotation in chat order.
7. Click **Call Next**.
8. Confirm the script fills the faction chat input with a call for A and B on deck.
9. Press Enter manually to send the message.
10. Click **Hit Complete + Next** after A makes the hit.
11. Confirm the rotation changes from `A → B` to `B → A` and a message for B is prepared.
12. Have A type `!cancel`.
13. Click **Scan Faction Chat** again.
14. Confirm A is removed while B remains.

## If Scan Faction Chat does not recognize commands

The script intentionally does not silently guess a sender.

If you can visibly see a `!hit` or `!cancel` in faction chat but the panel says it found no command or could not identify the sender, take a screenshot that includes:

- the open faction chat,
- the command message,
- the sender name,
- and the watcher panel result.

That will let us tune the Torn chat selector for the current chat markup.

## Chat messages are not auto-sent

Buttons such as **Call Next** and **Hit Complete + Next** only prepare/fill the faction-chat message. The watcher must review the message and press Enter manually.

## Local storage

The rotation, current-call state, and already-processed visible commands are stored locally in the userscript storage on the watcher device. Refreshing Torn should not wipe the active rotation.
