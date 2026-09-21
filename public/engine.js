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
  startingSpeedMultiplier: 1.2,
  speedRampSeconds: 50,
  difficultySeconds: 5,
  minGap: 84,
  pipeWidth: 70,
  gap: 188,
  spacing: 290,
  decisionSeconds: 0.18,
  tick: 1 / 120,
});

export function flightSpeed(time, speedMultiplier = 1) {
  const progress = Math.max(time, 0) / WORLD.speedRampSeconds;
  return (
    WORLD.speed *
    WORLD.startingSpeedMultiplier *
    (1 + progress) *
    speedMultiplier
  );
}

// Integrate the uncapped acceleration so pipes and scenery never jump.
export function flightDistance(time) {
  const elapsed = Math.max(time, 0);
  return (
    WORLD.speed *
    WORLD.startingSpeedMultiplier *
    (elapsed + (elapsed * elapsed) / (2 * WORLD.speedRampSeconds))
  );
}

export function difficultyProfile(time) {
  const tier = Math.floor(Math.max(0, time) / WORLD.difficultySeconds);
  return {
    level: tier + 1,
    gap: Math.max(WORLD.minGap, WORLD.gap - tier * 14),
    spacing: Math.max(180, WORLD.spacing - tier * 12),
    maxHeightChange: Math.min(160, 80 + tier * 12),
  };
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
  const difficulty = difficultyProfile(game.time);
  const previous = game.pipes.at(-1)?.gapY ?? 250;
  const gapY = Math.max(
    Math.max(100, difficulty.gap / 2 + 35),
    Math.min(
      Math.min(374, WORLD.floor - difficulty.gap / 2 - 35),
      previous + (game.random() - 0.5) * 2 * difficulty.maxHeightChange,
    ),
  );
  game.pipes.push({
    id: game.nextId++,
    x,
    gapY,
    gap: difficulty.gap,
    scored: false,
  });
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
        game.bird.y - WORLD.radius - (pipe.gapY - (pipe.gap ?? WORLD.gap) / 2),
        pipe.gapY + (pipe.gap ?? WORLD.gap) / 2 - game.bird.y - WORLD.radius,
      );
    }
  }
  return distance;
}

export function advance(game, seconds, action = "coast", spawn = true) {
  if (!game.alive) return;
  if (action === "flap") game.bird.vy = WORLD.flapVelocity;
  let remaining = seconds;
  while (remaining > 1e-8 && game.alive) {
    // Limit horizontal travel per step to prevent high-speed tunneling.
    const dt = Math.min(
      WORLD.tick,
      remaining,
      WORLD.radius /
        flightSpeed(game.time + WORLD.tick, game.speedMultiplier ?? 1),
    );
    remaining -= dt;
    game.bird.vy += WORLD.gravity * dt;
    game.bird.y += game.bird.vy * dt;
    const distance =
      (flightDistance(game.time + dt) - flightDistance(game.time)) *
      (game.speedMultiplier ?? 1);
    game.distance = (game.distance ?? 0) + distance;
    game.time += dt;
    const difficulty = difficultyProfile(game.time);
    for (const pipe of game.pipes) {
      pipe.x -= distance;
      // Tighten approaching gates smoothly, but freeze a gate before entry.
      if (pipe.x > WORLD.birdX + WORLD.radius + WORLD.pipeWidth) {
        const currentGap = pipe.gap ?? WORLD.gap;
        pipe.gap = Math.min(
          currentGap,
          Math.max(difficulty.gap, currentGap - 28 * dt),
        );
      }
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
      addPipe(
        game,
        (game.pipes.at(-1)?.x ?? 630) + difficultyProfile(game.time).spacing,
      );
  }
}

export function snapshot(game) {
  return {
    bird: { ...game.bird },
    pipes: game.pipes.map(({ x, gapY, gap }) => ({
      x,
      gapY,
      gap: gap ?? WORLD.gap,
    })),
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
    difficulty: difficultyProfile(state.time),
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
