# Sable Hearts Agent Guide

## Project Overview

Sable Hearts is a multiplayer online Gong Zhu / 拱猪 card game. The project uses TypeScript across the frontend, backend, and core game logic.

## Maintenance Rules

- Whenever the code structure is changed, added to, or deleted from, update the "Code Structure" and "Important Files" sections in this file at the same time.
- Whenever the codes are modified, check whether README.md needs updates for user-facing setup.
- When the production site URL or custom domain changes, update the absolute URLs in `index.html` (`canonical`, `og:url`, `og:image`, `twitter:image`) and any deployment links in `README.md`.
- Whenever some features are changed, added to, or deleted from, update the tests and run tests.
- Whenever code is modified, added, or removed, assess whether the version in `package.json` should be bumped. Before changing it, tell the user whether a bump is needed; when it is, recommend the exact next SemVer version and ask for approval.

## Code Structure

```text
.
|-- AGENTS.md              # Agent guide for AI agents
|-- README.md              # User-facing setup, game rules, and deployment notes
|-- index.html             # Browser entry HTML that mounts the React app
|-- package.json           # npm scripts, dependencies, and project metadata
|-- package-lock.json      # npm dependency lockfile
|-- tsconfig.json          # TypeScript type-checking configuration
|-- vite.config.ts         # Vite frontend dev server and build configuration
|-- assets/                # Logo and screenshots used by README
|-- public/assets/         # Static assets served directly by the frontend
|-- src/
|   |-- core/              # Pure game rules and state logic
|   |-- server/            # Node.js backend, auth, rooms, and realtime communication
|   `-- web/               # React frontend UI and styles
`-- tests/                 # Vitest tests
```

## Important Files

### `index.html`

- Browser entry HTML that mounts the React app.
- Defines page title, SEO metadata (`description`, `keywords`), and social preview tags (`og:*`, `twitter:*`).
- The production canonical URL is currently `https://sable-hearts.onrender.com/`.
- When binding a custom domain, update every absolute URL in this file (`canonical`, `og:url`, `og:image`, `twitter:image`) to the new domain.

### `src/core/`

`src/core` is the most important business layer in this project. Keep it as pure TypeScript that does not depend on browser APIs or backend framework APIs whenever possible. This lets the game rules be reused by the backend, frontend, and tests.

- `src/core/cards.ts`
  - Defines suits, ranks, the `Card` type, and card IDs.
  - Provides base helpers such as `createCard`, `cardLabel`, `suitLabel`, `rankLabel`, and `sortHand`.
  - Start here when changing card display order, suit order, or card representation.

- `src/core/config.ts`
  - Defines supported player counts: 3, 4, 5, 6, and 7.
  - `getGameConfig` decides deck count, hand size, and removed cards for each player count.
  - Start here when changing how cards are dealt for a given number of players.

- `src/core/deck.ts`
  - Builds decks from `GameConfig`.
  - Handles removing configured cards, creating random seeds, and shuffling by seed.
  - `shuffleDeck` is reproducible: the same seed produces the same shuffled deck, which helps testing and debugging.

- `src/core/game.ts`
 - Core game state machine.
 - Defines `GameState`, player state, current trick, completed tricks, and related types.
 - `createGame` creates a game and deals cards; an optional `leaderId` sets who leads the first trick.
 - `pickLowestScoreLeader` chooses the player with the lowest score as the next first leader (seat order breaks ties).
 - `getLegalCards` determines which cards a player can currently play.
  - `playCard` applies one card play and updates the current trick or completes a trick.
  - `resolveTrick` determines the winner of a trick.
  - When a game ends, this module calls scoring logic and changes the state to `finished`.

- `src/core/scoring.ts`
  - Implements score and coin settlement.
  - `rawCardPoint` defines base point values for the queen of spades, jack of diamonds, hearts, and other cards.
  - `calculateScore` handles heart sweeps, queen of spades conversion, club ten multipliers, and club-ten-only bonuses.
  - `calculateCoins` converts scores to coin losses based on the room's exchange rate.
  - `calculateSettledCoins` either replaces the previous round's coins or adds the new settlement for cumulative rooms.
  - `calculateCoinSettlement` returns the previous, current-round, and total coin values used by cumulative settlement summaries.

- `src/core/index.ts`
  - Barrel export for the core modules.
  - Tests and frontend code can import core capabilities through `../src/core` or `../core`.

- `src/core/bot.ts`
  - Pure, deterministic bot decision logic.
  - `chooseBotCard(state, playerId, difficulty)` returns the card a bot should play.
 - `chooseBotDecision(state, playerId, difficulty)` additionally returns a structured decision trace for server-side logging.
 - `BOT_STRATEGY_CONFIG` centralizes simple-bot weights, medium-bot scoring/sweep parameters, and hard-bot rollout-budget/utility parameters.
 - Four difficulties: `foolish` picks any legal card, `simple` uses lightweight heuristics, `medium` evaluates public card history and inferred void suits, and `hard` samples hidden hands for deterministic rollouts.
 - Stronger bots only use their own hand and public information; they do not inspect opponents' real hidden cards.
  - Start here when tuning or adding bot difficulties.

### `src/server/`

`src/server` is the backend layer and runs in Node.js.

- `src/server/index.ts`
  - Main backend entry point.
  - Creates the Express app, HTTP server, and Socket.IO server.
  - Manages in-memory rooms through `rooms`.
  - Handles Socket.IO events for registration, login, auth resume, room creation, room join, reconnect, ready state, adding/removing bots, game start, card play, and game restart.
 - Bots are seats with `isBot: true` and no socket. `addBot`/`removeBot` are host-only and only allowed before the game starts. `maybeRunBots` schedules a bot's move (via `chooseBotDecision`) whenever the current player is a bot, chaining through consecutive bot turns.
  - Room seats retain settled coin balances. Rooms can opt into cumulative coins at creation; that choice and the cumulative room's coin rate are immutable after creation.
 - Actual bot decisions are appended as structured JSONL to `logs/bot-decisions-YYYY-MM-DD_HH-mm-ss-SSS-ROOMCODE.jsonl`, keyed by room creation time and room code; rollout-internal simulated moves are not logged.
  - `publicRoomState` builds the room state for each viewer so other players' hands are not sent to the current player.
  - After a production build, if `dist/` exists, this file serves the frontend static files.

- `src/server/auth.ts`
  - Simple account system.
  - Stores user data in `data/users.json`.
  - Hashes passwords with Node.js `crypto.scryptSync`.
  - Session tokens are currently kept in an in-memory `Map`, so users must log in again after a server restart.

### `src/web/`

`src/web` is the browser-side React app.

- `src/web/main.tsx`
  - Frontend entry point.
  - Renders React's `<App />` into `#root` from `index.html`.

- `src/web/App.tsx`
  - Main frontend UI and interaction logic.
  - Connects to the backend through Socket.IO.
  - Manages UI state for login, room creation/joining, ready state, game start, card play, rules modal, room settings, and reconnect recovery.
  - Room creation includes the coin rate and cumulative-coin choice. Seat coin values come from completed-round settlements, and cumulative final summaries show the previous total plus the current round before the new total.
 - Reads the application version from `package.json` and displays it in the top bar.
  - Defines frontend types that mirror backend room-state payloads, such as `PublicRoomState`, `SeatState`, and `RoomSession`.

- `src/web/styles.css`
  - Global CSS styles.
  - Controls layout, buttons, modals, cards, player areas, and responsive presentation.

## Running

```powershell
npm install
npm test
npm run build
npm start
```
