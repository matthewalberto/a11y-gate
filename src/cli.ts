#!/usr/bin/env node
// a11y-gate: run axe-core WCAG 2.0 / 2.1 / 2.2 A and AA checks against a local HTML file
// or a URL, using the Chrome or Edge already installed on the machine (puppeteer-core, no
// Chromium download). Exits 1 on any violation so it can gate a release.
//
// Multi-state mode (--states) replays click/type steps from a JSON file and runs axe at each
// state. A state whose steps cannot run is SKIPPED, and a skipped state fails the run.
//
// Exit codes: 0 = no violations and nothing skipped
//             1 = violations found, or a state was skipped
//             2 = could not run (no browser, bad target, bad config, missing deps)

import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import type { Browser, PuppeteerNode } from "puppeteer-core";
import { ConfigError, loadPlan, type Plan } from "./config.js";
import { runStep } from "./steps.js";

const DEFAULT_TAGS = "wcag2a,wcag2aa,wcag21a,wcag21aa,wcag22aa";

const HELP = `
  a11y-gate: axe-core WCAG A and AA checks with your installed Chrome

  Usage:
    a11y-gate <file-or-url> [options]

  Options:
    --states <file.json>  run axe at each state listed in a JSON file (see README)
    --only <name>         with --states, run one state by name
    --selector <css>      single-page mode: check only this part of the page
    --tags <a,b,...>      axe tags (default: ${DEFAULT_TAGS})
    --shots <dir>         save a PNG screenshot per state
    --json                machine-readable output
    --headed              show the browser while it runs
    -h, --help            show this help

  Environment:
    CHROME_PATH           path to a Chrome or Edge executable (otherwise common
                          install paths are tried)

  Exit codes: 0 pass, 1 violations or skipped states, 2 could not run
`;

interface NodeResult { target: string; summary: string }
interface Violation { id: string; impact: string | null; help: string; helpUrl: string; nodes: NodeResult[] }
interface StateResult {
  state: string;
  note: string;
  status: "PASS" | "FAIL" | "SKIPPED";
  reason?: string;
  violations: Violation[];
  passes?: number;
  incomplete: string[];
}

// Minimal shape of what axe.run returns, enough for the report.
interface AxeNode { target: unknown[]; failureSummary?: string }
interface AxeRule { id: string; impact?: string | null; help: string; helpUrl: string; nodes: AxeNode[] }
interface AxeResults { violations: AxeRule[]; passes: AxeRule[]; incomplete: AxeRule[] }

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/microsoft-edge",
].filter((p): p is string => Boolean(p));

function fail(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(2);
}

const args = process.argv.slice(2);
if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
  console.log(HELP);
  process.exit(args.length === 0 ? 2 : 0);
}

function flag(name: string): string | undefined;
function flag(name: string, def: string): string;
function flag(name: string, def?: string): string | undefined {
  const i = args.indexOf(name);
  const next = args[i + 1];
  return i >= 0 && next !== undefined && !next.startsWith("--") ? next : def;
}

const target = args[0] as string;
const statesFile = flag("--states");
const only = flag("--only");
const selector = flag("--selector");
const shotsDir = flag("--shots");
const asJson = args.includes("--json");
const headed = args.includes("--headed");
const tags = flag("--tags", DEFAULT_TAGS).split(",").map(s => s.trim()).filter(Boolean);

// ---------- dependencies ----------
let puppeteer: PuppeteerNode;
let axeSrc: string;
try {
  // Imported dynamically so a missing install gives a clear message and exit code 2.
  puppeteer = (await import("puppeteer-core")).default as unknown as PuppeteerNode;
  const require = createRequire(import.meta.url);
  axeSrc = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
} catch (e) {
  fail(`dependencies missing. Run "npm install" first. (${(e as Error).message})`);
}

const chromePath = CHROME_CANDIDATES.find(p => existsSync(p));
if (!chromePath) fail("no Chrome or Edge found. Set CHROME_PATH to the browser executable.");

// ---------- target ----------
let url: string;
if (/^(https?|file):\/\//i.test(target)) url = target;
else {
  const abs = isAbsolute(target) ? target : resolve(process.cwd(), target);
  if (!existsSync(abs)) fail(`file not found: ${abs}`);
  url = pathToFileURL(abs).href;
}

// ---------- plan ----------
let plan: Plan;
if (statesFile) {
  try {
    plan = loadPlan(statesFile);
  } catch (e) {
    fail(e instanceof ConfigError ? e.message : String(e));
  }
  if (only) {
    plan.states = plan.states.filter(s => s.name === only);
    if (plan.states.length === 0) fail(`no state named "${only}" in ${statesFile}`);
  }
} else {
  plan = {
    states: [{ name: "page", note: selector ? `scope: ${selector}` : "page as loaded", steps: [], selector }],
    settleMs: 0,
  };
}
if (shotsDir) mkdirSync(shotsDir, { recursive: true });

// ---------- run ----------
const browser: Browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: !headed,
  args: ["--no-sandbox", "--disable-gpu", "--allow-file-access-from-files"],
});

const results: StateResult[] = [];
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 1000 });

  for (const state of plan.states) {
    const entry: StateResult = { state: state.name, note: state.note ?? "", status: "SKIPPED", violations: [], incomplete: [] };
    try {
      // Every state starts from a fresh load, so one broken state cannot spoil the next.
      await page.goto(url, { waitUntil: "networkidle0", timeout: 60000 });
      for (const step of state.steps ?? []) await runStep(page, step, url, plan.settleMs);
      if (shotsDir) await page.screenshot({ path: join(shotsDir, `${state.name}.png`) as `${string}.png` });
      await page.evaluate(axeSrc);
      const r = (await page.evaluate(
        async (sel: string | null, runTags: string[]) => {
          const axe = (window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<unknown> } }).axe;
          // axe takes a list of selector lists: [ [ "#main" ] ] checks just #main.
          const context = sel ? { include: [ [sel] ] } : document;
          return axe.run(context, { runOnly: { type: "tag", values: runTags } });
        },
        state.selector ?? null, tags)) as AxeResults;
      entry.status = r.violations.length ? "FAIL" : "PASS";
      entry.violations = r.violations.map(v => ({
        id: v.id, impact: v.impact ?? null, help: v.help, helpUrl: v.helpUrl,
        nodes: v.nodes.map(n => ({
          target: n.target.map(String).join(" "),
          summary: (n.failureSummary ?? "").split("\n").filter(Boolean).slice(0, 2).join(" | "),
        })),
      }));
      entry.passes = r.passes.length;
      entry.incomplete = r.incomplete.map(i => i.id);
    } catch (e) {
      entry.status = "SKIPPED";
      entry.reason = (e as Error).message.split("\n")[0];
    }
    results.push(entry);
  }
  await browser.close();
} catch (e) {
  await browser.close();
  fail((e as Error).message);
}

// ---------- report ----------
const failed = results.filter(r => r.status === "FAIL");
const skipped = results.filter(r => r.status === "SKIPPED");
const passed = results.filter(r => r.status === "PASS");

if (asJson) {
  console.log(JSON.stringify({ url, tags, browser: chromePath, results }, null, 2));
} else {
  console.log(`\n  a11y-gate: ${url}`);
  console.log(`  tags: ${tags.join(", ")}`);
  console.log(`  browser: ${chromePath}\n`);
  for (const r of results) {
    const count = r.violations.reduce((n, v) => n + v.nodes.length, 0);
    const tail = r.status === "FAIL" ? `: ${r.violations.length} rule(s), ${count} element(s)`
      : r.status === "SKIPPED" ? `: ${r.reason}` : "";
    console.log(`  ${r.status.padEnd(7)} ${r.state}${tail}`);
    if (r.note) console.log(`          ${r.note}`);
    for (const v of r.violations) {
      console.log(`      [${(v.impact ?? "n/a").toUpperCase()}] ${v.id}: ${v.help}`);
      console.log(`      fix: ${v.helpUrl}`);
      v.nodes.slice(0, 5).forEach(n => {
        console.log(`        - ${n.target}`);
        if (n.summary) console.log(`          ${n.summary}`);
      });
      if (v.nodes.length > 5) console.log(`        ... and ${v.nodes.length - 5} more element(s)`);
    }
    console.log("");
  }
  console.log(`  ${passed.length} passed, ${failed.length} failed, ${skipped.length} skipped (of ${results.length})`);
  if (skipped.length) {
    console.log("\n  Skipped states are NOT passes. Those parts of the page were not checked:");
    skipped.forEach(s => console.log(`      ${s.state}: ${s.reason}`));
    console.log("  Fix the steps, or remove the state from the file if the page really doesn't have it.");
  }
  const inc = [...new Set(results.flatMap(r => r.incomplete))];
  if (inc.length) console.log(`\n  Needs a human check (axe "incomplete"): ${inc.join(", ")}`);
  console.log("\n  Automated checks find some WCAG problems, not all. Keyboard, focus order and screen");
  console.log("  reader behaviour still need a manual test.\n");
}

process.exit(failed.length || skipped.length ? 1 : 0);
