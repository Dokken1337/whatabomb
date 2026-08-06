# What'a Bomb! 💣

A Bomberman-style arena game for the browser. Play against AI, share a keyboard,
or take 2–4 players online with a six-digit lobby code.

TypeScript and Babylon.js on the front, a small Node lobby server behind it,
deployed to Azure App Service by GitHub Actions.

---

## Features

- **Seven ways to play** — 1v1, 1v2 and 1v3 against AI, local Player vs Player,
  Survival waves, Time Attack, and online matches for 2–4 players
- **Match play** — a single round, best of 3, or best of 5
- **Arenas** — three sizes (13×13, 17×17, 21×21) across six themes: classic,
  ice, lava, forest, space and moon
- **Fair, connected maps** — layouts are four-fold symmetric so every corner
  gets the same opening, and the generator guarantees the whole map is reachable
- **AI worth playing** — it pathfinds toward you, blasts tunnels through crates,
  escapes its own blasts and picks up power-ups; speed, health, aggression and
  power ceiling all scale with difficulty
- **Ten power-ups**, statistics, achievements, and customisable colours,
  character shapes, difficulty and controls

---

## Playing

| Mode | Players |
| --- | --- |
| Player vs 1–3 AI | Single player |
| Player vs Player | Two on one keyboard |
| Survival | Endless waves |
| Time Attack | Score against the clock |
| **Play Online** | 2–4 players, best-of-N |

### Controls

| | Move | Bomb |
| --- | --- | --- |
| Player 1 | `WASD` | `Space` |
| Player 2 (local PvP) | Arrow keys | `Enter` |

`Escape` pauses. A touch D-pad and bomb button appear automatically on phones;
desktop players can turn them on under **Settings → On-Screen Controls** and
drive them with a mouse — click a direction, or drag across the D-pad.

### Power-ups

Always in the pool:

| Power-up | Effect |
| --- | --- |
| 💣 Extra Bomb | Carry more bombs at once, up to 8 |
| ⚡ Larger Blast | Bigger explosion radius, up to 8 |
| 🦶 Kick | Kick bombs by walking into them |
| ✋ Throw | Hurl the bomb you are standing on |
| 👟 Speed | Move faster, five levels from 150ms to 90ms per tile |

Turn on **Extended Power-Ups** in the menu to add 🛡️ Shield, 🔥 Pierce,
👻 Ghost, ☢️ Power Bomb and 🧨 Line Bomb.

---

## Running it

Requires **Node.js 22.12+**.

```bash
npm --prefix game install
```

### Offline

```bash
npm --prefix game run dev
```

Open the URL Vite prints. Every mode except **Play Online** works from here.

### With online play

Online needs two processes: Vite for the client, and the Node server that owns
the lobbies. Run them in separate terminals.

```bash
npm --prefix game run build:server && npm --prefix game start
```

```bash
npm --prefix game run dev
```

Vite proxies `/ws` through to the lobby server on port 8080, so you still open
the Vite URL. Create a lobby in one browser tab and join with the code from
another.

> `npm start` runs the **compiled** server from `game/dist-server/`. After
> changing anything under `game/server/` or `game/shared/`, re-run
> `build:server` — or leave `npm --prefix game run dev:server` recompiling on
> save.

### Commands

All run from `game/`, or with `--prefix game`.

| Command | What it does |
| --- | --- |
| `npm run dev` | Vite dev server with hot reload |
| `npm run dev:server` | Recompile the lobby server on save |
| `npm start` | Run the compiled lobby server (port 8080) |
| `npm run build` | Type-check, bundle the client, compile the server |
| `npm run build:server` | Compile `server/` and `shared/` only |
| `npm run test:server` | Run every test suite |
| `npm run preview` | Serve the production client build |

---

## Repository layout

```
game/
  src/          Client: rendering, gameplay, menus, netcode glue
  server/       Lobby server: WebSocket relay, lobby rules, Redis fan-out
  shared/       Code both ends compile — wire protocol and the movement clock
  test/         node:test suites (lobby flow, multi-instance, movement)
azure/bicep/    Infrastructure as code for the App Service, Redis and networking
.github/        Deployment workflow
```

`shared/` is the important boundary: anything the client and server must agree
on lives there and is compiled into both bundles.

**Stack:** TypeScript · Babylon.js · Vite · Express · ws · Redis

---

## How online play works

One player's browser is the **host** and runs the whole simulation. The Node
server never simulates anything — it relays input to the host and snapshots back
out, and owns lobby membership. Guests are pure renderers, so there is no second
source of truth to drift from.

That design would otherwise make a guest wait a full round trip before their own
keypress moved anything, so guests **predict** their own movement immediately and
reconcile when the host's answer arrives.

Three pieces make that work, all in [`game/shared/movement.ts`](game/shared/movement.ts):

- **A shared movement clock.** Both ends bank elapsed milliseconds toward the
  next step rather than stamping the time of the last one. Because credit
  accumulates linearly, 300ms as one chunk equals ten ticks of 30ms — which is
  what lets a guest re-derive its position in a single pass.
- **Replay reconciliation.** When a snapshot arrives, a guest does not compare
  positions and snap on a mismatch — being ahead is the *normal* state while
  anyone is moving. It re-applies the inputs the host had not yet seen on top of
  the authoritative state, so it disagrees only where the host genuinely knew
  something it could not.
- **Interpolated remote players.** Other players are drawn a fixed moment behind
  the newest report, between two known positions, so their movement is an
  interpolation rather than a pursuit.

Blast resolution is lag-compensated: the host's copy of a remote player is one
network delay stale, so it projects them forward by the measured delay before
deciding who was caught. Lag buys a correction for that staleness, never
immunity.

Clock skew is deliberately impossible to hit — every timestamp on the wire is
only ever differenced against a clock its own sender owns, so players in
different time zones with wrong clocks still agree.

### Tests

The movement rules are the one part that must produce identical results on two
machines, so they are pure functions with no DOM, Babylon or socket involvement,
and they run headlessly in well under a second:

```bash
npm --prefix game run build:server && npm --prefix game run test:server
```

The lobby suites spin up real servers over real WebSockets. Set `REDIS_URL` to
also run the two-instance test, which is otherwise skipped.

---

## Deployment

Pushing to `main` triggers [`.github/workflows/whatabomb-deploy.yml`](.github/workflows/whatabomb-deploy.yml),
which deploys the Bicep infrastructure, builds and tests the game, stages a
self-contained package (build output plus production dependencies only) and
uploads it to Azure App Service.

The run does not go green on a deploy that merely landed: it polls `/healthz`
until the app answers, and fails if lobby state is not shared. That catches an
instance which came up without `REDIS_URL` — the failure mode where lobbies
created on one instance are invisible to all the others.

| Variable | Effect |
| --- | --- |
| `PORT` | Server port (default `8080`) |
| `REDIS_URL` | Shares lobby state across instances. Without it the server runs single-instance |

---

## License

MIT
