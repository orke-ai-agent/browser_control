# Atlas Router API

Open this file first when building automations.

Do not read `src/atlas/worker.js` during normal canvas work unless you are changing the mechanics. The worker is intentionally the noisy implementation layer. The router below is the stable surface the agent should call.

## Mental model

Canvas code decides:

- what to click
- what to type
- what to paste
- what to drag
- when to open a page

The Atlas worker decides:

- how the cursor moves
- how typing looks human
- how scroll and reading pauses behave
- how shortcuts map on macOS vs Windows
- how request / response / error logs are recorded

## Create a session

```js
const { createAtlasSession } = require("./src/atlas");

const session = await createAtlasSession({
  sessionName: "facebook-outreach",
  headless: false,
});

const canvas = await session.newCanvas();
```

## Router methods

`canvas.open(url, options?)`

- Opens a page.
- Waits for DOM readiness.
- Tries `networkidle`.
- Adds a short human reading phase after load.

`canvas.read(options?)`

- Simulates post-load reading.
- Samples text from headings / links / paragraphs for logs.
- Makes small scroll passes.

`canvas.waitForVisible(target, options?)`

- Waits until a selector or locator is visible.

`canvas.hover(target, options?)`

- Scrolls the element into a comfortable viewport position.
- Moves the cursor on a curved path with jitter.

`canvas.click(target, options?)`

- Humanized hover + dwell + mouse down/up.

`canvas.type(target, text, options?)`

- Focuses the target.
- Clears it by shortcut unless `clear: false`.
- Types with pauses, typo/backspace corrections, and thinking gaps.

`canvas.insert(target, text, options?)`

- Semantic alias for `canvas.type(...)`.
- Preferred when the automation intent is "put this text here" and the caller should not think about typing mechanics.

`canvas.paste(target, text, options?)`

- Focuses the target.
- Tries clipboard paste first.
- Falls back to `insertText` if clipboard access is blocked.

`canvas.press(key, options?)`

- Sends a direct key press such as `Enter`, `Escape`, `Tab`.

`canvas.shortcut(name, options?)`

- Uses OS-aware shortcuts.
- Built-ins: `copy`, `cut`, `paste`, `redo`, `save`, `selectAll`, `undo`.

`canvas.scroll(options?)`

- Humanized wheel scrolling.

`canvas.drag(source, target, options?)`

- Humanized drag and drop with curved cursor travel and dwell.

`canvas.settle(options?)`

- Waits for page load states and a short settle pause.

## Working rule for future automations

When writing a new automation, stay in this layer:

```js
await canvas.open("https://example.com");
await canvas.click('button:has-text("Continue")');
await canvas.insert('input[name="email"]', "name@example.com");
await canvas.press("Enter");
```

Do not recreate your own mouse paths, key delays, or OS shortcut logic in a canvas script. If mechanics need improvement, update the worker once and keep canvas code simple.
