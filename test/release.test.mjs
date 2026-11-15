import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { expand, loadPackages, order, release, releaseCommit, tagFor } from "../scripts/release.mjs";

// --- fixtures ---------------------------------------------------------------------------------

const write = (file, text) => {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text);
};
const json = (file, value) => write(file, `${JSON.stringify(value, null, 2)}\n`);
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** A git repo with the given files committed on main. */
function repo(files) {
  const root = mkdtempSync(join(tmpdir(), "release-"));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "T");
  for (const [path, value] of Object.entries(files)) typeof value === "string" ? write(join(root, path), value) : json(join(root, path), value);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "start");
  return root;
}
const commit = (root, message) => {
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", message);
  return git(root, "rev-parse", "HEAD");
};

/** Stand-ins for npm and gh: they read and write a state file, so a test can see what was called. */
function stubs(state = {}) {
  const dir = mkdtempSync(join(tmpdir(), "stubs-"));
  const file = join(dir, "state.json");
  json(file, { onNpm: [], releases: [], calls: [], ...state });
  const script = (body) => `#!/usr/bin/env node
const fs = require("node:fs");
const file = ${JSON.stringify(file)};
const state = JSON.parse(fs.readFileSync(file, "utf8"));
const args = process.argv.slice(2);
const save = () => fs.writeFileSync(file, JSON.stringify(state));
${body}`;
  write(join(dir, "npm"), script(`
if (args[0] === "view") {
  const spec = args[1];
  if (state.onNpm.includes(spec)) console.log(spec.slice(spec.lastIndexOf("@") + 1));
  process.exit(0);
}
if (args[0] === "publish") {
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  state.calls.push({ tool: "npm", args, cwd: process.cwd() });
  if (state.fail === pkg.name) { save(); process.exit(1); }
  if (!state.lag && !args.includes("--dry-run")) state.onNpm.push(pkg.name + "@" + pkg.version);
  save();
  process.exit(0);
}
process.exit(0);
`));
  write(join(dir, "gh"), script(`
const tag = args[2];
if (args[0] === "release" && args[1] === "view") process.exit(state.releases.includes(tag) ? 0 : 1);
if (args[0] === "release" && args[1] === "create") {
  state.calls.push({ tool: "gh", args });
  if (state.ghFails) { save(); process.exit(1); }
  state.releases.push(tag);
  save();
}
process.exit(0);
`));
  chmodSync(join(dir, "npm"), 0o755);
  chmodSync(join(dir, "gh"), 0o755);
  return { npm: join(dir, "npm"), gh: join(dir, "gh"), state: () => JSON.parse(readFileSync(file, "utf8")) };
}

const quiet = () => {};
const run = (root, s, extra = {}) => release({ root, npm: s.npm, gh: s.gh, actions: true, refName: "main", ...extra }, quiet);
const published = (s) => s.state().calls.filter((c) => c.tool === "npm").map((c) => c.cwd.split("/").slice(-1)[0]);

const monorepo = (versions = {}) => ({
  "package.json": { name: "root", private: true, workspaces: ["packages/*"] },
  "packages/core/package.json": { name: "@acme/lib", version: versions.core ?? "1.0.0" },
  "packages/ui/package.json": { name: "@acme/lib-ui", version: versions.ui ?? "1.0.0", dependencies: { "@acme/lib": "^1.0.0" } },
  "packages/docs/package.json": { name: "docs", version: "9.9.9", private: true },
});

// --- packages ---------------------------------------------------------------------------------

test("auto reads the workspaces, skips private packages, and puts what is needed first", () => {
  const root = repo({ ...monorepo(), "packages/aaa/package.json": { name: "@acme/aaa", version: "1.0.0", peerDependencies: { "@acme/lib-ui": "*" } } });
  assert.deepEqual(order(loadPackages(root)).map((p) => p.name), ["@acme/lib", "@acme/lib-ui", "@acme/aaa"]);
});

test("a repository with no workspaces is its own single package", () => {
  const root = repo({ "package.json": { name: "solo", version: "2.0.0" } });
  const [p] = loadPackages(root);
  assert.equal(p.dir, ".");
  assert.equal(p.name, "solo");
});

test("an explicit list can name directories and patterns, and ! leaves one out", () => {
  const root = repo(monorepo());
  assert.deepEqual(expand(root, ["packages/*", "!packages/docs", "!packages/ui"]), ["packages/core"]);
  assert.deepEqual(loadPackages(root, "packages/core, packages/ui").map((p) => p.dir), ["packages/core", "packages/ui"]);
});

test("a pattern it can't expand is an error, not a silent skip", () => {
  const root = repo(monorepo());
  assert.throws(() => expand(root, ["packages/**"]), /isn't supported/);
});

test("a dependency cycle is an error", () => {
  const root = repo({
    "package.json": { name: "root", private: true, workspaces: ["packages/*"] },
    "packages/a/package.json": { name: "a", version: "1.0.0", dependencies: { b: "1" } },
    "packages/b/package.json": { name: "b", version: "1.0.0", dependencies: { a: "1" } },
  });
  assert.throws(() => order(loadPackages(root)), /cycle/);
});

test("tags use the directory, the unscoped name and the version", () => {
  const p = { short: "ui", name: "@acme/lib-ui", version: "1.2.3" };
  assert.equal(tagFor(p, "{dir}-v{version}"), "ui-v1.2.3");
  assert.equal(tagFor(p, "{name}-v{version}"), "lib-ui-v1.2.3");
  assert.equal(tagFor(p, "v{version}"), "v1.2.3");
});

// --- publishing -------------------------------------------------------------------------------

test("publishes what is missing from npm, in order, with provenance, and releases each", () => {
  const root = repo(monorepo());
  const s = stubs();
  const result = run(root, s);
  assert.deepEqual(published(s), ["core", "ui"]);
  const [first] = s.state().calls;
  assert.deepEqual(first.args, ["publish", "--access", "public", "--provenance"]);
  assert.deepEqual(result.tags, ["core-v1.0.0", "ui-v1.0.0"]);
  assert.deepEqual(s.state().releases, ["core-v1.0.0", "ui-v1.0.0"]);
});

test("a package already on npm is skipped, and one already released isn't released twice", () => {
  const root = repo(monorepo());
  const s = stubs({ onNpm: ["@acme/lib@1.0.0"], releases: ["core-v1.0.0"] });
  const result = run(root, s);
  assert.deepEqual(published(s), ["ui"]);
  assert.deepEqual(result.tags, ["ui-v1.0.0"]);
});

test("running it again after everything is done does nothing", () => {
  const root = repo(monorepo());
  const s = stubs();
  run(root, s);
  const before = s.state().calls.length;
  const again = run(root, s);
  assert.equal(s.state().calls.length, before);
  assert.deepEqual(again.tags, []);
});

test("a prerelease goes out under next and is released as a prerelease", () => {
  const root = repo({ "package.json": { name: "solo", version: "1.0.0-rc.1" } });
  const s = stubs();
  run(root, s);
  const [npm, gh] = s.state().calls;
  assert.deepEqual(npm.args, ["publish", "--access", "public", "--tag", "next", "--provenance"]);
  assert.ok(gh.args.includes("--prerelease") && gh.args.includes("--latest=false"));
  assert.equal(gh.args[2], "v1.0.0-rc.1");
});

test("a package npm accepted but doesn't serve yet is still released", () => {
  const root = repo({ "package.json": { name: "solo", version: "1.0.0" } });
  const s = stubs({ lag: true });
  const result = run(root, s);
  assert.deepEqual(result.tags, ["v1.0.0"]);
});

test("a failed publish stops there: nothing later is published or released", () => {
  const root = repo(monorepo());
  const s = stubs({ fail: "@acme/lib" });
  assert.throws(() => run(root, s), /@acme\/lib failed to publish/);
  assert.deepEqual(published(s), ["core"]);
  assert.deepEqual(s.state().releases, []);
});

test("a failed GitHub release is an error that a re-run finishes", () => {
  const root = repo({ "package.json": { name: "solo", version: "1.0.0" } });
  const s = stubs({ ghFails: true });
  assert.throws(() => run(root, s), /GitHub release failed/);
  assert.deepEqual(s.state().onNpm, ["solo@1.0.0"]);
});

test("--access, tag-format and provenance are honoured", () => {
  const root = repo(monorepo());
  const s = stubs();
  const result = run(root, s, { access: "restricted", provenance: false, tagFormat: "{name}-v{version}" });
  assert.deepEqual(s.state().calls[0].args, ["publish", "--access", "restricted"]);
  assert.deepEqual(result.tags, ["lib-v1.0.0", "lib-ui-v1.0.0"]);
});

test("a dry run publishes with --dry-run and releases nothing", () => {
  const root = repo(monorepo());
  const s = stubs();
  const result = run(root, s, { dry: true });
  assert.ok(s.state().calls.every((c) => c.args.includes("--dry-run") && !c.args.includes("--provenance")));
  assert.deepEqual(s.state().releases, []);
  assert.deepEqual(result.tags, []);
});

test("from another branch it refuses before publishing anything", () => {
  const root = repo(monorepo());
  const s = stubs();
  assert.throws(() => run(root, s, { refName: "feature" }), /run this on main/);
  assert.deepEqual(s.state().calls, []);
  assert.doesNotThrow(() => run(root, s, { refName: "feature", dry: true }));
});

test("by hand, a dirty tree is refused", () => {
  const root = repo(monorepo());
  write(join(root, "stray.txt"), "x");
  assert.throws(() => release({ root, npm: stubs().npm, gh: stubs().gh, actions: false }, quiet), /uncommitted/);
});

test("no publishable packages is an error, not a quiet success", () => {
  const root = repo({ "package.json": { name: "root", private: true, version: "1.0.0" } });
  assert.throws(() => run(root, stubs()), /no publishable packages/);
});

// --- the release commit -----------------------------------------------------------------------

test("a release targets the commit that set the version, not the one that triggered the run", () => {
  const root = repo(monorepo());
  json(join(root, "packages/core/package.json"), { name: "@acme/lib", version: "1.1.0" });
  const bump = commit(root, "bump core to 1.1.0");
  write(join(root, "README.md"), "later");
  commit(root, "something else");
  const [core] = loadPackages(root).filter((p) => p.dir === "packages/core");
  assert.equal(releaseCommit(root, core), bump);
});

test("with no commit that set the version, the checked-out one is used", () => {
  const root = repo({ "package.json": { name: "solo", version: "1.0.0" } });
  const head = git(root, "rev-parse", "HEAD");
  assert.equal(releaseCommit(root, { dir: ".", version: "7.7.7" }), head);
});
