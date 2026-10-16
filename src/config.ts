// Load and validate a multi-state JSON file.

import { readFileSync } from "node:fs";

export const STEP_ACTIONS = [
  "click", "type", "press", "select", "check", "waitFor", "assertVisible", "wait", "goto",
] as const;

export type StepAction = (typeof STEP_ACTIONS)[number];

export interface Step {
  action: StepAction;
  selector?: string;
  text?: string;
  key?: string;
  value?: string;
  url?: string;
  ms?: number;
  timeout?: number;
}

export interface State {
  name: string;
  note?: string;
  selector?: string;
  steps?: Step[];
}

export interface Plan {
  states: State[];
  settleMs: number;
}

export class ConfigError extends Error {}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/** Validate parsed JSON into a Plan. Throws ConfigError with a readable message. */
export function parsePlan(raw: unknown, source = "states file"): Plan {
  const list = Array.isArray(raw) ? raw : isRecord(raw) ? raw.states : undefined;
  if (!Array.isArray(list) || list.length === 0) {
    throw new ConfigError(`${source}: expected a non-empty "states" array`);
  }
  const names = new Set<string>();
  const states: State[] = list.map((s: unknown, i: number) => {
    if (!isRecord(s) || typeof s.name !== "string" || s.name === "") {
      throw new ConfigError(`${source}: state #${i + 1} has no "name"`);
    }
    if (names.has(s.name)) throw new ConfigError(`${source}: duplicate state name "${s.name}"`);
    names.add(s.name);
    const steps = s.steps ?? [];
    if (!Array.isArray(steps)) {
      throw new ConfigError(`${source}: state "${s.name}" has a "steps" value that is not an array`);
    }
    steps.forEach((st: unknown, j: number) => {
      const action = isRecord(st) ? st.action : undefined;
      if (typeof action !== "string" || !(STEP_ACTIONS as readonly string[]).includes(action)) {
        throw new ConfigError(
          `${source}: state "${s.name}" step ${j + 1} has unknown action "${String(action)}". ` +
          `Allowed: ${STEP_ACTIONS.join(", ")}`);
      }
    });
    return {
      name: s.name,
      note: typeof s.note === "string" ? s.note : undefined,
      selector: typeof s.selector === "string" ? s.selector : undefined,
      steps: steps as Step[],
    };
  });
  const settle = isRecord(raw) && raw.settleMs !== undefined ? Number(raw.settleMs) : 250;
  return { states, settleMs: Number.isFinite(settle) ? settle : 250 };
}

export function loadPlan(file: string): Plan {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new ConfigError(`could not read states file ${file}: ${(e as Error).message}`);
  }
  return parsePlan(raw, file);
}
