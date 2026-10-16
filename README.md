# a11y-gate

Check a web page for WCAG 2.0, 2.1 and 2.2 (A and AA) problems before it goes live, and stop the release if any are found.

## Why it matters

- **The problem:** a donation, application or event form that a keyboard or screen-reader user can't finish loses the gift or the applicant, and usually nobody hears about it. In the US, a 2024 Justice Department rule under ADA Title II sets WCAG 2.1 AA as the standard for state and local government web content, including public colleges and universities ([rule](https://www.ada.gov/resources/2024-03-08-web-rule/)). In April 2026 its compliance dates moved to April 2027 and April 2028, depending on size ([summary](https://www.reedsmith.com/articles/doj-extends-digital-accessibility-compliance-dates-under-title-ii-of-the-ada/)).
- **What this saves:** problems are found on every change instead of in a yearly audit, each one with the element and the fix named, and a release can be held until they're fixed.
- **Where it came from:** built to check charities' donation pages before launch.

It runs [axe-core](https://github.com/dequelabs/axe-core) inside the Chrome or Edge you already have installed. It doesn't download its own browser. It prints each problem with the element that caused it and a link that explains the fix. It exits with code 1 if anything fails, so a build or deploy script can refuse to ship.

## Who this is for

- **Web teams at universities, colleges and nonprofits.** Public sector and education sites are often required to meet WCAG 2.1 or 2.2 AA. Donation forms, application forms and event signups are where most people get stuck. This tool lets you check those pages every time they change, not once a year in an audit.
- **Agencies and contractors** who hand pages to a client and want proof each page was checked.
- **Developers** who want an accessibility check in CI that fails the build.

You don't need to write code to use it. If you can open a terminal and run one command, you can check a page.

## What it checks, and what it can't

axe-core finds problems a machine can detect reliably: missing alt text, form fields without labels, low colour contrast, buttons with no name, missing page language, broken ARIA and more.

Automated tools catch only part of WCAG. They can't tell you whether alt text is meaningful, whether the keyboard focus order makes sense, or whether a screen reader user can finish your form. A clean result means "no automated failures", not "accessible". Keep a manual keyboard and screen reader check in your process.

## Install

You need [Node.js](https://nodejs.org) 18 or newer and Chrome or Edge.

```sh
git clone https://github.com/matthewalberto/a11y-gate.git
cd a11y-gate
npm install
npm run build
```

The tool is written in TypeScript (`src/`). `npm run build` compiles it to `dist/cli.js`, which is what you run. After `npm link` you can type `a11y-gate` instead of `node dist/cli.js`.

If your browser is somewhere unusual, tell the tool where it is:

```sh
# macOS or Linux
export CHROME_PATH="/path/to/chrome"
# Windows PowerShell
$env:CHROME_PATH = "C:\path\to\chrome.exe"
```

## Check one page

```sh
node dist/cli.js examples/flawed-page.html
node dist/cli.js https://www.example.org/give
node dist/cli.js page.html --selector "#donation-form"   # check one part of the page
```

Sample output:

```
  FAIL    page: 4 rule(s), 4 element(s)
      [CRITICAL] image-alt: Images must have alternative text
      fix: https://dequeuniversity.com/rules/axe/4.10/image-alt?application=axeAPI
        - img
          Fix any of the following: |   Element does not have an alt attribute
      [CRITICAL] label: Form elements must have labels
      fix: https://dequeuniversity.com/rules/axe/4.10/label?application=axeAPI
        - #email
  ...
  0 passed, 1 failed, 0 skipped (of 1)
```

## Check every state of a form or wizard

A single check only sees the page as it first loads. Multi-step forms, dialogs, error messages and dropdowns are often hidden at that point, so they never get checked. That's where many real problems live.

Multi-state mode fixes this. You write a small JSON file that lists the states you care about and the clicks and typing that reach each one. The tool reloads the page for each state, replays the steps, then runs axe.

```sh
node dist/cli.js examples/flawed-page.html --states examples/states.json
```

`examples/states.json`:

```json
{
  "settleMs": 200,
  "states": [
    { "name": "resting", "note": "Step 1 as the page loads" },
    {
      "name": "terms-dialog",
      "note": "The terms dialog open on top of step 2",
      "steps": [
        { "action": "click", "selector": "#next" },
        { "action": "click", "selector": "#open-terms" },
        { "action": "waitFor", "selector": "#terms" }
      ]
    }
  ]
}
```

Step actions:

| action | fields | what it does |
|---|---|---|
| `click` | `selector` | Scrolls to the element and clicks it |
| `type` | `selector`, `text` | Clears the field and types the text |
| `press` | `key`, optional `selector` | Presses a key, such as `Escape` or `Enter` |
| `select` | `selector`, `value` | Picks an option in a `<select>` |
| `check` | `selector` | Ticks a checkbox or radio if it isn't already |
| `waitFor` | `selector`, optional `timeout` (ms) | Waits until the element is visible |
| `assertVisible` | `selector` | Fails the state if the element isn't visible now |
| `wait` | `ms` | Pauses |
| `goto` | `url` | Opens another URL, relative to the target |

A state can also have a `selector` of its own to check only part of the page.

### A skipped state fails the run

If a step can't run (a button isn't there, a dialog never opens), the state is marked **SKIPPED** and the whole run fails. This is on purpose. A state that wasn't checked must never look like a pass. If the page really doesn't have that feature any more, take the state out of the file.

Use `waitFor` or `assertVisible` as the last step of a state. It proves the click did what you expected before axe runs.

## Options

```
--states <file.json>  run axe at each state in the file
--only <name>         with --states, run one state by name
--selector <css>      check only part of the page
--tags <a,b,...>      axe tags (default: wcag2a,wcag2aa,wcag21a,wcag21aa,wcag22aa)
--shots <dir>         save a screenshot of each state
--json                machine-readable output
--headed              show the browser while it runs
```

Exit codes: `0` no violations, `1` violations or a skipped state, `2` the check couldn't run (no browser, missing file, bad JSON).

## Use it in CI

See [.github/workflows/test.yml](.github/workflows/test.yml). GitHub's Ubuntu runners already have Chrome, so the job only needs to install, build and run:

```yaml
- run: npm ci
- run: npm run build
- run: node dist/cli.js public/donate.html --states a11y-states.json
  env:
    CHROME_PATH: /usr/bin/google-chrome
```

For a site that needs a server, start it in an earlier step and pass `http://localhost:PORT/...` as the target.

## Run the tests

```sh
npm test
```

This builds first, then runs the checks. The tests check that the flawed example fails with the expected problems, the fixed example passes, a hidden dialog is only checked in its own state, and an unreachable state fails the run.

## License

MIT. See [LICENSE](LICENSE).

---

Built by [Matthew Alberto](https://github.com/matthewalberto). Need a version of this for your team or institution? Get in touch on [LinkedIn](https://www.linkedin.com/in/matthewalberto) or at [matthewalberto.com](https://matthewalberto.com).
