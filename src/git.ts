// Local git, for reading checkouts only. Nothing here ever gets a token: once the agent has run, its checkout's
// .git (hooks, config) and anything on PATH may be the agent's, so commits go through the GitHub API instead
// (commitFiles in github.ts).
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";

/** git's absolute path, found before any agent runs: the agent could put a fake `git` earlier on PATH. */
const GIT = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();

/** Runs git in `dir`. core.fsmonitor off: the agent could point it at a script that `git status` would run. */
export function git(dir: string, args: string[], opts: { trim?: boolean; input?: string } = {}): string {
  const out = execFileSync(GIT, ["-c", "core.fsmonitor=false", ...args], { cwd: dir, encoding: "utf8", input: opts.input, maxBuffer: 1 << 28 });
  return opts.trim === false ? out : out.trim();
}

export type Change = {
  path: string;
  kind: "modified" | "added" | "deleted";
  /** null when deleted. A symlink's content is its target. */
  content: Buffer | null;
  mode: "100644" | "100755" | "120000";
};

/** Every file in `dir` that differs from commit `base`, including new files git doesn't ignore. */
export function listChanges(dir: string, base: string): Change[] {
  const tracked = git(dir, ["diff", "--name-status", "--no-renames", "-z", base], { trim: false }).split("\0").filter(Boolean);
  const out: (Change | null)[] = [];
  for (let i = 0; i < tracked.length; i += 2) out.push(read(dir, tracked[i + 1], tracked[i] === "D" ? "deleted" : "modified"));
  for (const path of git(dir, ["ls-files", "--others", "--exclude-standard", "-z"], { trim: false }).split("\0").filter(Boolean)) {
    out.push(read(dir, path, "added"));
  }
  return out.filter((c): c is Change => c !== null);
}

/** null for a submodule or nested repo, which a commit can't carry. */
function read(dir: string, path: string, kind: Change["kind"]): Change | null {
  if (kind === "deleted") return { path, kind, content: null, mode: "100644" };
  const full = join(dir, path);
  const st = lstatSync(full, { throwIfNoEntry: false });
  if (!st) return { path, kind: "deleted", content: null, mode: "100644" };
  if (st.isSymbolicLink()) return { path, kind, content: Buffer.from(readlinkSync(full)), mode: "120000" };
  if (!st.isFile()) return null;
  return { path, kind, content: readFileSync(full), mode: st.mode & 0o111 ? "100755" : "100644" };
}

/** A file's text at commit `base`, or "" if it wasn't there. */
export function showAt(dir: string, base: string, path: string): string {
  try {
    return git(dir, ["show", `${base}:${path}`], { trim: false });
  } catch {
    return "";
  }
}
