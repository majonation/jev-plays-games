import { WORLD, advance, snapshot, guardDecision } from "./engine.js";

// Network responses enter a single-slot mailbox. Physics never waits for it.
// A flap is a one-time impulse, not a command to repeat until the next reply.
export class RealtimePilot {
  constructor() {
    this.reset();
  }

  reset() {
    this.remaining = 0;
    this.queued = null;
  }

  queue(decision) {
    this.queued = decision;
  }

  step(game, seconds, guardEnabled, onAction = () => {}) {
    let remaining = seconds;
    while (remaining > 1e-8 && game.alive) {
      if (this.remaining < 1e-8) {
        const decision = this.queued;
        this.queued = null;
        const proposed = decision?.action ?? "coast";
        const currentState = snapshot(game);
        const applied = guardEnabled
          ? guardDecision(currentState, proposed)
          : { action: proposed, overridden: false };
        if (applied.action === "flap") game.bird.vy = WORLD.flapVelocity;
        if (decision || applied.overridden) {
          onAction({
            decision,
            currentState,
            proposedAction: proposed,
            action: applied.action,
            guardIntervened: applied.overridden,
            source: decision ? "jev" : "guard",
          });
        }
        this.remaining = WORLD.decisionSeconds;
      }
      const step = Math.min(remaining, this.remaining);
      advance(game, step);
      remaining -= step;
      this.remaining -= step;
    }
  }
}
