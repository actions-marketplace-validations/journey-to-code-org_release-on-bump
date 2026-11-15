#!/usr/bin/env node
// Publishes every package whose version isn't on npm yet, in the order they depend on each other,
// then tags and releases each one on GitHub. It is the engine of the action (see ../action.yml),
// and can be run by hand too:
//
//   node scripts/release.mjs [--dry-run]
//
// Run from the repository's root (or set RELEASE_ROOT). A version already on npm is skipped and a
// version that already has a GitHub release is skipped, so running it again finishes whatever a
// failed run left undone. In GitHub Actions it publishes with provenance, authenticating as an npm
// trusted publisher (OIDC): no token is stored. By hand it needs `npm login` and `gh auth login`,
// the right branch, and a clean tree. --dry-run publishes and releases nothing.
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const isDir = (path) => existsSync(path) && statSync(path).isDirectory();

/** The `workspaces` patterns of the root package.json, or none. */
export function workspacePatterns(root) {
  const { workspaces } = readJson(join(root, "package.json"));
  if (!workspaces) return [];
  return Array.isArray(workspaces) ? workspaces : (workspaces.packages ?? []);
}

/** `packages/*`-style patterns (and plain paths) to package directories, relative to root. */
export function expand(root, patterns) {
  const found = [];
  const left = new Set();
  for (const raw of patterns) {
    const negated = raw.startsWith("!");
    const pattern = raw.replace(/^!/, "").replace(/^\.\//, "").replace(/\/+$/, "");
    let dirs;
    if (pattern.endsWith("/*") && !pattern.slice(0, -2).includes("*")) {
      const base = pattern.slice(0, -2);
      dirs = isDir(join(root, base))
        ? readdirSync(join(root, base)).filter((e) => existsSync(join(root, base, e, "package.json"))).sort().map((e) => `${base}/${e}`)
        : [];
    } else if (pattern.includes("*")) {
      throw new Error(`release: the workspace pattern "${raw}" isn't supported (only "dir/*" and plain paths); list the packages in the packages input instead`);
    } else {
      dirs = [pattern];
    }
    for (const dir of dirs) negated ? left.add(dir) : found.push(dir);
  }
  return found.filter((dir, i) => !left.has(dir) && found.indexOf(dir) === i);
}

/** The publishable packages: `auto` reads the workspaces, or a list of directories and patterns. */
export function loadPackages(root, spec = "auto") {
  let dirs;
  if (spec === "auto") {
    const patterns = workspacePatterns(root);
    dirs = patterns.length ? expand(root, patterns) : ["."];
  } else {
    dirs = expand(root, spec.split(/[\s,]+/).filter(Boolean));
  }
  const packages = dirs.map((dir) => {
    const file = join(root, dir, "package.json");
    if (!existsSync(file)) throw new Error(`release: no package.json in ${dir}`);
    const json = readJson(file);
    if (!json.name) throw new Error(`release: ${dir}/package.json has no name`);
    return { dir, short: basename(dir === "." ? resolve(root) : dir), json, name: json.name, version: json.version, private: Boolean(json.private) };
  });
  return packages.filter((p) => !p.private && p.version);
}

/** What a package needs from this repository goes first. */
export function order(packages) {
  const names = new Set(packages.map((p) => p.name));
  const ordered = [];
  const visit = (p, trail = []) => {
    if (ordered.includes(p)) return;
    if (trail.includes(p)) throw new Error(`release: a dependency cycle: ${[...trail, p].map((x) => x.name).join(" → ")}`);
    const needs = Object.keys({ ...p.json.dependencies, ...p.json.peerDependencies, ...p.json.optionalDependencies });
    for (const dep of needs) if (names.has(dep)) visit(packages.find((x) => x.name === dep), [...trail, p]);
    ordered.push(p);
  };
  packages.forEach((p) => visit(p));
  return ordered;
}

/** `{dir}`, `{name}` (the package name without its scope) and `{version}`. */
export function tagFor(pkg, format) {
  return format.replaceAll("{dir}", pkg.short).replaceAll("{name}", pkg.name.replace(/^@[^/]+\//, "")).replaceAll("{version}", pkg.version);
}

/** The commit that set a package's version, walking back along main; the checked-out commit if none did. */
export function releaseCommit(root, pkg, git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim()) {
  const file = pkg.dir === "." ? "package.json" : `${pkg.dir}/package.json`;
  const pickaxe = `-S"version": "${pkg.version}"`;
  for (const walk of [["--first-parent"], []]) {
    const sha = git(["log", ...walk, "--format=%H", "-1", pickaxe, "--", file]);
    if (sha) return sha;
  }
  return git(["rev-parse", "HEAD"]);
}

const defaults = (env) => ({
  root: resolve(env.RELEASE_ROOT || "."),
  packages: env.RELEASE_PACKAGES || "auto",
  tagFormat: env.RELEASE_TAG_FORMAT || "",
  access: env.RELEASE_ACCESS || "public",
  provenance: (env.RELEASE_PROVENANCE || "true") === "true",
  branch: env.RELEASE_BRANCH || "main",
  refName: env.RELEASE_REF_NAME || env.GITHUB_REF_NAME || "",
  actions: env.GITHUB_ACTIONS === "true",
  npm: env.RELEASE_NPM || "npm",
  gh: env.RELEASE_GH || "gh",
  dry: env.RELEASE_DRY_RUN === "true",
});

// A shell on Windows only, where npm is a .cmd file that Node won't start directly. The arguments are fixed strings and package names.
const exec = (cmd, args, options = {}) =>
  spawnSync(cmd, args, { encoding: "utf8", shell: process.platform === "win32", stdio: options.quiet ? "pipe" : "inherit", cwd: options.cwd });

export function release(overrides = {}, log = console.log) {
  const cfg = { ...defaults(process.env), ...overrides };
  const { root } = cfg;
  const git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

  // npm trusts the workflow file, not the branch it runs on, so the branch is checked here.
  if (!cfg.dry) {
    const branch = cfg.actions ? cfg.refName : git(["rev-parse", "--abbrev-ref", "HEAD"]);
    if (branch !== cfg.branch) throw new Error(`release: run this on ${cfg.branch} (this is ${branch || "not a branch"}); nothing was published`);
    if (!cfg.actions && git(["status", "--porcelain"])) throw new Error("release: the working tree has uncommitted changes");
  }

  const packages = order(loadPackages(root, cfg.packages));
  if (!packages.length) throw new Error("release: no publishable packages were found (private packages and packages without a version are skipped)");
  const single = packages.length === 1 && packages[0].dir === ".";
  const tagFormat = cfg.tagFormat || (single ? "v{version}" : "{dir}-v{version}");

  const onNpm = (p) => exec(cfg.npm, ["view", `${p.name}@${p.version}`, "version"], { quiet: true, cwd: root }).stdout?.trim() === p.version;

  log(`release:${cfg.dry ? " (dry run)" : ""} ${packages.map((p) => `${p.name}@${p.version}`).join(", ")}`);
  const published = [];
  for (const p of packages) {
    if (onNpm(p)) {
      log(`release: ${p.name}@${p.version} is already on npm, skipping`);
      continue;
    }
    log(`release: publishing ${p.name}@${p.version}`);
    // A prerelease (1.0.0-rc.1) goes out under `next`, so it is never what `npm install` gives.
    const flags = ["--access", cfg.access];
    if (p.version.includes("-")) flags.push("--tag", "next");
    if (cfg.dry) flags.push("--dry-run");
    else if (cfg.actions && cfg.provenance) flags.push("--provenance");
    const result = exec(cfg.npm, ["publish", ...flags], { cwd: join(root, p.dir) });
    if (result.status !== 0) throw new Error(`release: ${p.name} failed to publish; fix it and run this again (packages already on npm are skipped)`);
    published.push(p);
  }

  // What this run published counts as released without asking npm again: it can take minutes to serve a version it has accepted.
  const released = cfg.dry ? [] : packages.filter((p) => published.includes(p) || onNpm(p));
  const tags = [];
  for (const p of released) {
    const tag = tagFor(p, tagFormat);
    if (exec(cfg.gh, ["release", "view", tag], { quiet: true, cwd: root }).status === 0) {
      log(`release: ${tag} is released`);
      continue;
    }
    const sha = releaseCommit(root, p);
    log(`release: releasing ${p.name} ${p.version} as ${tag} from ${sha}`);
    const flags = ["release", "create", tag, "--target", sha, "--title", `${p.name} ${p.version}`, "--generate-notes"];
    if (p.version.includes("-")) flags.push("--prerelease", "--latest=false");
    if (exec(cfg.gh, flags, { cwd: root }).status !== 0) throw new Error(`release: ${p.name}@${p.version} is on npm but its GitHub release failed; run this again to finish it`);
    tags.push(tag);
  }
  if (cfg.dry) log("release: dry run, nothing was published or released");
  return { published, released, tags };
}

const lines = (items) => items.join("\n");

function main() {
  const dry = process.argv.includes("--dry-run");
  const { published, released, tags } = release(dry ? { dry } : {});
  const out = process.env.GITHUB_OUTPUT;
  if (out) {
    // Heredocs, so a value with several lines is one output.
    const write = (key, items) => appendFileSync(out, `${key}<<RELEASE_EOF\n${lines(items)}\nRELEASE_EOF\n`);
    write("published", published.map((p) => `${p.short} ${p.version}`));
    write("released", released.map((p) => `${p.short} ${p.version}`));
    write("tags", tags);
  }
  console.log("release: done.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exit(1);
  }
}
