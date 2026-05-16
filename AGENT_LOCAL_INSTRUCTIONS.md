# Local Agent Instructions

This project is a universal LLM-native browser agent. Treat the language model as
the decision core; runtime code is only an observation, validation, and execution
surface.

## No Site-Specific Runtime Crutches

Never solve a browser-agent failure by hardcoding behavior for a specific site,
product, route, button label, DOM shape, or vendor workflow in generic runtime
code.

Forbidden thinking patterns:

- "For Gmail, open `#compose` when Compose is not visible."
- "For YouTube, click this known selector when upload is requested."
- "For site X, use this hidden URL/action/shortcut as a fallback."
- "If the page text looks like product Y, switch to product-Y logic."

These are the same class of mistake as using regexp or keyword lists instead of
model reasoning. They move agentic decision-making out of the LLM layer and into
opaque procedural shortcuts.

Allowed shape:

- The runtime may expose truthful facts: URL, title, accessibility tree, visible
  candidates, focused element, load state, browser errors, and typed action
  failures.
- The prompt may teach a general recovery policy: if a needed target is missing,
  gather better observations, ask the model to choose an alternate user-level
  route, execute the model-selected action, then verify the resulting state.
- The model may choose an app-native route, keyboard shortcut, or navigation when
  it is reasoning from observations and task context.
- Every alternate route must be verified by observed state, not assumed.

The boundary is strict: app/site knowledge may appear in model reasoning and
prompts as general world knowledge, but must not become generic runtime fallback
logic.
