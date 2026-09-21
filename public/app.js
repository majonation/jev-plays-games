import {
  WORLD,
  createGame,
  advance,
  snapshot,
  observations,
  flightSpeed,
  difficultyProfile,
} from "./engine.js";
import { RealtimePilot } from "./pilot.js";
import { createJsonDebug } from "./debug.js";

const $ = (id) => document.getElementById(id);
const jsonDebug = createJsonDebug(document);
const canvas = $("game");
const ctx = canvas.getContext("2d");
let game = createGame();
let mode = "jev";
let phase = "ready";
let configured = false;
let guard = true;
let sound = false;
let audio;
let best = {};
try {
  best = JSON.parse(localStorage.getItem("jev-flight-best") || "{}") || {};
} catch {
  /* Storage can be disabled. */
}
let decisionCount = 0;
let eventCount = 0;
let pending = false;
const pilot = new RealtimePilot();
let nextRequestAt = 0;
let physicsAccumulator = 0;
let epoch = 0;
let abortController;
let lastFrame = performance.now();
let toastTimer;
let trail = [];
let lastInput = null;
let lastOutput = null;
let totalCost = 0;

function toast(message) {
  $("toast").textContent = message;
  $("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("toast").hidden = true), 6000);
}

function beep(frequency = 500, duration = 0.07) {
  if (!sound) return;
  try {
    audio ??= new AudioContext();
    audio.resume();
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(frequency, audio.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(
      frequency * 1.4,
      audio.currentTime + duration,
    );
    gain.gain.setValueAtTime(0.045, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + duration);
    oscillator.connect(gain).connect(audio.destination);
    oscillator.start();
    oscillator.stop(audio.currentTime + duration);
  } catch {
    /* Audio is optional. */
  }
}

async function connection() {
  try {
    const response = await fetch("/api/config");
    if (!response.ok) throw new Error();
    const data = await response.json();
    configured = data.configured;
    $("model-name").textContent = data.model;
    $("connection-title").textContent = configured
      ? "Your pilot is ready to connect."
      : "One key away from takeoff.";
    $("connection-copy").textContent = configured
      ? "API key loaded. Start a flight to make the first Jev decision."
      : "Add your OpenRouter key to .env and restart. Or take the controls yourself.";
    $("live-badge").innerHTML = configured
      ? "<i></i> KEY LOADED"
      : "<i></i> STANDBY";
    $("live-badge").classList.toggle("connected", configured);
  } catch {
    configured = false;
    $("connection-title").textContent = "The flight server is offline.";
    $("connection-copy").textContent =
      "Start the server, then reconnect to your pilot.";
  }
}

function overlay(
  title,
  copy,
  button,
  footnote = "Every move starts with a decision.",
) {
  $("overlay").hidden = false;
  $("overlay-title").textContent = title;
  $("overlay-copy").textContent = copy;
  $("start-button").textContent = button;
  $("overlay-footnote").textContent = footnote;
}

function updateStatus(message) {
  setText("flight-status", message);
  $("pause-button").disabled = phase !== "running";
  $("status-light").classList.toggle("active", phase === "running");
  const text =
    phase === "running"
      ? "FLIGHT IN PROGRESS"
      : phase === "paused"
        ? "FLIGHT PAUSED"
        : phase === "over"
          ? "FLIGHT COMPLETE"
          : "READY FOR TAKEOFF";
  setHTML("arena-status", `<i></i> ${text}`);
}

function setText(id, value) {
  const element = $(id);
  if (element.textContent !== String(value)) element.textContent = value;
}

function setHTML(id, value) {
  const element = $(id);
  if (element.innerHTML !== value) element.innerHTML = value;
}

function cancelDecision() {
  epoch++;
  abortController?.abort();
  abortController = null;
  pending = false;
  pilot.reset();
  physicsAccumulator = 0;
  nextRequestAt = 0;
}

function reset() {
  cancelDecision();
  game = createGame();
  game.speedMultiplier = Number($("speed-boost").value);
  phase = "ready";
  decisionCount = 0;
  eventCount = 0;
  totalCost = 0;
  trail = [];
  lastInput = null;
  lastOutput = null;
  $("decision-count").textContent = "—";
  $("latency").innerHTML = "—<small> ms</small>";
  $("latest-action").textContent = "Ready when you are";
  $("decision-icon").textContent = "↗";
  $("confidence").textContent = "—";
  $("flap-prob").textContent = "—";
  $("coast-prob").textContent = "—";
  $("probability-fill").style.width = "50%";
  $("flight-log").innerHTML =
    '<li class="empty-log"><span class="empty-orbit">◎</span><p>A story in small decisions.</p><span>Your flight log will appear here.</span></li>';
  $("log-count").textContent = "0 EVENTS";
  $("input-json").textContent = "Start a Jev flight to see its input.";
  $("output-json").textContent = "Waiting for the first decision.";
  overlay(
    mode === "jev"
      ? "A bird. A brain. A little bravery."
      : "Your wings. Your rules.",
    mode === "jev"
      ? "Jev takes the controls. You get the front-row seat."
      : "Press Space or tap the sky to flap. Find your rhythm.",
    "▶  Start flight",
    mode === "jev"
      ? "Every move starts with a decision."
      : "No API key needed. Just a little timing.",
  );
  $("pilot-label").textContent =
    mode === "jev" ? "JEV AUTOPILOT" : "HUMAN AT THE HELM";
  $("world-speed").textContent =
    mode === "jev"
      ? "CONTINUOUS FLIGHT · ASYNC DECISIONS"
      : "SPACE OR TAP TO FLAP";
  $("best-caption").textContent =
    `${mode === "jev" ? "Jev’s" : "Your"} best flight on this browser.`;
  updateStats();
  updateStatus("Waiting to spread our wings");
}

async function start() {
  if (mode === "jev" && !configured) {
    await connection();
    if (!configured) {
      $("info-dialog").showModal();
      toast("Add your API key, or switch to Your turn for manual play.");
      return;
    }
  }
  if (phase === "over") reset();
  if (phase === "running") return;
  phase = "running";
  document.activeElement?.blur();
  $("overlay").hidden = true;
  lastFrame = performance.now();
  if (mode === "manual" && game.time === 0) game.bird.vy = WORLD.flapVelocity;
  updateStatus(
    mode === "jev"
      ? "Flying live · Jev decisions arrive asynchronously"
      : "Space or tap to keep flying",
  );
}

function pause(message = "Take a breath. The sky can wait.") {
  if (phase !== "running") return;
  cancelDecision();
  phase = "paused";
  overlay(
    "Holding in the sky.",
    message,
    "▶  Resume flight",
    "Your place in the sky is saved.",
  );
  updateStatus("Flight paused");
}

function finish() {
  cancelDecision();
  phase = "over";
  beep(170, 0.22);
  const key = mode === "manual" ? "manual" : guard ? "jev-guarded" : "jev";
  best[key] = Math.max(Number(best[key]) || 0, game.score);
  try {
    localStorage.setItem("jev-flight-best", JSON.stringify(best));
  } catch {
    /* Keep score in memory. */
  }
  overlay(
    "Even good pilots start somewhere.",
    `${game.score} ${game.score === 1 ? "pipe" : "pipes"} cleared in ${game.time.toFixed(1)} seconds of flight. Ready for another run?`,
    "↻  Fly again",
    mode === "jev"
      ? `${decisionCount} Jev decisions${totalCost ? ` · $${totalCost.toFixed(5)} reported API cost` : ""}`
      : "A fresh sky. A fresh start.",
  );
  updateStatus("Flight complete. On to the next one.");
  updateStats();
}

function addLog(action, latency, overridden = false, source = mode) {
  eventCount++;
  $("flight-log").querySelector(".empty-log")?.remove();
  const li = document.createElement("li");
  li.className = `log-entry${overridden ? " guarded" : ""}`;
  const time = document.createElement("time");
  time.textContent = formatTime(game.time);
  const label = document.createElement("span");
  label.className = "log-action";
  label.textContent = `${action === "flap" ? "↑ Flap" : "↓ Coast"}${source === "guard" ? " · guard while awaiting Jev" : overridden ? " · guard corrected Jev" : source === "jev" ? " · Jev decision" : " · your move"}`;
  const meta = document.createElement("span");
  meta.className = "log-latency";
  meta.textContent = latency == null ? "" : `${latency}ms`;
  li.append(time, label, meta);
  $("flight-log").prepend(li);
  while ($("flight-log").children.length > 40)
    $("flight-log").lastChild.remove();
  $("log-count").textContent = `${eventCount} EVENTS`;
}

async function decide() {
  if (pending || phase !== "running" || mode !== "jev") return;
  pending = true;
  const requestStarted = performance.now();
  nextRequestAt = requestStarted + WORLD.decisionSeconds * 1000;
  const requestEpoch = epoch;
  abortController = new AbortController();
  const state = snapshot(game);
  const input = observations(state);
  let responseLogged = false;
  try {
    const response = await fetch("/api/decision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(state),
      signal: abortController.signal,
    });
    const data = await response.json();
    if (requestEpoch !== epoch || phase !== "running") return;
    const roundTripMs = Math.round(performance.now() - requestStarted);
    jsonDebug.add(data.rawResponse ?? data, {
      roundTripMs,
      providerMs: data.latencyMs,
      label: response.ok ? "Jev response" : `API error · HTTP ${response.status}`,
      error: !response.ok,
    });
    responseLogged = true;
    if (!response.ok)
      throw new Error(data.error || "The decision could not be completed.");
    if (!["flap", "coast"].includes(data.action))
      throw new Error("Jev returned an unknown action.");
    const { rawResponse, ...decision } = data;
    pilot.queue({ ...decision, input, requestStarted, roundTripMs });
    decisionCount++;
    if (typeof data.cost === "number") totalCost += data.cost;
    $("decision-count").textContent = decisionCount;
    setHTML("latency", `${roundTripMs}<small> ms</small>`);
    $("latency").title =
      `Total browser round trip; provider: ${data.latencyMs} ms`;
    $("confidence").textContent =
      data.confidence == null ? "—" : `${Math.round(data.confidence * 100)}%`;
    $("confidence").title =
      "Confidence reported by Jev for its original choice";
    $("probability-fill").style.width = data.probabilities
      ? `${data.probabilities.flap * 100}%`
      : "0%";
    $("flap-prob").textContent = data.probabilities
      ? `${Math.round(data.probabilities.flap * 100)}%`
      : "—";
    $("coast-prob").textContent = data.probabilities
      ? `${Math.round(data.probabilities.coast * 100)}%`
      : "—";
    setHTML("live-badge", "<i></i> CONNECTED");
    $("live-badge").classList.add("connected");
    setText("connection-title", "Jev is making the calls.");
    setText(
      "connection-copy",
      "The sky keeps moving during requests. Guard interventions are labeled in the log.",
    );
  } catch (error) {
    if (requestEpoch !== epoch || error.name === "AbortError") return;
    if (!responseLogged)
      jsonDebug.add({ error: error.message }, {
        roundTripMs: Math.round(performance.now() - requestStarted),
        label: "Browser error · no JSON response",
        error: true,
      });
    pause(error.message);
    $("live-badge").innerHTML = "<i></i> INTERRUPTED";
    $("live-badge").classList.remove("connected");
    toast(error.message);
  } finally {
    if (requestEpoch === epoch) {
      pending = false;
      abortController = null;
    }
  }
}

function applyPilotAction(event) {
  const { decision, action, source, guardIntervened, currentState } = event;
  if (decision) {
    const { input, requestStarted, ...output } = decision;
    lastInput = input;
    lastOutput = {
      ...output,
      stateAgeMs: Math.round(performance.now() - requestStarted),
      appliedAction: action,
      guardIntervened,
      applicationState: currentState,
    };
    setText("input-json", JSON.stringify(lastInput, null, 2));
    setText("output-json", JSON.stringify(lastOutput, null, 2));
  }
  setText(
    "latest-action",
    `${action === "flap" ? "A little lift" : "Let gravity lead"}${guardIntervened ? " · guard" : ""}`,
  );
  setText("decision-icon", action === "flap" ? "↑" : "↓");
  addLog(action, decision?.roundTripMs ?? null, guardIntervened, source);
  if (action === "flap") beep();
}

function formatTime(time) {
  return `${String(Math.floor(time / 60)).padStart(2, "0")}:${String(Math.floor(time % 60)).padStart(2, "0")}`;
}
function updateStats() {
  setText(
    "world-speed",
    `${(flightSpeed(game.time, game.speedMultiplier) / WORLD.speed).toFixed(2)}× SPEED · LEVEL ${difficultyProfile(game.time).level}`,
  );
  setText(
    "difficulty-level",
    `Level ${difficultyProfile(game.time).level} · harder in ${Math.max(1, Math.ceil(WORLD.difficultySeconds - (game.time % WORLD.difficultySeconds)))}s`,
  );
  setHTML("score", `${game.score}<span> pipes</span>`);
  setText("game-score", String(game.score).padStart(2, "0"));
  const key = mode === "manual" ? "manual" : guard ? "jev-guarded" : "jev";
  setHTML(
    "best",
    `${Math.max(Number(best[key]) || 0, game.score)}<span> pipes</span>`,
  );
  const [minutes, seconds] = formatTime(game.time).split(":");
  setHTML("flight-time", `${minutes}<span>:${seconds}</span>`);
  setHTML(
    "bird-altitude",
    `${Math.round(WORLD.floor - game.bird.y)} <small>px</small>`,
  );
  const pipe = game.pipes.find(
    (p) => p.x + WORLD.pipeWidth > WORLD.birdX - WORLD.radius,
  );
  setHTML(
    "next-obstacle",
    `${Math.max(0, Math.round((pipe?.x ?? WORLD.width) - WORLD.birdX))} <small>px</small>`,
  );
}

// All landscape and character artwork is drawn locally, without external assets.
function rounded(x, y, w, h, r, fill, stroke) {
  if (h <= 0) return;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1.4;
    ctx.stroke();
  }
}
function cloud(x, y, scale, opacity = 0.65) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(scale, scale);
  ctx.globalAlpha = opacity;
  ctx.fillStyle = "#fffef1";
  ctx.beginPath();
  ctx.moveTo(-48, 12);
  ctx.bezierCurveTo(-63, 10, -57, -10, -41, -10);
  ctx.bezierCurveTo(-40, -32, -13, -43, 2, -22);
  ctx.bezierCurveTo(20, -32, 38, -16, 37, -4);
  ctx.bezierCurveTo(65, -8, 67, 14, 48, 16);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}
function hill(points, color) {
  ctx.beginPath();
  ctx.moveTo(0, WORLD.floor);
  for (const p of points) ctx.bezierCurveTo(...p);
  ctx.lineTo(1000, WORLD.floor);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}
function drawBird(x, y, angle, now) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.fillStyle = "#bbc69c33";
  ctx.beginPath();
  ctx.ellipse(2, 29, 18, 4, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#c17d42";
  ctx.beginPath();
  ctx.moveTo(-16, 1);
  ctx.lineTo(-27, -7);
  ctx.lineTo(-23, 7);
  ctx.lineTo(-12, 9);
  ctx.fill();
  ctx.fillStyle = "#ecc274";
  ctx.strokeStyle = "#c39451";
  ctx.lineWidth = 1.3;
  ctx.beginPath();
  ctx.ellipse(0, 0, 20, 16, -0.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "#f7deb0";
  ctx.beginPath();
  ctx.ellipse(5, 6, 13, 9, -0.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.save();
  ctx.translate(-5, 2);
  ctx.rotate(Math.sin(now * 0.018) * 0.3);
  ctx.fillStyle = "#dda156";
  ctx.strokeStyle = "#c79148";
  ctx.beginPath();
  ctx.ellipse(-5, 2, 12, 7, -0.25, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
  ctx.fillStyle = "#fff9e8";
  ctx.beginPath();
  ctx.ellipse(11, -5, 6, 7, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#484d38";
  ctx.beginPath();
  ctx.arc(13, -5, 2.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#e08649";
  ctx.beginPath();
  ctx.moveTo(17, 1);
  ctx.lineTo(29, 5);
  ctx.lineTo(17, 9);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = "#b87c40";
  ctx.beginPath();
  ctx.moveTo(-5, -14);
  ctx.quadraticCurveTo(-4, -22, 2, -22);
  ctx.stroke();
  ctx.restore();
}
function draw(now) {
  const { width: w, height: h, floor } = WORLD;
  ctx.clearRect(0, 0, w, h);
  const sky = ctx.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, "#edf2df");
  sky.addColorStop(1, "#e9eed3");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "#f7e9b963";
  ctx.beginPath();
  ctx.arc(810, 117, 54, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#f8edc3";
  ctx.beginPath();
  ctx.arc(810, 117, 36, 0, Math.PI * 2);
  ctx.fill();
  const distance = game.distance;
  const drift = (distance * 5) / WORLD.speed;
  cloud(135 - (drift % 1200), 117, 0.72, 0.65);
  cloud(473 - (drift % 1200), 90, 1.12, 0.54);
  cloud(929 - (drift % 1200), 202, 0.74, 0.65);
  cloud(1200 - (drift % 1200), 140, 1, 0.65);
  hill(
    [
      [110, 315, 148, 334, 233, 381],
      [320, 300, 407, 294, 520, 390],
      [631, 297, 659, 321, 784, 389],
      [894, 327, 975, 350, 1000, 380],
    ],
    "#dce5c3",
  );
  hill(
    [
      [112, 392, 137, 376, 231, 420],
      [354, 349, 417, 365, 531, 420],
      [670, 367, 731, 371, 829, 416],
      [932, 387, 975, 403, 1000, 404],
    ],
    "#d0ddb1",
  );
  ctx.fillStyle = "#c1d0a0";
  for (let i = 0; i < 32; i++) {
    const x = i * 38 - (((distance * 10) / WORLD.speed) % 38);
    const y = 446 + Math.sin(i * 2) * 6;
    ctx.beginPath();
    ctx.arc(x, y, 17 + (i % 3) * 6, 0, Math.PI * 2);
    ctx.fill();
  }
  for (const pipe of game.pipes) {
    if (pipe.x > 1050) continue;
    const top = pipe.gapY - (pipe.gap ?? WORLD.gap) / 2,
      bottom = pipe.gapY + (pipe.gap ?? WORLD.gap) / 2;
    const gradient = ctx.createLinearGradient(
      pipe.x,
      0,
      pipe.x + WORLD.pipeWidth,
      0,
    );
    gradient.addColorStop(0, "#9baf7b");
    gradient.addColorStop(0.2, "#b5c792");
    gradient.addColorStop(0.7, "#acc087");
    gradient.addColorStop(1, "#91a66e");
    rounded(pipe.x, -10, WORLD.pipeWidth, top + 10, 3, gradient, "#8fa56e");
    rounded(
      pipe.x - 5,
      top - 20,
      WORLD.pipeWidth + 10,
      20,
      3,
      "#b3c78e",
      "#8fa56e",
    );
    rounded(
      pipe.x,
      bottom,
      WORLD.pipeWidth,
      floor - bottom,
      3,
      gradient,
      "#8fa56e",
    );
    rounded(
      pipe.x - 5,
      bottom,
      WORLD.pipeWidth + 10,
      20,
      3,
      "#b3c78e",
      "#8fa56e",
    );
    ctx.fillStyle = "#d0ddb16b";
    ctx.fillRect(pipe.x + 8, 0, 5, Math.max(0, top - 22));
    ctx.fillRect(pipe.x + 8, bottom + 23, 5, Math.max(0, floor - bottom - 23));
    if (phase === "running") {
      ctx.save();
      ctx.setLineDash([3, 7]);
      ctx.strokeStyle = "#889f6c40";
      ctx.beginPath();
      ctx.moveTo(pipe.x - 15, pipe.gapY);
      ctx.lineTo(pipe.x + 85, pipe.gapY);
      ctx.stroke();
      ctx.restore();
    }
  }
  ctx.fillStyle = "#b6c68e";
  ctx.fillRect(0, floor, w, 4);
  ctx.fillStyle = "#d8dfb6";
  ctx.fillRect(0, floor + 4, w, h - floor);
  ctx.fillStyle = "#c7d2a3";
  for (let i = 0; i < 60; i++) {
    const x = i * 22 - (distance % 22);
    ctx.fillRect(x, floor + 9, 10, 2);
    ctx.fillRect(x + 10, floor + 23, 3, 2);
  }
  if (phase === "running") {
    for (let i = 0; i < trail.length; i++) {
      ctx.globalAlpha = (i / trail.length) * 0.3;
      ctx.fillStyle = "#d6a861";
      ctx.beginPath();
      ctx.arc(
        WORLD.birdX - (trail.length - i) * 4,
        trail[i],
        2.1,
        0,
        Math.PI * 2,
      );
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
  const idle = phase === "ready";
  drawBird(
    idle ? WORLD.birdX - 60 : WORLD.birdX,
    idle ? game.bird.y + Math.sin(now * 0.0025) * 7 : game.bird.y,
    idle ? -0.12 : Math.max(-0.35, Math.min(0.8, game.bird.vy / 600)),
    now,
  );
  ctx.fillStyle = "#78905835";
  for (let i = 0; i < 13; i++)
    ctx.fillRect((i * 83 + 21) % 1000, 414 + ((i * 37) % 52), 2, 2);
}

let statTime = 0;
function frame(now) {
  const dt = Math.min(0.04, (now - lastFrame) / 1000);
  lastFrame = now;
  if (phase === "running") {
    const oldScore = game.score;
    if (mode === "jev" && !pending && !pilot.queued && now >= nextRequestAt)
      decide();
    physicsAccumulator += dt;
    while (physicsAccumulator >= WORLD.tick && game.alive) {
      if (mode === "manual") advance(game, WORLD.tick);
      else pilot.step(game, WORLD.tick, guard, applyPilotAction);
      physicsAccumulator -= WORLD.tick;
    }
    trail.push(game.bird.y);
    if (trail.length > 16) trail.shift();
    if (game.score > oldScore) beep(850, 0.11);
    if (!game.alive) finish();
  }
  if (now - statTime > 150) {
    updateStats();
    statTime = now;
  }
  draw(now);
  requestAnimationFrame(frame);
}

function manualFlap() {
  if (mode === "manual" && phase === "running") {
    game.bird.vy = WORLD.flapVelocity;
    beep();
    addLog("flap", null);
    $("latest-action").textContent = "Your wings, your call";
    $("decision-icon").textContent = "↑";
  }
}
$("start-button").addEventListener("click", start);
$("pause-button").addEventListener("click", () => pause());
$("reset-button").addEventListener("click", reset);
$("speed-boost").addEventListener("input", (event) => {
  game.speedMultiplier = Math.max(1, Math.min(2, Number(event.target.value)));
  const label = `${game.speedMultiplier.toFixed(1)}×`;
  setText("speed-boost-value", label);
  event.target.setAttribute(
    "aria-valuetext",
    `${label} boost on top of automatic acceleration`,
  );
  updateStats();
});
$("sound-button").addEventListener("click", () => {
  sound = !sound;
  $("sound-button").innerHTML = sound
    ? "♪"
    : '♪<span class="sound-off">×</span>';
  $("sound-button").setAttribute("aria-pressed", sound);
  $("sound-button").setAttribute(
    "aria-label",
    sound ? "Disable sound" : "Enable sound",
  );
  beep();
});
$("guard-toggle").addEventListener("click", () => {
  if (phase === "running" || phase === "paused") {
    toast("Reset the flight before changing the collision guard.");
    return;
  }
  guard = !guard;
  $("guard-toggle").classList.toggle("on", guard);
  $("guard-toggle").setAttribute("aria-checked", guard);
  $("guard-caption").textContent = guard
    ? "Interventions are labeled in the decision log."
    : "Pure Jev decisions. No local corrections.";
  updateStats();
});
document.querySelectorAll("[data-mode]").forEach((button) =>
  button.addEventListener("click", () => {
    if (mode === button.dataset.mode) return;
    mode = button.dataset.mode;
    document.querySelectorAll("[data-mode]").forEach((b) => {
      b.classList.toggle("selected", b === button);
      b.setAttribute("aria-pressed", b === button);
    });
    reset();
  }),
);
$("connect-button").addEventListener("click", async () => {
  await connection();
  toast(
    configured
      ? "API key loaded. Ready for a Jev flight."
      : "Add your key to .env, restart the server, then reconnect.",
  );
});
$("how-button").addEventListener("click", () => {
  pause();
  $("info-dialog").showModal();
});
$("data-button").addEventListener("click", () => {
  $("data-dialog").showModal();
});
document
  .querySelectorAll(".close-dialog")
  .forEach((button) =>
    button.addEventListener("click", () => button.closest("dialog").close()),
  );
document.querySelectorAll("dialog").forEach((dialog) =>
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) {
      const rect = dialog.getBoundingClientRect();
      if (
        event.clientX < rect.left ||
        event.clientX > rect.right ||
        event.clientY < rect.top ||
        event.clientY > rect.bottom
      )
        dialog.close();
    }
  }),
);
canvas.addEventListener("pointerdown", manualFlap);
document.addEventListener("keydown", (event) => {
  if (
    document.querySelector("dialog[open]") ||
    ["INPUT", "TEXTAREA", "BUTTON", "A"].includes(
      document.activeElement?.tagName,
    )
  )
    return;
  if (event.code === "Space") {
    event.preventDefault();
    if (event.repeat) return;
    if (phase === "running") manualFlap();
    else start();
  }
  if (event.code === "KeyP") {
    event.preventDefault();
    phase === "running" ? pause() : phase === "paused" ? start() : null;
  }
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden)
    pause("Paused while you were away. Resume whenever you’re ready.");
});
reset();
connection();
requestAnimationFrame(frame);
