// Replay one step of a state. Any problem throws, which marks the state SKIPPED.

import type { ElementHandle, Page } from "puppeteer-core";
import type { Step } from "./config.js";

export const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

async function need(page: Page, selector: string | undefined): Promise<ElementHandle<Element>> {
  if (!selector) throw new Error("step is missing a selector");
  const el = await page.$(selector);
  if (!el) throw new Error(`selector not found: ${selector}`);
  return el;
}

export async function isVisible(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((s: string) => {
    const n = document.querySelector(s);
    if (!n || n.closest("[hidden]")) return false;
    const cs = getComputedStyle(n);
    if (cs.display === "none" || cs.visibility === "hidden") return false;
    const r = n.getBoundingClientRect();
    return r.width > 0 || r.height > 0;
  }, selector);
}

export async function runStep(page: Page, step: Step, baseUrl: string, settleMs: number): Promise<void> {
  const timeout = Number(step.timeout ?? 5000);
  switch (step.action) {
    case "goto":
      if (!step.url) throw new Error("goto step is missing a url");
      await page.goto(new URL(step.url, baseUrl).href, { waitUntil: "networkidle0", timeout: 60000 });
      break;
    case "click": {
      const el = await need(page, step.selector);
      await el.evaluate(n => n.scrollIntoView({ block: "center" }));
      await el.click();
      break;
    }
    case "type": {
      const el = await need(page, step.selector);
      await el.click({ count: 3 });
      await el.type(String(step.text ?? ""), { delay: 10 });
      break;
    }
    case "press":
      if (!step.key) throw new Error("press step is missing a key");
      if (step.selector) await (await need(page, step.selector)).focus();
      await page.keyboard.press(step.key as Parameters<Page["keyboard"]["press"]>[0]);
      break;
    case "select": {
      await need(page, step.selector);
      const picked = await page.select(step.selector as string, String(step.value));
      if (picked.length === 0) throw new Error(`no option with value "${step.value}" in ${step.selector}`);
      break;
    }
    case "check": {
      const el = await need(page, step.selector);
      const checked = await el.evaluate(n => (n as HTMLInputElement).checked);
      if (!checked) await el.click();
      break;
    }
    case "waitFor":
      if (!step.selector) throw new Error("waitFor step is missing a selector");
      try {
        await page.waitForSelector(step.selector, { visible: true, timeout });
      } catch {
        throw new Error(`${step.selector} did not become visible within ${timeout} ms`);
      }
      break;
    case "assertVisible":
      if (!step.selector) throw new Error("assertVisible step is missing a selector");
      if (!(await isVisible(page, step.selector))) throw new Error(`${step.selector} is not visible`);
      break;
    case "wait":
      await sleep(Number(step.ms ?? 300));
      break;
  }
  if (step.action !== "wait" && settleMs) await sleep(settleMs);
}
