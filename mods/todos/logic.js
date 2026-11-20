// The todo list's data and rules, without IO. The panel (main.js) and the CLI the orchestrator runs
// (todos.mjs) both change the list only through `change`, so they agree on what each step means.
//
// The list lives in ~/.herdr/todos/todos.json:
//   { orchestrator: "t7" | null, items: [{ id, text, dir, status, added, sent?, started?, ended?, agents, note? }] }
// status: queued (in the panel) -> sent (in the orchestrator's prompt) -> doing -> done | dropped.

export const DIR = ".herdr/todos";
export const FILE = "todos.json";
export const OPEN = ["queued", "sent", "doing"];

export const empty = () => ({ orchestrator: null, items: [] });

export function parse(text) {
  try {
    const s = JSON.parse(text ?? "");
    return { orchestrator: s.orchestrator ?? null, items: Array.isArray(s.items) ? s.items : [] };
  } catch {
    return empty();
  }
}

export const serialize = (state) => `${JSON.stringify(state, null, 2)}\n`;

function newId(items) {
  for (;;) {
    const id = Math.random().toString(36).slice(2, 5);
    if (/^[a-z]/.test(id) && !items.some((i) => i.id === id)) return id;
  }
}

/** Returns the list after one step. Throws on an unknown item, so a typo in the CLI is loud. */
export function change(state, op, now = Date.now()) {
  const items = state.items.map((i) => ({ ...i }));
  const item = (id) => {
    const found = items.find((i) => i.id === id);
    if (!found) throw new Error(`no todo ${id}`);
    return found;
  };
  switch (op.type) {
    case "add": {
      const text = String(op.text ?? "").trim();
      if (!text) throw new Error("a todo needs text");
      items.push({ id: newId(items), text, dir: op.dir ?? null, status: "queued", added: now, agents: [], ...(op.images?.length ? { images: op.images } : {}) });
      break;
    }
    case "sent":
      for (const id of op.ids) { const i = item(id); if (i.status === "queued") Object.assign(i, { status: "sent", sent: now }); }
      break;
    case "start": {
      const i = item(op.id);
      Object.assign(i, { status: "doing", started: i.started ?? now, agents: [...new Set([...(i.agents ?? []), ...(op.agents ?? [])])] });
      break;
    }
    case "note": item(op.id).note = op.note;
    break;
    // The orchestrator needs something from the person. The panel shows it under "Needs you", and
    // the answer goes back to the orchestrator, which passes it on to the agent that needs it.
    case "ask": {
      const i = item(op.id);
      Object.assign(i, { question: op.note, asked: now });
      if (op.options?.length) i.options = op.options; else delete i.options;
      break;
    }
    case "answer": {
      const i = item(op.id);
      if (!i.question) break;
      Object.assign(i, { answers: [...(i.answers ?? []), { q: i.question, a: op.note, at: now, ...(op.images?.length ? { images: op.images } : {}) }] });
      delete i.question; delete i.asked; delete i.options;
      break;
    }
    case "done":
    case "drop": {
      // A finished item has nothing left to ask, so its question leaves "Needs you" with it.
      const i = item(op.id);
      Object.assign(i, { status: op.type === "done" ? "done" : "dropped", ended: now, ...(op.note ? { note: op.note } : {}) });
      delete i.question; delete i.asked; delete i.options;
      break;
    }
    case "reopen": {
      const i = item(op.id);
      Object.assign(i, { status: "queued", added: now, agents: [] });
      delete i.sent; delete i.started; delete i.ended; delete i.note; delete i.question; delete i.asked; delete i.options;
      break;
    }
    case "remove": return { ...state, items: items.filter((i) => i.id !== op.id) };
    case "clear": return { ...state, items: items.filter((i) => OPEN.includes(i.status)) };
    case "orchestrator": return { ...state, orchestrator: op.address ?? null, items };
    default: throw new Error(`unknown step ${op.type}`);
  }
  return { ...state, items };
}

/** Queued items wait for the orchestrator, so it gets one batch between its own tasks, never a
 * message per item. True when it has been idle for `quietMs` and the newest item is `gatherMs` old,
 * so a few items typed in a row go together. */
export function ready({ queued, status, idleSince, now, quietMs, gatherMs }) {
  if (!queued.length || !["idle", "done"].includes(status) || idleSince == null) return false;
  const newest = Math.max(...queued.map((i) => i.added));
  return now - idleSince >= quietMs && now - newest >= gatherMs;
}

// Pasted screenshots travel as file paths: agents open them with their own image reading.
const shots = (images) => (images?.length ? `\n  Screenshots: ${images.join(" ")}` : "");

/** Every screenshot file the items hold, for deleting them with the items. */
export const imagesOf = (items) => items.flatMap((i) => [...(i.images ?? []), ...(i.answers ?? []).flatMap((a) => a.images ?? [])]);

/** The prompt that hands a batch to the orchestrator. `cli` is the command that changes the list. */
export function message(items, cli, intro = `New items from my Todos panel (${items.length}):`) {
  const home = (p) => (p ?? "").replace(/^\/Users\/[^/]+/, "~");
  const lines = items.map((i) => `- [${i.id}] ${i.text}${i.dir ? ` (in ${home(i.dir)})` : ""}${shots(i.images)}`);
  return [
    intro,
    ...lines,
    "",
    "Handle each one as the orchestrator. Do a small one yourself. Delegate a bigger one to an hc agent:",
    "reuse an idle agent that already has the context, or start a new one with",
    "`hc run --bg --name <name> --label todos.item=<id> --cwd <repo> ...`, in a worktree when it edits code.",
    "Start Claude agents with `--permission-mode auto` so they do not stop on prompts. When an agent is",
    "blocked or asks something, decide it yourself if you can, or raise it with `ask`.",
    "Open any screenshots an item lists before you start it, and pass their paths to the agent you delegate to.",
    "Start independent items in parallel. Tell each agent its item id, and have it report to you, not to me.",
    "You are my only contact: when an item needs a decision or information from me, raise it with `ask`",
    "and carry on with the other items. My answer comes back to you as a message starting \"Answer for [id]\".",
    "",
    "The backlog is yours to pull from. When you have room for more without losing focus on your current",
    `work (agents are running, or you are between steps), run \`${cli} pull\` to take what is queued, and`,
    "decide what can run in parallel in subagents. What you do not pull reaches you when you are idle.",
    "",
    `Keep the list current with \`${cli}\`:`,
    "- `list` to see everything, `pull [ids]` to take queued items (all of them without ids)",
    "- `start <id> [agent addresses]` when work on it begins",
    "- `done <id> \"<one-line result>\"` after you have read the result and it is finished",
    "- `ask <id> \"<question>\" [--option \"<choice>\" ...]` when you need a decision or information from me.",
    "  Put the question on the first line, then the context as short `- ` bullets, one per line.",
    "  When the answer is a choice, give 2 to 4 `--option`s, best first; I can still write my own answer.",
    "  An item holds one question at a time. For several decisions, put each on its own numbered line with",
    "  your recommendation, and leave out `--option`; I answer them together in text.",
    "- `answered <id> \"<short answer>\"` once I have answered, in the panel or in your terminal",
    "- `drop <id> \"<reason>\"` when it should not be done",
  ].join("\n");
}

export const answerMessage = (item, answer, images = []) =>
  `Answer for [${item.id}] ${item.text}\nYou asked: ${item.question}\nMy answer: ${answer}${shots(images)}\nPass it on to the agent working on it if needed.`;
