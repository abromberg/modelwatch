// GitHub, as the modelwatch App: a short-lived JWT signed with the App's key for App endpoints, and a token
// scoped to one repo for everything else.
import { createSign } from "node:crypto";
import type { Change } from "./git.ts";

export type Repo = { full_name: string; default_branch: string; archived: boolean; installation: number };

/** GitHub REST call. Returns null on 404; `raw` returns a file's text. */
export async function api(token: string, path: string, init: { method?: string; body?: unknown; raw?: boolean } = {}): Promise<any> {
  const res = await fetch(`https://api.github.com/${path}`, {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${token}`,
      accept: init.raw ? "application/vnd.github.raw+json" : "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub ${init.method ?? "GET"} ${path}: ${res.status} ${await res.text()}`);
  return init.raw ? res.text() : res.json();
}

export class App {
  readonly id: string;
  readonly #key: string;
  constructor(id: string, privateKey: string) {
    this.id = id;
    this.#key = privateKey;
  }

  #jwt(): string {
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iat: now - 60, exp: now + 540, iss: this.id })}`;
    return `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(this.#key, "base64url")}`;
  }

  /** The bot account the App's commits and PRs appear as. `token` is any installation token. */
  async identity(token: string): Promise<{ name: string; email: string }> {
    const { slug } = await api(this.#jwt(), "app");
    const bot = await api(token, `users/${encodeURIComponent(`${slug}[bot]`)}`);
    return { name: `${slug}[bot]`, email: `${bot.id}+${slug}[bot]@users.noreply.github.com` };
  }

  /** Every repo the App is installed on. */
  async repos(): Promise<Repo[]> {
    const out: Repo[] = [];
    for (const inst of await this.#all(this.#jwt(), "app/installations", (page) => page)) {
      const { token } = await api(this.#jwt(), `app/installations/${inst.id}/access_tokens`, { method: "POST" });
      console.log(`::add-mask::${token}`);
      const repos = await this.#all(token, "installation/repositories", (page) => page.repositories);
      out.push(...repos.map((r: any) => ({ full_name: r.full_name, default_branch: r.default_branch, archived: r.archived, installation: inst.id })));
    }
    return out;
  }

  /** One repo, if the App is installed on it. */
  async repo(fullName: string): Promise<Repo | null> {
    const inst = await api(this.#jwt(), `repos/${fullName}/installation`);
    if (!inst) return null;
    const token = await this.token({ full_name: fullName, installation: inst.id } as Repo);
    const r = await api(token, `repos/${fullName}`);
    return r && { full_name: r.full_name, default_branch: r.default_branch, archived: r.archived, installation: inst.id };
  }

  /** A token that works on this one repo only, valid for an hour. */
  async token(repo: Repo): Promise<string> {
    const body = { repositories: [repo.full_name.split("/")[1]] };
    const { token } = await api(this.#jwt(), `app/installations/${repo.installation}/access_tokens`, { method: "POST", body });
    console.log(`::add-mask::${token}`); // e.g. if a git push fails, its command line is in the error
    return token;
  }

  async #all(token: string, path: string, items: (page: any) => any[]): Promise<any[]> {
    const out = [];
    for (let page = 1; ; page++) {
      const got = items(await api(token, `${path}?per_page=100&page=${page}`));
      out.push(...got);
      if (got.length < 100) return out;
    }
  }
}

/**
 * Commits `changes` on top of `parent` and points `branch` at the commit (force). Through the API rather than
 * `git push`, so the token never reaches a git process, hook or config the agent could have touched. GitHub
 * signs these commits as the App.
 */
export async function commitFiles(token: string, repo: string, o: { branch: string; parent: string; message: string; changes: Change[] }): Promise<string> {
  const base = await api(token, `repos/${repo}/git/commits/${o.parent}`);
  const tree = [];
  for (const c of o.changes) {
    if (!c.content) {
      tree.push({ path: c.path, mode: c.mode, type: "blob", sha: null });
      continue;
    }
    const blob = await api(token, `repos/${repo}/git/blobs`, { method: "POST", body: { content: c.content.toString("base64"), encoding: "base64" } });
    tree.push({ path: c.path, mode: c.mode, type: "blob", sha: blob.sha });
  }
  const t = await api(token, `repos/${repo}/git/trees`, { method: "POST", body: { base_tree: base.tree.sha, tree } });
  const commit = await api(token, `repos/${repo}/git/commits`, { method: "POST", body: { message: o.message, tree: t.sha, parents: [o.parent] } });
  const ref = `heads/${o.branch}`;
  if (await api(token, `repos/${repo}/git/ref/${ref}`)) {
    await api(token, `repos/${repo}/git/refs/${ref}`, { method: "PATCH", body: { sha: commit.sha, force: true } });
  } else {
    await api(token, `repos/${repo}/git/refs`, { method: "POST", body: { ref: `refs/${ref}`, sha: commit.sha } });
  }
  return commit.sha;
}
