#!/usr/bin/env node
// Talks to `codex app-server` over stdio JSON-RPC, the same calls Codex's own apps use.
//   node codex-usage.mjs read                             -> [{ name, home, email, planType, rateLimits, rateLimitResetCredits, error }]
//   node codex-usage.mjs consume <creditId> <key> <home>  -> account/rateLimitResetCredit/consume result
// Accounts: every ~/.local/bin/codex-<name> launcher that sets CODEX_HOME, plus ~/.codex as
// "default" when no launcher points at it. Prints one JSON value, or {"error": "..."} with exit code 1.
import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const HOME = homedir();
const BIN = join(HOME, ".local/bin");
const DEFAULT_HOME = join(HOME, ".codex");

// Runs the given requests in one app-server for that CODEX_HOME and resolves with their results.
function appServer(home, requests) {
  return new Promise((resolve, reject) => {
    const child = spawn("codex", ["app-server"], { stdio: ["pipe", "pipe", "ignore"], env: { ...process.env, CODEX_HOME: home } });
    const results = [];
    const done = (err) => {
      clearTimeout(timer);
      child.kill();
      err ? reject(err) : resolve(results);
    };
    const timer = setTimeout(() => done(new Error("codex app-server timed out")), 25000);
    child.on("error", (e) => done(new Error(`could not start codex: ${e.message}`)));
    child.on("exit", (code) => done(new Error(`codex app-server exited (${code})`)));
    const send = (msg) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
    createInterface({ input: child.stdout }).on("line", (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.id === 0) {
        send({ method: "initialized" });
        requests.forEach((r, i) => send({ id: i + 1, ...r }));
      } else if (msg.id >= 1 && msg.id <= requests.length) {
        if (msg.error) return done(new Error(msg.error.message ?? JSON.stringify(msg.error)));
        results[msg.id - 1] = msg.result ?? {};
        if (results.filter(Boolean).length === requests.length) done();
      }
    });
    send({ id: 0, method: "initialize", params: { clientInfo: { name: "herdr-usage", title: "Herdr usage panel", version: "1.0.0" } } });
  });
}

const expand = (p) => p.replace(/^(\$HOME|\$\{HOME\}|~)(?=\/|$)/, HOME);

async function accounts() {
  const out = [];
  for (const f of (await readdir(BIN).catch(() => [])).filter((f) => /^codex-[a-z0-9][a-z0-9-]*$/.test(f)).sort()) {
    const text = await readFile(join(BIN, f), "utf8").catch(() => "");
    const m = text.slice(0, 4096).match(/CODEX_HOME=["']?([^"'\s]+)["']?/);
    if (m) out.push({ name: f.slice("codex-".length), home: expand(m[1]) });
  }
  if (!out.some((a) => a.home === DEFAULT_HOME)) out.unshift({ name: "default", home: DEFAULT_HOME });
  return out;
}

async function readAccount({ name, home }) {
  const base = { name, home, email: null, planType: null, rateLimits: null, rateLimitResetCredits: null, error: null };
  try {
    const [acct, limits] = await appServer(home, [{ method: "account/read", params: {} }, { method: "account/rateLimits/read" }]);
    delete limits.accountId;
    return { ...base, ...limits, email: acct.account?.email ?? null, planType: acct.account?.planType ?? null };
  } catch (e) {
    return { ...base, error: String(e?.message ?? e) };
  }
}

const [mode, creditId, idempotencyKey, home] = process.argv.slice(2);
try {
  let out;
  if (mode === "read") out = await Promise.all((await accounts()).map(readAccount));
  else if (mode === "consume" && creditId && idempotencyKey) {
    [out] = await appServer(home || DEFAULT_HOME, [{ method: "account/rateLimitResetCredit/consume", params: { idempotencyKey, creditId } }]);
  } else throw new Error("usage: codex-usage.mjs read | consume <creditId> <idempotencyKey> <codexHome>");
  process.stdout.write(JSON.stringify(out) + "\n");
  process.exit(0);
} catch (e) {
  process.stdout.write(JSON.stringify({ error: String(e?.message ?? e) }) + "\n");
  process.exit(1);
}
