# Playwright Atlas

Internal humanization layer for LLM-driven browser automation.

This repository is being shaped into a small browser-action package for agent canvases. The goal is simple:

- canvas scripts decide intent
- Atlas decides mechanics

That means the agent should think in actions like "open page", "click this", "type that", "drag here", while the worker handles realistic execution details such as cursor motion, post-load reading, typing cadence, shortcuts, and full request / response / error logging.

## Current direction

We are not building a pile of raw Playwright helpers. We are building a package boundary:

- `src/atlas/API.md`
  Short operational guide for future automation work. Read this first.
- `src/atlas/router.js`
  Thin public action surface for canvases.
- `src/atlas/worker.js`
  Heavy implementation layer for humanized motion and input.
- `src/atlas/logger.js`
  JSONL session logging for actions, errors, requests, and responses.

## Local Agent App

There is now a local browser-agent shell that combines:

- Flutter Web UI in `atlas_ui/`
- Node backend in `server.js` and `src/agent/`
- Atlas browser worker in `src/atlas/`

Start it with:

```bash
npm start
```

The startup flow:

1. builds Flutter Web
2. serves the built UI and local API on `http://127.0.0.1:2112`
3. runs Gemini-backed planning + analysis
4. drives Playwright through the Atlas humanization layer

The backend loop is intentionally agentic:

1. Gemini plans the next short action block
2. Atlas executes it in the browser
3. the backend captures a cleaned DOM snapshot
4. Gemini analyzes the result
5. if DOM is weak, the backend falls back to screenshot analysis
6. the UI receives short progress reports in the thread chat

## Universal Action API

There is now a public local action endpoint for other apps and agents.

Use [`docs/ACTION_API.md`](./docs/ACTION_API.md) when you want to:

- submit a new browser goal through `POST /api/actions`
- continue an existing thread from another app
- attach one or more media files with JSON or `multipart/form-data`
- let the planner work with abstract refs like `first_image` instead of raw file mechanics
- reuse the same action flow from the local UI and external callers

## Design principles

1. Keep the canvas dumb.

Canvas code should call `canvas.click()`, `canvas.type()`, `canvas.drag()`, `canvas.open()`, not `page.mouse.move()` or `page.keyboard.type()` directly.

2. Separate stealth from behavior.

Stealth / fingerprint evasions and human behavior are different concerns. They can be combined, but they should not be tightly coupled in the action API.

3. Move complexity into one worker.

Cursor paths, micro-corrections, reading scrolls, typo injection, clipboard fallbacks, and OS-aware shortcuts should live in one place so all canvases get the same behavior.

4. Log everything important.

Atlas logs:

- browser requests
- browser responses
- failed requests
- page console messages
- page errors
- worker actions
- pauses and humanization decisions

5. Keep the public docs short.

Future automation work should look at `src/atlas/API.md` and not re-open the implementation layer every time.

## Package strategy

The package strategy borrows the strongest ideas from the ecosystem without making the canvas depend on those packages directly.

### 1. Plugin-first architecture from `playwright-ghost`

Takeaways:

- keep a layer above raw Playwright
- make humanization modular
- stay compatible with alternative Playwright runtimes when stealth is needed

Atlas decision:

- the public surface is a router
- the heavy behavior is a swappable worker
- future adapters can be added for `patchright`, `rebrowser-playwright`, or a stealth-enabled launcher without changing canvas code

Reference:

- [Patchright npm](https://www.npmjs.com/package/patchright?activeTab=readme)
- [rebrowser-playwright](https://github.com/rebrowser/rebrowser-playwright)

### 2. Motion quality from cursor-focused humanization packages

Takeaways:

- cursor movement should not be linear
- overshoot and correction matter
- drag and scroll should feel like one continuous input story

Atlas decision:

- curved mouse paths
- micro-jitter
- optional overshoot before correction
- dwell before and after click
- drag routed through the same movement system as hover and click

Reference:

- [ghost-cursor-playwright](https://classic.yarnpkg.com/en/package/ghost-cursor-playwright)

### 3. Do not confuse stealth plugins with behavior engines

`playwright-extra` plus `puppeteer-extra-plugin-stealth` is still useful when the goal is plugin interoperability or evasions, but it is not enough by itself for realistic UX behavior. The humanization layer still needs its own action worker.

Atlas decision:

- treat stealth as an adapter concern
- treat human movement and input as a worker concern
- do not let canvases call stealth packages directly

## Public API shape

```js
const { createAtlasSession } = require("./src/atlas");

const session = await createAtlasSession({
  sessionName: "campaign-run",
  headless: false,
});

const canvas = await session.newCanvas();

await canvas.open("https://example.com");
await canvas.click('button:has-text("Continue")');
await canvas.type('input[name="email"]', "name@example.com");
await canvas.paste('textarea[name="message"]', "Long message body");
await canvas.press("Enter");
```

This is the contract:

- the canvas chooses selectors and intent
- Atlas chooses realism

## Humanization mechanics in the worker

Already implemented in the worker:

- humanized `open()` with post-load reading
- curved cursor movement with jitter
- optional overshoot and correction
- hover before click
- click dwell timing
- humanized typing with pauses and typo corrections
- clipboard-aware paste with fallback
- cross-platform shortcut mapping
- humanized scroll
- humanized drag and drop

Planned next:

- configurable persona profiles such as cautious / fast / distracted
- more realistic idle behaviors near interactive elements
- richer viewport-aware target acquisition
- optional adapter for external cursor engines
- optional stealth launcher adapters

## OS support

The worker already maps common shortcuts correctly:

- macOS uses `Meta`
- Windows and Linux use `Control`

This matters for:

- select all
- copy
- cut
- paste
- undo
- redo
- save

## Logging

Each session writes a JSONL file to `logs/`.

Log categories include:

- Atlas session lifecycle
- worker actions
- pauses and humanization decisions
- request / response telemetry
- request failures
- page errors
- page console output

This is the baseline for replay analysis and later tuning of behavior profiles.

## Rule for future work

When building automations in this repo:

- read `src/atlas/API.md`
- use the router methods
- avoid raw `page.mouse` and `page.keyboard` unless adding new mechanics
- update `src/atlas/worker.js` only when improving the shared behavior engine

## Example

`chatgpt-reply.js` now demonstrates the intended usage pattern: the scenario stays focused on intent, while Atlas owns the execution style.
