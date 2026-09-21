# Jev Flight Lab

A Flappy Bird game controlled by **TypeSafe Jev through OpenRouter**, with a canvas landscape, live decision probabilities, an input/output inspector, and a manual mode.

## Run locally

Requires Node.js **22.13 or newer**. No dependencies or build step.

```sh
cp .env.example .env
```

Add your OpenRouter key in `.env`:

```dotenv
OPENROUTER_API_KEY=your_key_here
JEV_MODEL=typesafe/jev-1.13
PORT=3000
```

```sh
npm start
```

Open **http://localhost:3000** and click **Start flight**. Restart the server after editing `.env`. `npm run dev` restarts when source files change. The server binds to loopback for local use; add authentication and appropriate request limits before exposing it publicly. `.env` is ignored by Git, never served, and the key stays on the server.

Without a key, choose **Your turn**. Press **Space** or tap the game to flap, **P** to pause, or use the on-screen controls. Switching away from the browser tab pauses the flight and cancels outstanding requests. Best scores are stored locally, separately for human, guarded Jev, and unguarded Jev flights. There is no automatic restart or hidden background inference.

Pipes and scenery gradually accelerate from **1× to 2× speed over 50 seconds** of active flight, then stay at 2×. The **Speed boost** slider below the game adds a multiplier from **1× to 2×**, adjustable before or during flight (up to **4× total speed** once the automatic ramp finishes). The sky shows the combined speed live. Pausing freezes the ramp; each new flight resets the ramp and keeps your selected boost. Boost changes affect future motion without jumping pipes or scenery. Bird gravity and flap strength stay the same. Jev's input, trajectory predictions, and collision guard all use the same accelerating world speed.

## The decision loop

1. The browser sends the current bird position, velocity, and pipe gaps to `POST /api/decision`.
2. The server validates the state, simulates the possible flap/coast trajectories, and constructs a typed `choice` question.
3. The server calls **`https://openrouter.ai/api/alpha/decisions`** with `{ model, state, questions }` and Bearer authentication. Jev uses the Decisions endpoint here.
4. Jev returns `answers.movement.choice` (`flap` or `coast`), with optional `confidence` and `probabilities`. The chosen action is used directly. Missing probability values are shown as unavailable.
5. Physics advances continuously at a fixed 120 Hz; canvas rendering follows the display refresh rate. Jev requests run independently, with at most one in flight and at least 180 ms between request starts. Each reply is consumed once at the next 180 ms control boundary. A flap resets upward velocity; without a new reply the bird coasts, subject to the optional guard. The network never freezes normal flight. The displayed response time includes the full browser round trip.

The optional **collision guard** runs locally every 180 ms, including while a request is pending. It searches possible flap/coast sequences over eight decision steps (1.44 simulated seconds). Each late Jev decision is checked against the bird's **current** position before application. If the proposed move has no safe continuation but the alternative does, the guard substitutes the alternative. With no fresh reply, the proposed move is coast; any corrective flap is labeled **guard while awaiting Jev**. These interventions do not increment the Jev decision count. The inspector records the original input, response, state age, actual application state, and any correction. Turn the guard off for pure Jev control; the bird then coasts during delayed replies and may crash. It is a finite-horizon check, **not a guarantee of collision-free play**. API errors pause the flight; resume explicitly to retry. Requests consume OpenRouter credits; the flight summary shows reported usage cost when available.

The inspector shows the input state (including predictions) and normalized response, with latency, model, probabilities, cost, and any guard intervention. The fixed question and choice criteria are in `server/jev.js`.

Verified against the [OpenRouter Decisions API reference](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-questions-and-answers-request) and [Jev model page](https://openrouter.ai/typesafe/jev-1.13).

## Checks

```sh
npm test
```

Tests cover physics/prediction consistency, pipe and boundary collisions, scoring, guard interventions, the documented request/response shape, missing keys, upstream failures, state validation, private file isolation, cross-origin rejection, and concurrent-request handling. Provider calls in tests use mocks and do not consume credits. A live integration check requires your OpenRouter key.

## Files

- `public/engine.js` — shared simulation, trajectory prediction, and collision guard.
- `public/app.js` — canvas artwork, UI, and cancellable control loop.
- `public/pilot.js` — continuous control loop and mailbox for asynchronous decisions.
- `public/index.html`, `public/styles.css` — responsive flight deck.
- `server/jev.js` — Jev question, validation, and OpenRouter request.
- `server/index.js` — local server and server-only environment handling.
- `test/` — Node's built-in test suite.
