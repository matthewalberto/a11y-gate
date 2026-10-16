// End-to-end tests: run the CLI against the example pages and check exit codes and findings.
// Needs a Chrome or Edge on the machine (or CHROME_PATH) and a build first ("npm test" does both).

import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const cli = join(root, "dist", "cli.js");
const ex = name => join(root, "examples", name);

function run(...args) {
  const r = spawnSync(process.execPath, [cli, ...args, "--json"], { encoding: "utf8" });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* error cases print no JSON */ }
  return { code: r.status, json, stderr: r.stderr };
}

const ruleIds = res => new Set(res.violations.map(v => v.id));
let failures = 0;
function check(name, cond, detail = "") {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${cond ? "" : `  ${detail}`}`);
  if (!cond) failures++;
}

// 1. Single page, flawed: must fail and name the planted problems.
{
  const r = run(ex("flawed-page.html"));
  check("flawed page exits 1", r.code === 1, `got ${r.code} ${r.stderr}`);
  const ids = r.json ? ruleIds(r.json.results[0]) : new Set();
  for (const id of ["html-has-lang", "image-alt", "color-contrast", "label"]) {
    check(`flawed page reports ${id}`, ids.has(id), `found: ${[...ids].join(", ")}`);
  }
}

// 2. Single page, fixed: must pass.
{
  const r = run(ex("fixed-page.html"));
  check("fixed page exits 0", r.code === 0, `got ${r.code} ${JSON.stringify(r.json?.results?.[0]?.violations?.map(v => v.id))}`);
}

// 3. Multi-state, flawed: the dialog's unnamed close button only shows up in the dialog state.
{
  const r = run(ex("flawed-page.html"), "--states", ex("states.json"));
  check("flawed states exit 1", r.code === 1, `got ${r.code} ${r.stderr}`);
  const byName = Object.fromEntries((r.json?.results || []).map(s => [s.state, s]));
  check("all three states ran", ["resting", "step-2", "terms-dialog"].every(n => byName[n] && byName[n].status !== "SKIPPED"),
    JSON.stringify(r.json?.results?.map(s => [s.state, s.status, s.reason])));
  check("resting state does not see the hidden dialog", byName.resting && !ruleIds(byName.resting).has("button-name"));
  check("terms-dialog state reports button-name", byName["terms-dialog"] && ruleIds(byName["terms-dialog"]).has("button-name"));
}

// 4. Multi-state, fixed: every state passes.
{
  const r = run(ex("fixed-page.html"), "--states", ex("states.json"));
  check("fixed states exit 0", r.code === 0, `got ${r.code} ${JSON.stringify(r.json?.results?.map(s => [s.state, s.status, s.reason]))}`);
}

// 5. A state that cannot be reached is SKIPPED and fails the run, even on a clean page.
{
  const r = run(ex("fixed-page.html"), "--states", join(here, "fixtures", "missing-step.json"));
  check("skipped state exits 1", r.code === 1, `got ${r.code}`);
  const skipped = (r.json?.results || []).filter(s => s.status === "SKIPPED").map(s => s.state);
  check("the unreachable state is marked SKIPPED", skipped.length === 1 && skipped[0] === "state-that-cannot-be-reached", JSON.stringify(skipped));
}

// 6. A bad config is a usage error (exit 2), not a pass.
{
  const dir = mkdtempSync(join(tmpdir(), "a11y-gate-"));
  const bad = join(dir, "bad.json");
  writeFileSync(bad, JSON.stringify({ states: [{ name: "x", steps: [{ action: "hover", selector: "a" }] }] }));
  const r = run(ex("fixed-page.html"), "--states", bad);
  check("unknown step action exits 2", r.code === 2, `got ${r.code}`);
  const r2 = run(ex("does-not-exist.html"));
  check("missing file exits 2", r2.code === 2, `got ${r2.code}`);
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
