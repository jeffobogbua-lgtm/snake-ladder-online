# Snake & Ladder Online — Created by Efe

## Included
- Real-time multiplayer Snakes & Ladders for 2–4 players, private room codes, chat and rematches.
- Token gate: each generated token is one-time use, with a separate redemption deadline and access duration.
- Owner dashboard at `/admin`; configure a private `ADMIN_PASSWORD` environment variable in your host.
- WhatsApp token-request button using the supplied contact number.
- Server-side token checks, socket access checks and automatic access expiry.

## Run
Install Node.js 20+, then run `npm install`.
Set `ADMIN_PASSWORD` to a strong private value in your hosting environment, then run `npm start`.
Open `http://localhost:3000`; open `/admin` to generate tokens.

## Important before public launch
This starter stores token records in `data/access-store.json`; hosting with an ephemeral filesystem may lose token records on restart. Configure persistent storage or move the store to a managed database before relying on tokens. The in-memory access sessions also reset after server restarts, so players may need to redeem a new token after a restart. Do not commit secrets or the data directory.
