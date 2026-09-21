import test from "node:test";
import assert from "node:assert/strict";
import { createGame, WORLD } from "../public/engine.js";
import { RealtimePilot } from "../public/pilot.js";

function run(pilot, game, seconds, guarded = true, onAction) {
  for (let i = 0; i < Math.round(seconds / WORLD.tick); i++) {
    pilot.step(game, WORLD.tick, guarded, onAction);
  }
}

test("physics and obstacles keep moving during a two-second response delay", () => {
  const game = createGame(() => 0.5);
  const pilot = new RealtimePilot();
  const actions = [];
  run(pilot, game, 2, true, (action) => actions.push(action));
  assert.equal(game.alive, true);
  assert.ok(Math.abs(game.time - 2) < 0.001);
  // A 20% faster starting speed plus acceleration covers 281.52 px in 2s.
  assert.ok(Math.abs(game.pipes[0].x - (630 - 281.52)) < 0.001);
  assert.ok(actions.some((event) => event.source === "guard"));
  assert.ok(actions.every((event) => event.decision === null));
});

test("a Jev flap is applied once rather than repeated while awaiting a reply", () => {
  const game = createGame(() => 0.5);
  const pilot = new RealtimePilot();
  const actions = [];
  pilot.queue({ action: "flap" });
  run(pilot, game, 0.6, false, (action) => actions.push(action));
  assert.equal(actions.length, 1);
  assert.equal(actions[0].source, "jev");
  assert.ok(
    game.bird.vy > 0,
    "gravity should overcome the single flap impulse",
  );
});

test("late responses are guarded against the current bird state", () => {
  const game = createGame(() => 0.5);
  const pilot = new RealtimePilot();
  pilot.queue({ action: "flap", input: { bird: { y: 400 } } });
  game.bird.y = 30;
  const actions = [];
  run(pilot, game, WORLD.tick, true, (action) => actions.push(action));
  assert.equal(actions[0].proposedAction, "flap");
  assert.equal(actions[0].action, "coast");
  assert.equal(actions[0].guardIntervened, true);
  assert.equal(actions[0].currentState.bird.y, 30);
  assert.equal(game.alive, true);
});

test("reset discards queued replies and restarts the control clock", () => {
  const pilot = new RealtimePilot();
  pilot.queue({ action: "flap" });
  pilot.reset();
  const game = createGame(() => 0.5);
  const actions = [];
  run(pilot, game, WORLD.tick, false, (action) => actions.push(action));
  assert.equal(actions.length, 0);
  assert.ok(game.bird.vy > 0);
});

test("a long flight remains continuous with delayed and irregular replies", () => {
  const game = createGame(() => 0.5);
  const pilot = new RealtimePilot();
  let previousX = game.pipes[0].x;
  for (let i = 0; i < 30 / WORLD.tick; i++) {
    if (i % 96 === 0) pilot.queue({ action: i % 192 === 0 ? "flap" : "coast" });
    pilot.step(game, WORLD.tick, true);
    assert.equal(game.alive, true);
    const first = game.pipes.find((pipe) => pipe.id === 0);
    if (first) {
      assert.ok(first.x < previousX);
      previousX = first.x;
    }
  }
  assert.ok(game.score >= 10);
  assert.ok(Math.abs(game.time - 30) < 0.001);
});
