# OpenDesk Messaging Server

This is what makes real texting between two OpenDesk installs actually
work. Without it, Messages stays in Demo Mode (simulated replies only).

It's a single file, `server.js`, with **zero dependencies** — nothing to
`npm install`. It only uses Node's built-in modules. That also means it's a
small, demo-grade server: passwords are hashed but not salted, there's no
rate-limiting or spam protection, and everyone's messages sit in a plain
JSON file on disk. Fine for you and your friends; not a production
messaging platform.

## What it does

- Each OpenDesk ID can only be "claimed" once. The first time someone
  connects with an ID, the server remembers it and its password. If anyone
  else tries to use that same ID with a different password, they're
  rejected — so IDs genuinely can't be duplicated across different people.
- Messages sent while the other person is online arrive instantly (no
  page refresh needed).
- Messages sent while they're offline are stored and delivered the next
  time they connect.
- `lookup` lets OpenDesk check whether an ID is a real registered user
  before adding it as a contact, and shows their real display name.

## Run it locally (to test)

```
node server.js
```

It listens on port 8787 by default (or the `PORT` environment variable).
Then in OpenDesk: Settings → Account → Real-Time Messaging, set the server
address to `ws://localhost:8787` and click Save & Connect.

## Host it for real — quickest free option (Render)

1. Go to render.com and sign up (a GitHub login is easiest).
2. Put `server.js` in its own GitHub repository (Render deploys from a repo).
3. In Render, click **New → Web Service**, connect that repository.
4. Environment: **Node**. Build command: `npm install`. Start command:
   `npm start` (or `node server.js` — both work).
   Render requires something in the build command field; `npm install` is
   correct even though `package.json` lists no dependencies to install —
   it will just complete instantly and move on.
5. Choose the free instance type, and click **Create Web Service**.
6. Once it deploys, Render gives you a URL like
   `https://opendesk-messaging.onrender.com`. Your WebSocket address is the
   same thing with `wss://` instead of `https://`:
   `wss://opendesk-messaging.onrender.com`.
7. In OpenDesk, paste that `wss://…` address into Settings → Account →
   Real-Time Messaging, and click Save & Connect.
8. Anyone else who wants to text through your server pastes the same
   `wss://…` address into their own OpenDesk.

**Free-tier note:** Render's free web services fall asleep after a period
of no traffic and take a few seconds to wake back up on the next
connection — the first connect attempt after a quiet stretch may need a
retry. Some free hosts also wipe the disk on redeploy, which would clear
`data/users.json` and `data/messages.json` (everyone's accounts and
message history on that server) — Railway and Fly.io have small persistent
free/low-cost disks if you want messages to survive a redeploy.

## Must it be `wss://`?

If OpenDesk is opened as a local file (double-clicking `Opendesk 1.html`),
`ws://` (no encryption) is fine. If OpenDesk is hosted on an `https://`
site, browsers require `wss://` (encrypted) — Render, Railway, and most
platforms give you that automatically, so this usually isn't something you
need to think about.

## Files

- `server.js` — the whole server.
- `package.json` — tells hosts like Render this is a Node app, and gives
  them a `start` command to run. It lists no dependencies, since
  `server.js` only uses Node's built-in modules.
- `data/` — created automatically the first time it runs; holds
  `users.json` and `messages.json`. Delete this folder to wipe every
  account and message on that server.
