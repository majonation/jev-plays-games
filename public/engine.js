// Shared by the browser and server so predictions use the actual game physics.
export const WORLD = Object.freeze({
  width: 1000,
  height: 520,
  floor: 474,
  birdX: 230,
  radius: 14,
  gravity: 650,
  flapVelocity: -235,
  speed: 115,
  maxSpeedMultiplier: 2,
  speedRampSeconds: 50,
  pipeWidth: 70,
  gap: 188,
  spacing: 290,
  decisionSeconds: 0.18,
  tick: 1 / 120,
});

export function flightSpeed(time, speedMultiplier = 1) {
  const progress = Math.min(Math.max(time, 0) / WORLD.speedRampSeconds, 1);
  return (
    WORLD.speed *
    (1 + progress * (WORLD.maxSpeedMultiplier - 1)) *
    speedMultiplier
  );
}

// Integrated distance keeps scenery and pipes aligned throughout the ramp,
// including when speed reaches its cap. Using time * currentSpeed would jump.
export function flightDistance(time) {
  const elapsed = Math.max(time, 0);
  const ramp = Math.min(elapsed, WORLD.speedRampSeconds);
  const acceleration =
    (WORLD.speed * (WORLD.maxSpeedMultiplier - 1)) / WORLD.speedRampSeconds;
  return (
    WORLD.speed * ramp +
    0.5 * acceleration * ramp * ramp +
    (elapsed - ramp) * WORLD.speed * WORLD.maxSpeedMultiplier
  );
}

export function createGame(random = Math.random) {
  const game = {
    bird: { y: 240, vy: 0 },
    pipes: [],
    score: 0,
    time: 0,
    distance: 0,
    speedMultiplier: 1,
    alive: true,
    nextId: 0,
    random,
  };
  for (let i = 0; i < 4; i++) addPipe(game, 630 + i * WORLD.spacing);
  return game;
}

function addPipe(game, x) {
  const previous = game.pipes.at(-1)?.gapY ?? 250;
  const gapY = Math.max(
    140,
    Math.min(335, previous + (game.random() - 0.5) * 160),
  );
  game.pipes.push({ id: game.nextId++, x, gapY, scored: false });
}

export function clearance(game) {
  let distance = Math.min(
    game.bird.y - WORLD.radius,
    WORLD.floor - game.bird.y - WORLD.radius,
  );
  for (const pipe of game.pipes) {
    if (
      pipe.x < WORLD.birdX + WORLD.radius &&
      pipe.x + WORLD.pipeWidth > WORLD.birdX - WORLD.radius
    ) {
      distance = Math.min(
        distance,
        game.bird.y - WORLD.radius - (pipe.gapY - WORLD.gap / 2),
        pipe.gapY + WORLD.gap / 2 - game.bird.y - WORLD.radius,
      );
    }
  }
  return distance;
}

export function advance(game, seconds, action = "coast", spawn = true) {
  if (!game.alive) return;
  if (action === "flap") game.bird.vy = WORLD.flapVelocity;
  for (
    let remaining = seconds;
    remaining > 1e-8 && game.alive;
    remaining -= WORLD.tick
  ) {
    const dt = Math.min(WORLD.tick, remaining);
    game.bird.vy += WORLD.gravity * dt;
    game.bird.y += game.bird.vy * dt;
    const distance =
      (flightDistance(game.time + dt) - flightDistance(game.time)) *
      (game.speedMultiplier ?? 1);
    game.distance = (game.distance ?? 0) + distance;
    game.time += dt;
    for (const pipe of game.pipes) {
      pipe.x -= distance;
      if (
        !pipe.scored &&
        pipe.x + WORLD.pipeWidth < WORLD.birdX - WORLD.radius
      ) {
        pipe.scored = true;
        game.score++;
      }
    }
    if (clearance(game) <= 0) game.alive = false;
  }
  if (spawn) {
    game.pipes = game.pipes.filter((pipe) => pipe.x > -WORLD.pipeWidth);
    while (game.pipes.length < 4)
      addPipe(game, (game.pipes.at(-1)?.x ?? 630) + WORLD.spacing);
  }
}

export function snapshot(game) {
  return {
    bird: { ...game.bird },
    pipes: game.pipes.map(({ x, gapY }) => ({ x, gapY })),
    score: game.score,
    time: game.time,
    speedMultiplier: game.speedMultiplier ?? 1,
  };
}

export function predict(state, action, seconds = WORLD.decisionSeconds) {
  const game = {
    ...state,
    bird: { ...state.bird },
    pipes: state.pipes.map((p) => ({ ...p })),
    alive: true,
  };
  let minClearance = clearance(game);
  advance(game, WORLD.tick, action, false);
  minClearance = Math.min(minClearance, clearance(game));
  for (
    let elapsed = WORLD.tick;
    elapsed < seconds - 1e-8 && game.alive;
    elapsed += WORLD.tick
  ) {
    advance(game, Math.min(WORLD.tick, seconds - elapsed), "coast", false);
    minClearance = Math.min(minClearance, clearance(game));
  }
  return {
    alive: game.alive,
    y: Math.round(game.bird.y),
    velocity: Math.round(game.bird.vy),
    minClearance: Math.round(minClearance),
  };
}

export function observations(state) {
  const next = state.pipes.find(
    (p) => p.x + WORLD.pipeWidth >= WORLD.birdX - WORLD.radius,
  );
  const targetY = next?.gapY ?? WORLD.floor / 2;
  const candidates = Object.fromEntries(
    ["flap", "coast"].map((action) => {
      const step = predict(state, action);
      const lookahead = predict(state, action, 0.45);
      return [
        action,
        {
          nextStep: step,
          lookahead,
          distanceFromGapCenter: Math.abs(lookahead.y - targetY),
        },
      ];
    }),
  );
  return {
    coordinates:
      "Pixels. y increases downward; negative velocity rises. flap resets upward velocity; coast lets gravity act.",
    bird: state.bird,
    upcomingPipes: state.pipes.slice(0, 3),
    targetY,
    relationToGap:
      state.bird.y > targetY + 20
        ? "below gap center"
        : state.bird.y < targetY - 20
          ? "above gap center"
          : "near gap center",
    motion:
      state.bird.vy > 30 ? "falling" : state.bird.vy < -30 ? "rising" : "level",
    elapsedSeconds: state.time,
    world: {
      ...WORLD,
      speed: flightSpeed(state.time, state.speedMultiplier ?? 1),
      baseSpeed: WORLD.speed,
      speedMultiplier: state.speedMultiplier ?? 1,
    },
    candidates,
  };
}

export function guardDecision(state, action) {
  const other = action === "flap" ? "coast" : "flap";
  const selected = hasSafeContinuation(state, action);
  const alternative = selected ? false : hasSafeContinuation(state, other);
  return !selected && alternative
    ? { action: other, overridden: true }
    : { action, overridden: false };
}

// Search possible future inputs, not a single uncorrected ballistic path. This
// detects moves that are safe now but leave the bird trapped at the next pipe.
export function hasSafeContinuation(state, firstAction, depth = 8) {
  const initial = {
    ...state,
    bird: { ...state.bird },
    pipes: state.pipes.map((p) => ({ ...p })),
    alive: true,
  };
  advance(initial, WORLD.decisionSeconds, firstAction, false);
  if (!initial.alive || clearance(initial) < 3) return false;
  function search(current, remaining) {
    if (remaining === 0) return true;
    const pipe = current.pipes.find(
      (p) => p.x + WORLD.pipeWidth > WORLD.birdX - WORLD.radius,
    );
    const preferFlap =
      current.bird.y + current.bird.vy * 0.2 > (pipe?.gapY ?? WORLD.floor / 2);
    for (const action of preferFlap ? ["flap", "coast"] : ["coast", "flap"]) {
      const next = {
        ...current,
        bird: { ...current.bird },
        pipes: current.pipes.map((p) => ({ ...p })),
      };
      advance(next, WORLD.decisionSeconds, action, false);
      if (next.alive && clearance(next) >= 3 && search(next, remaining - 1))
        return true;
    }
    return false;
  }
  return search(initial, depth - 1);
}
