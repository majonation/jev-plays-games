import { observations } from "../public/engine.js";

export const ENDPOINT = "https://openrouter.ai/api/alpha/decisions";
export const DEFAULT_MODEL = "typesafe/jev-1.13";

export class RequestError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function validateState(input) {
  const finite = (value, min, max) =>
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= min &&
    value <= max;
  if (
    !input ||
    !finite(input.bird?.y, 0, 474) ||
    !finite(input.bird?.vy, -1000, 1000) ||
    !finite(input.time, 0, 31536000) ||
    !finite(input.speedMultiplier ?? 1, 1, 2) ||
    !Array.isArray(input.pipes) ||
    input.pipes.length < 1 ||
    input.pipes.length > 5 ||
    input.pipes.some(
      (p) => !p || !finite(p.x, -100, 3000) || !finite(p.gapY, 100, 374),
    )
  ) {
    throw new RequestError(
      "Invalid game state. Reset the flight and try again.",
    );
  }
  return {
    bird: { y: input.bird.y, vy: input.bird.vy },
    pipes: input.pipes.map((p) => ({ x: p.x, gapY: p.gapY })),
    score: 0,
    time: input.time,
    speedMultiplier: input.speedMultiplier ?? 1,
  };
}

export function buildRequest(state, model = DEFAULT_MODEL) {
  return {
    model,
    state: observations(state),
    questions: {
      movement: {
        type: "choice",
        instructions:
          "Choose the next action to keep the bird alive and fly through the next pipe gap. Predictions are already computed: do not calculate them. First prefer a candidate whose nextStep.alive is true. Avoid a lookahead collision when the other candidate survives. Among safe candidates prefer the smaller distanceFromGapCenter. Flap when falling below the target; coast when rising or above the target. Another decision follows after world.decisionSeconds. Choose one action.",
        criteria: {
          flap: "Apply an upward impulse now. Prefer when the bird is falling toward the bottom or below the gap center and the flap prediction is safe and closer to the target. Avoid flapping repeatedly while already rising.",
          coast:
            "Do not flap; allow gravity to move the bird downward. Prefer when the bird is above the gap center or already rising, or the coast prediction is safe and closer to the target.",
        },
      },
    },
  };
}

export function parseDecision(data) {
  const answer = data?.answers?.movement;
  if (answer?.type !== "choice" || !["flap", "coast"].includes(answer.choice)) {
    throw new RequestError(
      "Jev returned an invalid movement decision. The flight has been paused.",
      502,
    );
  }
  const validProbability = (value) =>
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1;
  const probabilities = answer.probabilities;
  if (
    probabilities != null &&
    (["flap", "coast"].some((key) => !validProbability(probabilities[key])) ||
      probabilities.flap + probabilities.coast <= 0)
  ) {
    throw new RequestError("Jev returned invalid decision probabilities.", 502);
  }
  return {
    action: answer.choice,
    confidence: validProbability(answer.confidence)
      ? answer.confidence
      : (probabilities?.[answer.choice] ?? null),
    probabilities: probabilities
      ? { flap: probabilities.flap, coast: probabilities.coast }
      : null,
  };
}

export async function askJev(
  state,
  {
    apiKey,
    model = DEFAULT_MODEL,
    fetchImpl = fetch,
    signal,
    timeoutMs = 12000,
  } = {},
) {
  if (!apiKey || apiKey === "your_openrouter_api_key_here")
    throw new RequestError(
      "Add OPENROUTER_API_KEY to your .env file, restart the server, then reconnect.",
      503,
    );
  const started = performance.now();
  const timeout = AbortSignal.timeout(timeoutMs);
  let response;
  try {
    response = await fetchImpl(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "X-Title": "Jev Flight Lab",
      },
      body: JSON.stringify(buildRequest(state, model)),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (error) {
    if (signal?.aborted) throw new RequestError("Decision cancelled.", 499);
    throw new RequestError(
      timeout.aborted
        ? "Jev took too long to respond. Resume to try again."
        : "Could not reach OpenRouter. Check your connection and resume.",
      502,
    );
  }
  if (!response.ok) {
    const messages = {
      401: "OpenRouter rejected the API key. Check your .env file and restart.",
      402: "Your OpenRouter account needs credits to continue.",
      403: "OpenRouter denied access to this model.",
      404: "Jev model or Decisions endpoint unavailable. Check JEV_MODEL.",
      429: "OpenRouter rate limit reached. Wait a moment before resuming.",
    };
    throw new RequestError(
      messages[response.status] ??
        `OpenRouter is unavailable (HTTP ${response.status}). Resume to retry.`,
      response.status === 429 ? 429 : 502,
    );
  }
  let data;
  try {
    data = await response.json();
  } catch {
    throw new RequestError("OpenRouter returned an unreadable response.", 502);
  }
  return {
    ...parseDecision(data),
    model: typeof data.model === "string" ? data.model : model,
    latencyMs: Math.round(performance.now() - started),
    cost: Number.isFinite(data.usage?.cost) ? data.usage.cost : null,
  };
}
