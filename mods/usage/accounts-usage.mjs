#!/usr/bin/env node
// Email and plan usage for every Claude Code account: the default ~/.claude login plus the ones
// in ~/.config/agent-accounts/accounts.json (written by ~/.local/bin/agent-account).
// Prints one JSON array: [{ name, isDefault, email, windows, updatedAt, needsLogin, error }].
//
// Two sources, newest wins:
// - the status line snapshot (~/.claude/statusline-usage.sh), fresh after every reply, no request;
// - api.anthropic.com/api/oauth/usage, which also covers idle accounts. It rate-limits (HTTP 429),
//   so each account asks at most every API_EVERY_S and waits API_BACKOFF_S after a 429.
// Tokens stay in this process and go only to api.anthropic.com.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";

const HOME = homedir();
const CACHE = join(HOME, ".cache/agent-usage");
const API_EVERY_S = 5 * 60;
const API_BACKOFF_S = 15 * 60;

const keychain = (service) =>
  new Promise((resolve) =>
    execFile("security", ["find-generic-password", "-s", service, "-a", userInfo().username, "-w"], (err, out) =>
      resolve(err ? null : out.trim()),
    ),
  );

const readJson = (path) => readFile(path, "utf8").then(JSON.parse).catch(() => null);
const toEpoch = (iso) => (iso ? Math.floor(Date.parse(iso) / 1000) : null);
const now = () => Math.floor(Date.now() / 1000);

// The keychain service and the status line file both use the first 8 hex digits of the config
// folder's SHA-256. The default login has no suffix.
const suffixOf = (configDir) => (configDir ? "-" + createHash("sha256").update(configDir).digest("hex").slice(0, 8) : "");

function snapshotWindows(snap) {
  const l = snap?.rate_limits;
  if (!l) return null;
  const win = (label, w) => w && { label, pct: w.used_percentage, resetsAt: w.resets_at ?? null };
  return [win("5-hour", l.five_hour), win("Weekly", l.seven_day)].filter(Boolean);
}

function apiWindows(usage) {
  const win = (label, w) => w && { label, pct: w.utilization, resetsAt: toEpoch(w.resets_at) };
  return [
    win("5-hour", usage.five_hour),
    win("Weekly", usage.seven_day),
    win("Weekly Opus", usage.seven_day_opus),
    win("Weekly Sonnet", usage.seven_day_sonnet),
  ].filter(Boolean);
}

// Returns the cached API result, refreshed when it is due. The cache also records 429 backoff.
async function apiUsage(suffix, token) {
  const path = join(CACHE, `api${suffix || "-default"}.json`);
  const cached = (await readJson(path)) ?? {};
  if (now() < (cached.nextAt ?? 0)) return cached;
  const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
    headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
    signal: AbortSignal.timeout(15000),
  });
  let next;
  if (res.ok) next = { windows: apiWindows(await res.json()), fetchedAt: now(), nextAt: now() + API_EVERY_S };
  else if (res.status === 429) next = { ...cached, nextAt: now() + API_BACKOFF_S };
  else next = { ...cached, status: res.status, nextAt: now() + API_EVERY_S };
  if (res.ok) delete next.status;
  await mkdir(CACHE, { recursive: true });
  await writeFile(path, JSON.stringify(next), { mode: 0o600 });
  return next;
}

async function account({ name, configDir, isDefault }) {
  const profile = await readJson(configDir ? join(configDir, ".claude.json") : join(HOME, ".claude.json"));
  const out = { name, isDefault, email: profile?.oauthAccount?.emailAddress ?? null, windows: [], updatedAt: null, needsLogin: false, error: null };
  const suffix = suffixOf(configDir);
  const creds = JSON.parse((await keychain(`Claude Code-credentials${suffix}`)) ?? "{}").claudeAiOauth;
  if (!creds?.accessToken) return { ...out, needsLogin: true, error: "Not signed in." };

  const snap = await readJson(join(CACHE, `claude${suffix}.json`));
  const expired = creds.expiresAt && creds.expiresAt < Date.now();
  const api = expired ? await readJson(join(CACHE, `api${suffix || "-default"}.json`)) : await apiUsage(suffix, creds.accessToken);
  if (api?.status === 401) return { ...out, needsLogin: true, error: "Login no longer valid." };

  const fromSnap = snapshotWindows(snap);
  if (fromSnap && (snap.captured_at ?? 0) >= (api?.fetchedAt ?? 0)) {
    out.windows = fromSnap;
    out.updatedAt = snap.captured_at;
  } else if (api?.windows) {
    out.windows = api.windows;
    out.updatedAt = api.fetchedAt;
  }
  // A window whose reset time has passed has started again from zero.
  out.windows = out.windows.map((w) => (w.resetsAt && w.resetsAt <= now() ? { ...w, pct: 0, resetsAt: null } : w));
  if (out.windows.length === 0) out.error = expired ? "Login expired. Start a session in this account to renew it." : "No usage data yet.";
  return out;
}

const reg = (await readJson(join(HOME, ".config/agent-accounts/accounts.json"))) ?? {};
const accounts = [{ name: reg.defaultName ?? "default", isDefault: true }, ...(reg.accounts ?? []).map((a) => ({ ...a, isDefault: false }))];
const results = await Promise.all(
  accounts.map((a) =>
    account(a).catch((e) => ({ name: a.name, isDefault: a.isDefault, email: null, windows: [], updatedAt: null, needsLogin: false, error: String(e?.message ?? e) })),
  ),
);
process.stdout.write(JSON.stringify(results) + "\n");
