#!/usr/bin/env node
// Talks to `codex app-server` over stdio JSON-RPC, the same calls Codex's own apps use.
//   node codex-usage.mjs read                         -> account/rateLimits/read result
//   node codex-usage.mjs consume <creditId> <key>     -> account/rateLimitResetCredit/consume result
// Prints one JSON object on stdout, or {"error": "..."} with exit code 1.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const [mode, creditId, idempotencyKey] = process.argv.slice(2);
const request =
  mode === "read"
    ? { method: "account/rateLimits/read" }
    : mode === "consume" && creditId && idempotencyKey
      ? { method: "account/rateLimitResetCredit/consume", params: { idempotencyKey, creditId } }
      : null;

let child;
function finish(out, code) {
  process.stdout.write(JSON.stringify(out) + "\n");
  child?.kill();
  process.exit(code);
}

if (!request) finish({ error: "usage: codex-usage.mjs read | consume <creditId> <idempotencyKey>" }, 1);

child = spawn("codex", ["app-server"], { stdio: ["pipe", "pipe", "ignore"] });
child.on("error", (e) => finish({ error: `could not start codex: ${e.message}` }, 1));
child.on("exit", (code) => finish({ error: `codex app-server exited (${code})` }, 1));
setTimeout(() => finish({ error: "codex app-server timed out" }, 1), 25000);

const send = (msg) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
createInterface({ input: child.stdout }).on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id === 1) {
    send({ method: "initialized" });
    send({ id: 2, ...request });
  } else if (msg.id === 2) {
    if (msg.error) finish({ error: msg.error.message ?? JSON.stringify(msg.error) }, 1);
    const result = msg.result ?? {};
    delete result.accountId;
    finish(result, 0);
  }
});
send({ id: 1, method: "initialize", params: { clientInfo: { name: "herdr-usage", title: "Herdr usage panel", version: "1.0.0" } } });
