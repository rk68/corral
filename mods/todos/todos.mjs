#!/usr/bin/env node
// The Todos panel's list, from a terminal. The orchestrator uses it to report progress:
//   todos.mjs list [--json]
//   todos.mjs add <text> [--dir <folder>]
//   todos.mjs pull [ids...]           take queued items (all without ids) and print them as a task
//   todos.mjs start <id> [agent addresses...]
//   todos.mjs done <id> [one-line result]
//   todos.mjs drop <id> [reason]
//   todos.mjs ask <id> <question> [--option <choice>...]  the orchestrator needs the person; shown under "Needs you"
//   todos.mjs answered <id> [answer]  the question is settled, wherever the person answered it
//   todos.mjs note <id> <text>
//   todos.mjs orchestrator [address]  the agent that gets the queue; none when left out
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DIR, FILE, change, message, parse, serialize } from "./logic.js";

const dir = join(homedir(), DIR);
const file = join(dir, FILE);

function load() {
  try { return parse(readFileSync(file, "utf8")); } catch { return parse(""); }
}

// Write a whole new file and rename it over the old one, so the panel never reads half a file.
function save(state) {
  mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, serialize(state));
  renameSync(tmp, file);
}

const [cmd, ...args] = process.argv.slice(2);
const rest = (from) => args.slice(from).join(" ").trim() || undefined;
const state = load();

try {
  switch (cmd) {
    case "list":
    case undefined: {
      if (args.includes("--json")) { console.log(JSON.stringify(state, null, 2)); break; }
      for (const i of state.items) console.log(`${i.id}  ${i.status.padEnd(7)}  ${i.text}${i.agents?.length ? `  [${i.agents.join(", ")}]` : ""}${i.note ? `  -- ${i.note}` : ""}${i.question ? `  ASKS: ${i.question}` : ""}`);
      if (!state.items.length) console.log("No todos.");
      break;
    }
    case "add": {
      const at = args.indexOf("--dir");
      const dirArg = at >= 0 ? args[at + 1] : null;
      const text = args.filter((_, n) => at < 0 || (n !== at && n !== at + 1)).join(" ");
      const next = change(state, { type: "add", text, dir: dirArg ?? process.cwd() });
      save(next);
      console.log(next.items.at(-1).id);
      break;
    }
    // The orchestrator takes queued items when it has room, instead of waiting for the panel to send them.
    case "pull": {
      const queued = state.items.filter((i) => i.status === "queued" && (!args.length || args.includes(i.id)));
      if (!queued.length) { console.log("Nothing is queued."); break; }
      save(change(state, { type: "sent", ids: queued.map((i) => i.id) }));
      console.log(message(queued, `node ${process.argv[1].replace(homedir(), "~")}`, `You pulled ${queued.length} item(s) from the Todos backlog:`));
      break;
    }
    case "start": save(change(state, { type: "start", id: args[0], agents: args.slice(1) })); break;
    case "done": save(change(state, { type: "done", id: args[0], note: rest(1) })); break;
    case "drop": save(change(state, { type: "drop", id: args[0], note: rest(1) })); break;
    case "ask": {
      // Choices come as repeated --option flags. A literal \n in the text is a line break, since
      // agents often pass the question as one quoted line.
      const options = [];
      const words = [];
      for (let n = 1; n < args.length; n++) {
        if (args[n] === "--option" || args[n] === "-o") options.push(args[++n]);
        else words.push(args[n]);
      }
      const unescape = (x) => x.replace(/\\n/g, "\n").trim();
      save(change(state, { type: "ask", id: args[0], note: unescape(words.join(" ")), options: options.filter(Boolean).map(unescape) }));
      break;
    }
    case "answered":
    case "answer": save(change(state, { type: "answer", id: args[0], note: rest(1) })); break;
    case "orchestrator": save(change(state, { type: "orchestrator", address: args[0] || null })); break;
    case "note": save(change(state, { type: "note", id: args[0], note: rest(1) })); break;
    default:
      console.error("usage: todos.mjs list [--json] | pull [ids...] | add <text> [--dir d] | start <id> [agents...] | done <id> [result] | ask <id> <question> [--option <choice>...] | answered <id> [answer] | drop <id> [reason] | note <id> <text>");
      process.exit(2);
  }
} catch (e) {
  console.error(String(e.message ?? e));
  process.exit(1);
}
