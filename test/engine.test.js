import test from "node:test";
import assert from "node:assert/strict";
import {
  WORLD,
  createGame,
  advance,
  snapshot,
  predict,
  guardDecision,
  observations,
  flightSpeed,
  difficultyProfile,
} from "../public/engine.js";

test("later flights encounter pipes sooner and predictions use the increased speed", () => {
  for (const time of [0, 100, 200]) {
    const game = createGame(() => 0.5);
    game.time = time;
    game.bird.y = 100;
    game.pipes[0].x = 280;
    const predicted = predict(snapshot(game), "coast");
    advance(game, WORLD.decisionSeconds);
    assert.equal(game.alive, time === 0);
    assert.equal(predicted.alive, game.alive);
  }
  assert.equal(flightSpeed(25), 207);
  assert.equal(flightSpeed(50), 276);
  assert.equal(flightSpeed(200), 690);
  assert.ok(flightSpeed(400) > flightSpeed(200));
  assert.equal(flightSpeed(createGame().time), 138);
});

test("changing the boost increases future movement without moving existing pipes or scenery", () => {
  const game = createGame(() => 0.5);
  advance(game, 0.1);
  const normal = {
    ...game,
    bird: { ...game.bird },
    pipes: game.pipes.map((p) => ({ ...p })),
  };
  const beforeX = game.pipes[0].x;
  const beforeDistance = game.distance;
  game.speedMultiplier = 2;
  assert.equal(game.pipes[0].x, beforeX);
  assert.equal(game.distance, beforeDistance);
  advance(game, 0.1);
  advance(normal, 0.1);
  assert.ok(
    Math.abs(beforeX - game.pipes[0].x - 2 * (beforeX - normal.pipes[0].x)) <
      0.0001,
  );
  assert.ok(
    Math.abs(
      game.distance - beforeDistance - 2 * (normal.distance - beforeDistance),
    ) < 0.0001,
  );
  assert.equal(snapshot(game).speedMultiplier, 2);
});

test("flap rises, coast falls, and predictions match actual physics", () => {
  for (const action of ["flap", "coast"]) {
    const game = createGame(() => 0.5);
    const expected = predict(snapshot(game), action);
    advance(game, WORLD.decisionSeconds, action);
    assert.equal(expected.y, Math.round(game.bird.y));
    assert.equal(expected.velocity, Math.round(game.bird.vy));
    assert.equal(expected.alive, game.alive);
    assert.ok(action === "flap" ? game.bird.y < 240 : game.bird.y > 240);
  }
});

test("ceiling, ground, and pipes are solid; the gap is passable", () => {
  for (const scenario of [
    { y: 16, vy: -235 },
    { y: 459, vy: 100 },
    { y: 100, vy: 0, pipe: true },
  ]) {
    const game = createGame();
    game.bird = { y: scenario.y, vy: scenario.vy };
    if (scenario.pipe)
      game.pipes[0] = { x: WORLD.birdX, gapY: 250, scored: false };
    advance(game, 0.1);
    assert.equal(game.alive, false);
  }
  const game = createGame();
  game.pipes[0] = { x: WORLD.birdX, gapY: 250, scored: false };
  advance(game, 0.1);
  assert.equal(game.alive, true);
});

test("scoring happens only once after the whole bird clears a pipe", () => {
  const game = createGame(() => 0.5);
  game.pipes[0].x = WORLD.birdX - WORLD.pipeWidth - WORLD.radius + 2;
  advance(game, 0.1);
  assert.equal(game.score, 1);
  advance(game, 0.1);
  assert.equal(game.score, 1);
});

test("guard intervenes near ground but preserves safe choices", () => {
  const game = createGame();
  game.bird = { y: 425, vy: 150 };
  assert.deepEqual(guardDecision(snapshot(game), "coast"), {
    action: "flap",
    overridden: true,
  });
  assert.deepEqual(guardDecision(snapshot(createGame()), "coast"), {
    action: "coast",
    overridden: false,
  });
});

test("observations include both candidate trajectories and do not mutate game state", () => {
  const state = snapshot(createGame());
  const before = structuredClone(state);
  const input = observations(state);
  assert.ok(input.candidates.flap.nextStep.alive);
  assert.ok(input.candidates.coast.nextStep.alive);
  assert.deepEqual(state, before);
});

test("lookahead guard handles noisy choices through the first difficulty increase", () => {
  for (let seed = 1; seed <= 3; seed++) {
    let value = seed;
    const random = () => {
      value = (value * 1664525 + 1013904223) >>> 0;
      return value / 4294967296;
    };
    const game = createGame(random);
    let interventions = 0;
    for (let step = 0; step < 40 && game.alive; step++) {
      const result = guardDecision(
        snapshot(game),
        random() > 0.5 ? "flap" : "coast",
      );
      interventions += Number(result.overridden);
      advance(game, WORLD.decisionSeconds, result.action);
    }
    assert.equal(game.alive, true, `seed ${seed} collided`);
    assert.ok(game.score >= 1);
    assert.ok(interventions > 0);
  }
});

test("gates tighten after five seconds without closing around the bird", () => {
  const game = createGame(() => 0.5);
  game.time = 4.99;
  game.pipes[0].x = WORLD.birdX;
  const nearbyGap = game.pipes[0].gap;
  advance(game, 0.1);
  assert.equal(difficultyProfile(game.time).level, 2);
  assert.equal(game.pipes[0].gap, nearbyGap);
  assert.ok(game.pipes[1].gap < WORLD.gap);
  assert.ok(game.pipes[1].gap > difficultyProfile(game.time).gap);
  const before = snapshot(game);
  const prediction = predict(before, "coast");
  advance(game, WORLD.decisionSeconds);
  assert.equal(prediction.alive, game.alive);
  assert.equal(prediction.y, Math.round(game.bird.y));
});

test("later gates spawn closer together with tighter gaps and greater height changes", () => {
  const generated = [5, 20].map((time) => {
    const game = createGame(() => 1);
    game.time = time;
    game.pipes = [{ id: 0, x: 700, gapY: 237, gap: WORLD.gap, scored: false }];
    advance(game, WORLD.tick);
    return {
      spacing: game.pipes[1].x - game.pipes[0].x,
      gap: game.pipes[1].gap,
      heightChange: Math.abs(game.pipes[1].gapY - game.pipes[0].gapY),
    };
  });
  assert.ok(generated[1].spacing < generated[0].spacing);
  assert.ok(generated[1].gap < generated[0].gap);
  assert.ok(generated[1].heightChange > generated[0].heightChange);
});

test("very high speed still detects a pipe crossing within one physics tick", () => {
  const game = createGame(() => 0.5);
  game.time = 10000;
  game.bird.y = 100;
  game.pipes[0].x = 280;
  advance(game, WORLD.tick);
  assert.equal(game.alive, false);
});
