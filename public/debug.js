// Tokenize JSON without interpreting any provider text as HTML.
export function jsonTokens(value) {
  const formatted = JSON.stringify(value, null, 2);
  const pattern = /"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\b(?:true|false|null)\b/g;
  const tokens = [];
  let position = 0;
  for (const match of formatted.matchAll(pattern)) {
    if (match.index > position)
      tokens.push({ text: formatted.slice(position, match.index), type: "plain" });
    const text = match[0];
    const end = match.index + text.length;
    const type = text.startsWith('"')
      ? /^\s*:/.test(formatted.slice(end)) ? "key" : "string"
      : text === "null" ? "null"
      : text === "true" || text === "false" ? "boolean" : "number";
    tokens.push({ text, type });
    position = end;
  }
  tokens.push({ text: formatted.slice(position), type: "plain" });
  return tokens;
}

export function createJsonDebug(doc) {
  const $ = (id) => doc.getElementById(id);
  const stream = $("json-debug-stream");
  const toggle = $("json-debug-toggle");
  const entries = [];
  let enabled = false;
  let sequence = 0;

  function count() {
    $("json-debug-count").textContent = `${entries.length} ${entries.length === 1 ? "response" : "responses"} · following latest`;
  }

  function empty() {
    const message = doc.createElement("p");
    message.className = "json-debug-empty";
    message.textContent = "Waiting for a reply. Start or resume a Jev flight to see incoming JSON here.";
    stream.replaceChildren(message);
  }

  function append(entry) {
    stream.querySelector(".json-debug-empty")?.remove();
    const item = doc.createElement("article");
    item.className = `json-response${entry.error ? " json-response-error" : ""}`;
    const header = doc.createElement("div");
    header.className = "json-response-header";
    const title = doc.createElement("span");
    title.textContent = `#${entry.id} · ${entry.label}`;
    const timing = doc.createElement("strong");
    timing.textContent = `${entry.roundTripMs} ms`;
    header.append(title, timing);
    const meta = doc.createElement("div");
    meta.className = "json-response-meta";
    const time = doc.createElement("time");
    time.dateTime = entry.receivedAt.toISOString();
    time.textContent = entry.receivedAt.toLocaleTimeString([], { hour12: false });
    meta.append(time);
    if (Number.isFinite(entry.providerMs))
      meta.append(` · provider ${entry.providerMs} ms`);
    const pre = doc.createElement("pre");
    const code = doc.createElement("code");
    for (const token of jsonTokens(entry.data)) {
      const span = doc.createElement("span");
      span.className = `json-${token.type}`;
      span.textContent = token.text;
      code.append(span);
    }
    pre.append(code);
    item.append(header, meta, pre);
    stream.append(item);
    while (stream.children.length > 30) stream.firstChild.remove();
  }

  toggle.addEventListener("click", () => {
    enabled = !enabled;
    toggle.classList.toggle("on", enabled);
    toggle.setAttribute("aria-checked", String(enabled));
    $("json-debug-body").hidden = !enabled;
    const workspace = toggle.closest(".workspace");
    workspace.classList.toggle("debug-open", enabled);
    if (enabled) {
      stream.replaceChildren();
      if (!entries.length) empty();
      else entries.forEach(append);
      stream.scrollTop = stream.scrollHeight;
      // Opening the panel from below the game brings both back into view.
      if (workspace.getBoundingClientRect().top < 0)
        workspace.scrollIntoView({ block: "start" });
    }
  });
  $("json-debug-clear").addEventListener("click", () => {
    entries.length = 0;
    empty();
    count();
  });

  return {
    add(data, metadata) {
      const entry = { ...metadata, data, id: ++sequence, receivedAt: new Date() };
      entries.push(entry);
      if (entries.length > 30) entries.shift();
      count();
      // Keep a bounded history while hidden; only highlight visible replies.
      if (enabled) {
        append(entry);
        stream.scrollTop = stream.scrollHeight;
      }
    },
  };
}
