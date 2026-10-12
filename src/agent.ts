// Runs the upgrade agent: Pi (https://pi.dev) in print mode, driven by any OpenRouter model, with Zero
// Data Retention forced on every request by src/zdr.ts.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Catalog } from "./models.ts";
import { HOME, type Registry } from "./registry.ts";

/** Cheap and capable enough for most repos; an alias, so it follows new GLM Flash releases. */
export const DEFAULT_AGENT_MODEL = "~z-ai/glm-flash-latest";

/** The agent's OpenRouter model: env override, then the registry, then the default. Aliases resolve to today's model. */
export function agentModel(r: Registry, catalog: Catalog): string {
  const m = process.env.MODELWATCH_AGENT_MODEL || r.agent_model || DEFAULT_AGENT_MODEL;
  const slug = m.startsWith("~") ? catalog.byId.get(m)?.alias_target?.slug : catalog.byId.has(m) ? m : undefined;
  if (!slug) throw new Error(`agent model ${m} isn't on OpenRouter`);
  return slug;
}

const SECRET = /(TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY)$/i;

/** The environment minus anything that looks like a credential. The agent runs with this, plus its OpenRouter key. */
export function repoEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(base).filter(([k]) => !SECRET.test(k) && !k.startsWith("MODELWATCH_")));
}

export type AgentRun = {
  ok: boolean;
  turns: number;
  durationMs: number;
  costUsd: number | null; // what OpenRouter charged
  final: string; // the agent's last message
  error?: string;
};

/** What OpenRouter charged for these requests, or null if it can't say yet. */
async function chargedCost(ids: string[], apiKey: string): Promise<number | null> {
  const costs = await Promise.all(ids.map(async (id) => {
    for (let attempt = 0; attempt < 5; attempt++) { // the record shows up a few seconds after the request
      const res = await fetch(`https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(id)}`, { headers: { authorization: `Bearer ${apiKey}` } });
      if (res.ok) return (await res.json()).data.total_cost as number;
      await new Promise((r) => setTimeout(r, 3000));
    }
    return null;
  }));
  return costs.every((c) => typeof c === "number") ? costs.reduce((a, b) => a! + b!, 0) : null;
}

/**
 * Signals Pi and every command it started. A process that leaves the group on purpose escapes this; running each
 * repo in its own job (runner/modelwatch.yml) is what keeps one repo's agent away from another's checkout.
 */
function killGroup(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(-pid, signal);
  } catch {} // already gone
}

export async function runAgent(opts: { prompt: string; dir: string; model: string; apiKey: string; timeoutMinutes: number }): Promise<AgentRun> {
  const piDir = mkdtempSync(join(tmpdir(), "mw-pi-"));
  const env = {
    ...repoEnv(process.env),
    OPENROUTER_API_KEY: opts.apiKey,
    PI_CODING_AGENT_DIR: piDir, // no user settings, extensions or sessions
    PI_TELEMETRY: "0",
  };
  const started = Date.now();
  const child = spawn(join(HOME, "node_modules/.bin/pi"), [
    "-p", "--mode", "json", "--no-session", "--no-approve", "--no-extensions", "-e", join(HOME, "src/zdr.ts"),
    "--provider", "openrouter", "--model", opts.model, "--", opts.prompt,
  ], { cwd: opts.dir, env, stdio: ["ignore", "pipe", "pipe"], detached: true }); // its own process group: see killGroup

  const run: AgentRun = { ok: false, turns: 0, durationMs: 0, costUsd: null, final: "" };
  let buf = "", stderr = "", stopReason = "";
  const requests: string[] = [];
  child.stdout.on("data", (d) => {
    buf += d;
    const lines = buf.split("\n");
    buf = lines.pop()!;
    for (const line of lines) {
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      if (e.type !== "message_end" || e.message?.role !== "assistant") continue;
      const m = e.message;
      run.turns++;
      if (m.responseId) requests.push(m.responseId);
      const text = (m.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
      if (text.trim()) run.final = text;
      stopReason = m.stopReason;
      if (m.errorMessage) run.error = m.errorMessage;
    }
  });
  child.stderr.on("data", (d) => (stderr = (stderr + d).slice(-4000)));
  let force: NodeJS.Timeout | undefined;
  const timer = setTimeout(() => {
    run.error = `stopped after ${opts.timeoutMinutes} min`;
    killGroup(child.pid!, "SIGTERM");
    force = setTimeout(() => killGroup(child.pid!, "SIGKILL"), 10_000);
  }, opts.timeoutMinutes * 60_000);
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  clearTimeout(timer);
  clearTimeout(force);
  killGroup(child.pid!, "SIGKILL"); // whatever Pi's commands left running
  rmSync(piDir, { recursive: true, force: true });

  run.durationMs = Date.now() - started;
  run.costUsd = await chargedCost(requests, opts.apiKey);
  if (code !== 0 && !run.error) run.error = `pi exited with ${code}: ${stderr.trim().split("\n").at(-1)}`;
  run.ok = code === 0 && stopReason !== "error" && !run.error;
  return run;
}

/** One line on what the agent spent. */
export function agentStats(model: string, r: AgentRun): string {
  const s = r.durationMs / 1000;
  const parts = [`\`${model}\` via Pi`, `${r.turns} turns`, s < 60 ? `${Math.round(s)}s` : `${Math.round(s / 60)} min`];
  if (r.costUsd !== null) {
    const usd = `$${r.costUsd >= 0.01 || !r.costUsd ? r.costUsd.toFixed(2) : r.costUsd.toPrecision(2)}`; // e.g. $0.21, $0.00036
    parts.push(`${usd} charged by OpenRouter`);
  }
  if (r.error) parts.push(`ended with: ${r.error}`);
  return `Agent: ${parts.join(", ")}`;
}
