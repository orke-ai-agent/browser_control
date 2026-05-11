# Agent Flow Rules

This project is an LLM-native browser agent. The decision logic must live in prompts,
schemas, model reasoning, and typed runtime contracts. Runtime code may collect
observable facts and execute actions, but it must not secretly decide user intent
with keyword lists, regexp classifiers, or scoring piles.

## Core Principle

The browser runtime is an instrument panel, not the pilot.

- The model decides intent, target, and next action from structured observations.
- The runtime exposes truthful DOM/browser state and performs requested mechanics.
- The runtime validates safety, schema shape, permissions, and existence of targets.
- The runtime must not override model decisions through hidden keyword heuristics.

If a choice requires understanding words such as "chat", "message", "search",
"upload", "post", "send", "composer", or their translations, that choice belongs
in the model layer unless it is a purely mechanical browser/API constraint.

## Browser Session Rule

An open browser window is the live work surface, not a process to wait on until it
exits. Do not repeatedly close, reopen, or restart the browser to check progress.
If code changes need to be applied, restart only the backend/server when needed
and keep the existing browser session intact unless the user explicitly asks for
a browser restart.

## Hard Ban

Do not add new agent decision logic based on:

- regexp classifiers for user intent, page purpose, action family, or element purpose
- keyword lists using `includes`, `startsWith`, `endsWith`, `match`, or `test`
- weighted scoring systems that infer what the user wants from words or CSS class names
- language-specific synonym lists in executor/runtime code
- site-specific semantic guesses in generic runtime modules
- site-specific runtime fallbacks for known products, routes, selectors, shortcuts,
  or workflows in generic browser-agent code
- fallback selectors invented from visible text when the model did not select a target

Forbidden examples:

```js
if (hint.includes("chat") || hint.includes("message") || hint.includes("composer")) {
  score += 24;
}
```

```js
if (haystack.includes("upload") || haystack.includes("attach")) {
  return "upload_trigger";
}
```

```js
const family = /post|send|publish|отправ/.test(nextFocus) ? "click" : "generic";
```

```js
if (hostname.includes("mail.google.com") && goal.includes("compose")) {
  await page.goto("https://mail.google.com/mail/u/0/#compose");
}
```

Site/product-specific routes and shortcuts are allowed only when the model selects
them as an action from task context and observations. They must not be hidden in
runtime code as automatic fallbacks.

## Allowed Low-Level Uses

Regexp/string matching is allowed only for non-agentic mechanics:

- path, id, file-name, and URL sanitization
- MIME or file-extension classification
- line splitting, whitespace normalization, and log formatting
- protocol routing such as `/api/threads/:id`
- JSON extraction from provider responses when no structured-output API is available
- defensive validation of schema fields after the model has already made a choice
- browser security boundaries, traversal prevention, and content-type handling

Allowed examples:

```js
safeFileName.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
```

```js
envFile.split(/\r?\n/)
```

These uses do not decide user intent. They protect transport and storage.

## Required Architecture

### 1. Observation Layer

`page-state` should produce facts, not conclusions.

Good:

```json
{
  "id": "atlas-12",
  "tag": "textarea",
  "role": "textbox",
  "text": "",
  "ariaLabel": "Message",
  "placeholder": "Write something",
  "visibleText": "Write something",
  "bounds": { "x": 20, "y": 700, "width": 640, "height": 44 },
  "isFocused": false,
  "isEditable": true,
  "isVisible": true,
  "ancestorSummary": ["main", "form", "footer"]
}
```

Bad:

```json
{
  "purpose": "chat_input",
  "section": "composer"
}
```

Facts can include raw accessible labels, roles, placeholders, bounds, DOM relation,
focus state, disabled state, and nearby text. Labels like `chat_input`,
`search_input`, `upload_trigger`, `composer`, and `send_button` are model-level
interpretations unless they come from an explicit platform accessibility role.

### 2. Planning Layer

The planner must choose concrete targets by `elementId` whenever an element is
visible in the observation.

Valid:

```json
{
  "type": "insert",
  "elementId": "atlas-12",
  "text": "hello",
  "targetReason": "The element is the only visible editable textbox in the main form."
}
```

Invalid:

```json
{
  "type": "insert",
  "inputHint": "main chat composer",
  "text": "hello"
}
```

`inputHint` is legacy. New code must not depend on it for target resolution.
If the model cannot choose an element id, the correct behavior is to ask a
target-resolution model step with more observation context, not to run local
keyword scoring.

### 3. Executor Layer

The executor must be boring.

- `insert` requires `elementId`.
- `click_element` requires `elementId`.
- `upload_media` requires either `elementId` or a model-selected upload strategy.
- The executor may verify that the element exists, is visible, enabled, and has the
  mechanical capability needed for the action.
- The executor may fail fast with a typed error such as `TARGET_REQUIRED` or
  `TARGET_NOT_EDITABLE`.
- The executor must not scan the DOM and pick a target from keywords.

### 4. Recovery Layer

When a target is missing or ambiguous:

1. Return a structured execution error with the available candidates.
2. Feed that error into the planner/analyzer.
3. Let the model choose a target or choose to observe/read/scroll.
4. Retry with a concrete action.

Do not add another fallback keyword list.

## Structured Output Contract

Planner and analyzer responses must be schema-shaped. Prefer provider structured
outputs or function/tool schemas when available.

Minimum planner action schema:

```json
{
  "type": "object",
  "required": ["comment", "blockGoal", "actions"],
  "properties": {
    "comment": { "type": "string" },
    "blockGoal": { "type": "string" },
    "actions": {
      "type": "array",
      "items": {
        "oneOf": [
          {
            "type": "object",
            "required": ["type", "elementId", "text", "label"],
            "properties": {
              "type": { "const": "insert" },
              "elementId": { "type": "string" },
              "text": { "type": "string" },
              "label": { "type": "string" },
              "targetReason": { "type": "string" }
            }
          },
          {
            "type": "object",
            "required": ["type", "elementId", "label"],
            "properties": {
              "type": { "const": "click_element" },
              "elementId": { "type": "string" },
              "label": { "type": "string" },
              "targetReason": { "type": "string" }
            }
          }
        ]
      }
    }
  }
}
```

Schemas should use enums, required fields, and descriptions. If semantic values
are needed, make the model emit them explicitly and validate them against an enum.
Do not infer them afterward with regexp.

## Migration Plan

### Phase 1: Guardrails

- Add a static check that fails when new agent modules add banned patterns:
  `score*`, `keywordMatch`, intent regexp, `normalizedHint.includes`, or semantic
  `haystack.includes` chains.
- Allowlist only low-level files/functions for sanitization and routing.
- Add review rule: any new regexp in `src/agent/**` must state whether it is
  mechanical or semantic. Semantic regexp is rejected.

### Phase 2: Make Targets Explicit

- Update planner prompt: `insert`, `click_element`, and `upload_media` must use
  `elementId` when candidates are visible.
- Deprecate `inputHint` in prompts and action docs.
- Executor should fail fast if an action lacks a required target.
- Add target-resolution retry prompt that receives candidate elements and returns
  a concrete `elementId` plus reason.

### Phase 3: Remove Runtime Semantic Labels

- Replace `purpose` and `section` inference in `page-state` with raw facts:
  accessibility role, tag, labels, placeholder, bounding box, focus, form/dialog
  ancestry, and visibility.
- Keep only browser-native facts. Anything named like `chat_input`, `search_input`,
  `upload_trigger`, or `composer` should be model output, not observation code.

### Phase 4: Replace Scoring with Model Choice

- Remove `scoreSearchInput`, `scoreGenericInput`, `scoreUploadCandidate`, and
  related `find*Element` fallback pickers.
- Add `resolve_target` model step for ambiguous actions.
- Log model target reasons so failures are explainable and debuggable.

### Phase 5: Evals

Create eval tasks that previously motivated the keyword hacks:

- do not type a chat message into search
- choose main editor over sidebar search
- upload attached media through the visible composer control
- click final publish/send CTA only after required content exists
- recover from ambiguous fields by asking the model target resolver

Every removed heuristic must have an eval before deletion or in the same change.

## Refactor Priority In This Repo

Highest priority:

- `src/agent/executor.js`: remove scoring and hint-based target selection.
- `src/agent/page-state.js`: stop assigning semantic `purpose` and `section`.
- `src/agent/semantic.js`: remove keyword-based action-family inference.
- `src/agent/context-packer.js`: stop boosting candidates with keyword search.

Medium priority:

- `src/agent/service.js`: replace string-overlap memory blocking with structured
  identifiers and model-reviewed conflict checks.
- `src/agent/shortcut-memory.js`: keep shortcut memory, but match by stable
  element identity and model-confirmed target facts, not keyword overlap.

Low-risk allowed technical cleanup:

- `server.js` route checks, file-name sanitization, content-type detection.
- `src/media/store.js` file-kind detection.
- `src/agent/env.js` line parsing.

## Review Checklist

Before merging agent-flow changes, answer:

- Did this add any new keyword list, regexp, or scoring heuristic in agent logic?
- Does the model receive enough raw observation facts to choose the target itself?
- Does every browser action that touches a page element use a concrete `elementId`?
- If target selection fails, does the system re-plan through the model instead of
  guessing locally?
- Are schemas explicit enough that the model cannot omit required action fields?
- Are failures logged with candidate facts and the model's target reason?

If any answer is bad, do not merge. Fix the prompt/schema/observation contract
instead of adding another runtime guess.
