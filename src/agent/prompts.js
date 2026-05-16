function formatInteractive(interactive) {
  return interactive
    .slice(0, 32)
    .map((element) =>
      JSON.stringify({
        id: element.id,
        tag: element.tag,
        text: element.text,
        label: element.label,
        placeholder: element.placeholder,
        role: element.role,
        type: element.type,
        purpose: element.purpose,
        section: element.section,
        focused: element.focused,
        disabled: element.disabled,
        visibleName: element.visibleName,
        nearbyText: element.nearbyText,
        descriptor: element.descriptor,
        href: element.href,
        bounds: element.bounds,
        inViewport: element.inViewport,
      }),
    )
    .join("\n");
}

function formatPrimaryActions(interactive) {
  return interactive
    .filter((element) => {
      const hasVisibleName = Boolean(
        String(element.text || element.label || element.nearbyText || "").trim(),
      );
      const isActionLike =
        element.tag === "button" ||
        element.role === "button" ||
        element.purpose === "button" ||
        element.section === "dialog";

      return hasVisibleName && isActionLike;
    })
    .slice(0, 24)
    .map((element) =>
      JSON.stringify({
        id: element.id,
        visibleName: element.visibleName,
        text: element.text,
        label: element.label,
        nearbyText: element.nearbyText,
        purpose: element.purpose,
        section: element.section,
        descriptor: element.descriptor,
        bounds: element.bounds,
        inViewport: element.inViewport,
      }),
    )
    .join("\n");
}

function formatShortcuts(shortcuts) {
  return (shortcuts || [])
    .slice(0, 3)
    .map((shortcut) =>
      JSON.stringify({
        key: shortcut.key,
        flowKey: shortcut.flowKey,
        actionFamily: shortcut.actionFamily,
        target: shortcut.targetHints?.visibleName ||
          shortcut.targetHints?.placeholder ||
          shortcut.targetHints?.nearbyText ||
          shortcut.targetHints?.label ||
          shortcut.targetHints?.purpose ||
          "",
      }),
    )
    .join("\n");
}

function formatThreadMemory(threadMemory) {
  return (threadMemory || [])
    .slice(0, 8)
    .map((entry) =>
      JSON.stringify({
        kind: entry.kind || "",
        action: entry.action || "",
        target: entry.target || "",
        host: entry.host || "",
        url: entry.url || "",
        reason: entry.reason || "",
        summary: entry.summary || "",
      }),
    )
    .join("\n");
}

function formatSessionMemory(sessionMemory) {
  return (sessionMemory || [])
    .slice(-20)
    .map((entry) =>
      JSON.stringify({
        key: entry.key || "",
        kind: entry.kind || "",
        value: entry.value || "",
        reason: entry.reason || "",
        importance: entry.importance || "",
        identifiers: entry.identifiers || [],
      }),
    )
    .join("\n");
}

function formatExecutionJournal(executionJournal) {
  return (executionJournal || [])
    .slice(-16)
    .map((entry) =>
      JSON.stringify({
        cycle: entry.cycle || 0,
        status: entry.status || "",
        actionSummary: entry.actionSummary || "",
        outcome: entry.outcome || "",
        why: entry.why || "",
        nextGuidance: entry.nextGuidance || "",
        reusableData: entry.reusableData || "",
        shouldAffectNextSteps: Boolean(entry.shouldAffectNextSteps),
      }),
    )
    .join("\n");
}

function formatMediaAttachments(mediaAttachments) {
  return (mediaAttachments || [])
    .slice(0, 12)
    .map((item, index) =>
      JSON.stringify({
        order: index + 1,
        ref: `media:${item.id}`,
        shortcutRefs: [
          index === 0 ? "first_media" : null,
          item.kind === "image" && !mediaAttachments.slice(0, index).some((entry) => entry.kind === "image")
            ? "first_image"
            : null,
          item.kind === "video" && !mediaAttachments.slice(0, index).some((entry) => entry.kind === "video")
            ? "first_video"
            : null,
        ].filter(Boolean),
        id: item.id,
        fileName: item.fileName,
        mimeType: item.mimeType,
        kind: item.kind,
        size: item.size,
      }),
    )
    .join("\n");
}

function buildPlannerPrompt({
  userGoal,
  observationPacket,
  recentMessages,
  priorAnalysis,
  previousBlocks,
  lastError,
  recoveryAttempts,
  stepLimit,
  currentCycle,
  shortcuts,
  threadMemory,
  sessionMemory,
  executionJournal,
  mediaAttachments,
  retryMode,
}) {
  return `
User goal:
${userGoal}

Agent identity and operating contract:
- You are an AI browser agent executing the user's task autonomously inside a real browser.
- The user's request is the source of truth for what must be accomplished.
- Your job is to interpret the request as an execution task, not as public-facing text to paste into websites.
- Attached thread media are real assets available to you through upload_media.
- upload_media is your native clipboard-paste file delivery capability. Treat it as an atomic paste step handled by the runtime, not as a manual OS file-picking workflow you need to reason about.
- When you choose upload_media, your job is to confirm the relevant composer/post/message surface is active enough for paste. You may leave elementId empty; the runtime will use the active paste surface. The runtime must paste files from the clipboard and must not click upload buttons that open native pickers.
- If the user sent a photo, video, or file and says "this", "it", "that photo", "that image", or "that video", treat that as a reference to the attached thread media.
- Never ignore attached media when the user goal is about posting, uploading, sending, publishing, or sharing the supplied file.
- Distinguish between operator instruction and publish content. A request like "post this to Facebook" is an automation command, not the caption text of the post.
- Only type public-facing post text when the user explicitly supplied content to publish.
- Never invent, derive, paraphrase, summarize, translate, or improvise caption text, post text, message text, hashtags, or emojis.
- If the user did not explicitly provide public-facing text, keep the composer text empty and publish only the requested media when the platform allows it.
- Never plan around OS file dialogs, local filesystem browsing, drag-drop mechanics, upload-button picker flows, or manual picker handling.
- Gallery/library/media-manager detours are forbidden. Do not open secondary album, gallery, recent-media, cloud-drive, or asset-library surfaces when the current composer already has an obvious attach/upload affordance.
- If media attachment is required and a composer is already active, use upload_media immediately. It does not require a special file-type-specific UI target; the runtime pastes the selected media into the current composer/paste surface.

Total block budget:
${stepLimit}

Current cycle:
${currentCycle}

Planner context mode:
${observationPacket.mode} / ${observationPacket.contextLevel}

Planner retry mode:
${retryMode}

Current page:
${JSON.stringify(observationPacket.page, null, 2)}

Page semantics:
${JSON.stringify(observationPacket.pageSemantics || {}, null, 2)}

Flow summary:
${JSON.stringify(observationPacket.flow || {}, null, 2)}

AgentPageGraph prompt view:
${observationPacket.pageGraph ? JSON.stringify(observationPacket.pageGraph, null, 2) : "<not available>"}

Recent thread messages:
${recentMessages.join("\n")}

Prior analysis:
${priorAnalysis ? JSON.stringify(priorAnalysis, null, 2) : "None"}

Previous blocks:
${previousBlocks.length ? previousBlocks.join("\n") : "None"}

Latest execution error:
${lastError || "None"}

Recovery attempts already used after the latest failure:
${recoveryAttempts}

Relevant page body text:
${observationPacket.bodyText || "<empty>"}

ARIA/accessibility snapshot:
${observationPacket.ariaSnapshot || "<empty>"}

Retrieved site shortcuts:
${formatShortcuts(shortcuts) || "<none>"}

Thread episodic memory:
${formatThreadMemory(threadMemory) || "<none>"}

Session memory:
${formatSessionMemory(sessionMemory) || "<none>"}

Execution journal:
${formatExecutionJournal(executionJournal) || "<none>"}

Available thread media:
${formatMediaAttachments(mediaAttachments) || "<none>"}

Relevant interactive elements:
${formatInteractive(observationPacket.relevantElements || []) || "<none>"}

Primary action candidates:
${formatPrimaryActions(observationPacket.relevantElements || []) || "<none>"}

Relevant HTML excerpt:
${observationPacket.cleanedHtml || "<empty>"}

Return the next logical block of actions that can be executed without waiting for new analysis in the middle.
Keep the block short: 1 to 3 actions.

Allowed action types:
- open_url { "type": "open_url", "url": "https://..." }
- open_search { "type": "open_search", "query": "...", "engine": "duckduckgo|bing|ya" }
- insert { "type": "insert", "text": "...", "elementId": "atlas-... when available", "nodeId": "optional n_... from AgentPageGraph", "submit": false, "submitKey": "optional Enter", "targetReason": "why this element is the right target" }
- click_element { "type": "click_element", "elementId": "atlas-..." } OR { "type": "click_element", "nodeId": "n_..." } OR { "type": "click_element", "targetRole": "button|link|tab|menuitem|checkbox|textbox", "targetName": "exact accessible name from ARIA snapshot" }
- press_key { "type": "press_key", "key": "Enter" }
- scroll { "type": "scroll", "deltaY": 320, "note": "optional reason" }
- read_page { "type": "read_page", "loops": 1 }
- upload_media { "type": "upload_media", "mediaRef": "first_media|first_image|first_video|all_media|all_images|all_videos|media:<id>", "elementId": "optional atlas-... for the current composer/paste surface when obvious", "nodeId": "optional n_... from AgentPageGraph", "note": "optional reason", "targetReason": "optional reason" }

Every action must also include:
- label: short UI label in the same language as the user's latest message, for example "Open Wikipedia" or "Type search query"
- shortcutKey: optional recipe key when you are intentionally reusing one of the retrieved site shortcuts

Rules:
- Use elementId actions when the current page already exposes a matching atlas-* target. You may use AgentPageGraph nodeId when it is the clearest target reference in the graph; the runtime will resolve nodeId to the current executable atlas target before execution. For insert, selecting the concrete elementId or nodeId is part of your job as the model. For upload_media, elementId or nodeId is optional because the runtime can paste into the active composer/paste surface; include a target only when the composer/editor/drop zone is obvious. For click_element, prefer elementId or nodeId when available; if the target is clearly present in the ARIA/accessibility snapshot but absent from interactive candidates, use targetRole + exact targetName from the ARIA snapshot.
- If the desired target is present in Relevant interactive elements with an elementId but has inViewport:false or offscreen bounds, still prefer the direct elementId action. The runtime can scroll the target into view during click, insert, or upload; do not spend repeated blocks on scroll+read just to make a known target visible.
- Session memory has higher priority than shortcuts, weak heuristics, and vague guesses.
- Retrieved site shortcuts are optional accelerators, not commands. Reuse them only if the current page signals clearly match the shortcut target hints.
- If a retrieved shortcut looks close but not exact, ignore it and plan from scratch.
- Internal cognitive work is not a browser action. Summarizing, recalling session memory, comparing options, drafting text, extracting facts, and deciding what to say must happen silently inside the model.
- Never invent actions for internal work such as summarize_text, extract_text, remember, save_memory, load_memory, analyze_page, or similar names.
- If session memory already contains the needed facts or source text, use it internally and then emit only supported browser actions such as insert, click_element, open_url, read_page, or press_key.
- If the next useful step is purely internal and requires no browser interaction, immediately convert that result into the next real browser action instead of inventing a placeholder action.
- Use the thread episodic memory as strategic context. Avoid repeating targets, actions, or page choices that were already marked as failed, irrelevant, exhausted, or counterproductive in this thread.
- If a current target matches a remembered avoid target, failed action, or dead end, choose a different path unless the user explicitly asks to retry it.
- Use session memory as your working notebook for the whole thread. If important data may be needed later, assume it belongs in session memory.
- Before any send/post/submit action, check whether the needed concrete content already exists in session memory. If it does not, gather it first.
- The agent is fully autonomous. Never wait for the user, ask for follow-up text, request confirmation, or pause for approval.
- Never make the next block goal "wait for user input", "wait for text", "ask for caption", "await confirmation", or any equivalent.
- If the thread already contains a user instruction plus media, treat that as sufficient authority to finish the task unless the latest user message explicitly asks to pause or stop.
- High-importance failure and avoid entries in session memory are binding. If they include concrete identifiers, do not target the same thing again unless you are explicitly trying a materially different recovery strategy.
- Treat the execution journal as authoritative thread history. Each journal entry explains what happened, why it mattered, and what the next step should avoid or reuse.
- Do not ignore prior journal conclusions. If the journal says a step failed, looped, hit the wrong target, or produced no progress, you must change strategy rather than repeating it with superficial wording changes.
- If a previous element target failed or was blocked by memory, do not return an empty action list just because that same target is unsafe. Choose a materially different recovery action such as read_page, scroll, press_key, or a model-selected navigation route, then verify the resulting state.
- Never repeat scroll+read_page as a visibility strategy after it has already failed to reveal the same target. If the target is known by elementId, click/insert/upload it directly; if it is unknown, choose a different observation or recovery strategy.
- After a final Post/Publish/Share click closes the composer, do not spend multiple blocks scrolling the feed to prove the new post exists. If the next task needs comments and no comment target is visible after one verification observation, choose a concrete visible comment target if available; otherwise report that the platform did not expose the published post/comment surface instead of looping.
- Make every block reliable for the next block. Plan so that the next step can safely build on this one.
- If the user explicitly provides a URL or asks to open a specific link, use open_url with that exact URL.
- Use open_search only when the destination is not explicitly given as a direct URL.
- Never use Google because it often triggers captcha.
- Prefer DuckDuckGo first, then Bing, then ya.ru when you need a search engine.
- Prefer search results to reach websites only when you do not already have an explicit URL from the user.
- If the thread has attached media and the user goal involves posting, uploading, attaching, publishing, or sending files, prefer upload_media as soon as the relevant composer, form, message surface, drop zone, or paste surface is open.
- Do not search for a special PDF/image/video upload element. Clipboard paste works uniformly for supported media; if the composer is open, upload_media can proceed without a special file-type target.
- If attached media is present and the user goal refers to "this", "it", "photo", "image", "video", "file", or "media", assume the attached thread media is the payload you must operate on.
- If the user goal or ticket steps mention multiple supplied assets, PDFs plus video, files, attachments, or an asset box with more than one file, use upload_media with mediaRef "all_media" unless the page visibly rejects multiple attachments. Do not publish after uploading only one of the required files.
- Treat upload_media as a direct runtime clipboard-paste primitive. Do not plan around OS file pickers, media browsers, local file dialogs, upload-button picker flows, or extra asset-management flows. Do not target a visible upload/attach button if clicking it would open a native picker; choose the active composer, drop zone, text box, or paste surface instead.
- Treat mediaRefs as the only abstraction you need. Do not describe OS filesystems, local paths, buffers, drag-drop internals, or picker mechanics.
- Prefer first_video when the goal mentions video/reel/clip/story video, first_image when the goal mentions photo/image/picture, and first_media when any attached file is acceptable.
- Use all_media, all_images, or all_videos only when the page likely supports multiple uploads and the user intent clearly wants multiple files.
- Prefer insert for entering text. The browser layer already handles humanized typing under the hood.
- Never paste the raw task instruction into a public composer, caption field, message box, or post body unless the user explicitly asked to publish that exact text.
- Treat requests like "post this to Facebook", "upload this photo", "send this file", or "publish this image" as control instructions for you, not as end-user content.
- If a publish composer is ready and media-only posting is possible, prefer leaving the text field empty over inventing or copying task wording into the post.
- If a publish composer is already open, prefer its editable composer, drop zone, or paste surface for upload_media. Avoid extra "add media", "gallery", "album", "photo/video", upload picker buttons, or media-library detours.
- If the composer already shows the uploaded media preview, treat media attachment as complete and continue toward the final publish CTA.
- If the current page visibly reports that the requested upload/post combination is not allowed, incompatible, failed validation, or needs a changed selection, do not ignore that message. Plan a user-level recovery if one is safe and obvious from the page, otherwise report the blocker with the visible reason.
- If both a generic page-level upload control and a composer-local attach control are visible, prefer the composer-local target.
- When in doubt, use upload_media on the composer/paste surface instead of click_element on media attachment buttons.
- After clicking a final publish CTA such as Post, Publish, Share, Send, Save, or Done, do not immediately restart the flow.
- If the execution journal shows a recent final publish click, first verify success on the current page before reopening the composer or re-uploading media.
- Do not rely on inputHint for target resolution. If a relevant element is visible, emit its concrete elementId and explain the choice in targetReason.
- Distinguish between search UI and primary task UI by reading the raw element facts and page context. Never type into the wrong field just because it is editable.
- If multiple editable controls are visible, choose by visible label, placeholder, nearby text, current focus, bounds, and surrounding page state.
- Use pageSemantics, mechanical purpose, section, placeholder, nearby text, and focused state to choose the right field.
- Highest-priority signal for a button is its visible text label.
- Highest-priority signal for an input is its placeholder or nearby placeholder/label text.
- For important confirmation buttons like Post, Share, Publish, Send, Save, Done, rely on the currently visible action candidates, not on previous assumptions.
- If the page shows a creation dialog or composer, verify the exact visible CTA text before clicking.
- If the page shows an active publish composer after media upload, prefer finishing the publish flow now over exploratory reading loops.
- If the goal is to send a message in a chat product, choose the editable control that is visibly part of the active conversation/composer, not a navigation or search control.
- Be aware of the remaining block budget and try to finish within it.
- Never invent unsupported action names. Only use the allowed action types listed above.
- Do not invent selectors. For accessibility targets, do not invent names; copy the exact role/name from the ARIA snapshot.
- Do not skip directly to a final answer if the browser still needs work.

Return JSON only in this exact shape:
{
  "comment": "Short first-person progress report in the same language as the user's latest message.",
  "blockGoal": "What this block is trying to achieve.",
  "actions": []
}
`.trim();
}

function buildTargetResolverPrompt({
  userGoal,
  observationPacket,
  action,
  recentMessages,
  lastError,
}) {
  return `
User goal:
${userGoal}

You are resolving the concrete browser target for one already-planned action.
The runtime will not guess from keywords or CSS classes. You must choose a visible
element id from the observation or an exact AgentPageGraph nodeId. For click_element only, if the target is clearly
present in the ARIA/accessibility snapshot but absent from interactive candidates,
you may instead return an exact accessibility target: targetRole + targetName.

Action needing a target:
${JSON.stringify(action, null, 2)}

Latest execution error:
${lastError || "None"}

Current page:
${JSON.stringify(observationPacket.page, null, 2)}

Page semantics:
${JSON.stringify(observationPacket.pageSemantics || {}, null, 2)}

AgentPageGraph prompt view:
${observationPacket.pageGraph ? JSON.stringify(observationPacket.pageGraph, null, 2) : "<not available>"}

Recent thread messages:
${recentMessages.join("\n")}

Relevant body text:
${observationPacket.bodyText || "<empty>"}

ARIA/accessibility snapshot:
${observationPacket.ariaSnapshot || "<empty>"}

Interactive candidates:
${formatInteractive(observationPacket.relevantElements || []) || "<none>"}

Primary action candidates:
${formatPrimaryActions(observationPacket.relevantElements || []) || "<none>"}

Relevant HTML excerpt:
${observationPacket.cleanedHtml || "<empty>"}

Rules:
- Return an elementId only if it appears in the interactive candidates.
- You may return nodeId only if it appears in AgentPageGraph prompt view and represents the exact intended node. Prefer elementId when both are available.
- For click_element only, if no matching elementId exists but ARIA contains an exact actionable node, return canResolve true with targetRole and targetName copied exactly from that ARIA node.
- Do not invent selectors, labels, or element ids.
- Do not invent accessibility names. targetName must be the exact accessible name shown in ARIA.
- Prefer the element that directly performs the intended action.
- For insert, choose an editable input/textbox/contenteditable element.
- For upload_media, choose the nearest visible composer, editable area, drop zone, or paste surface for the current form when one is obvious. If the composer is active but no safe elementId is exposed, set canResolve true without elementId and explain that upload_media should use the active paste surface. Do not choose a control whose purpose is to open a native file picker.
- For click_element, choose the exact visible control that should be clicked.
- If no safe target exists, set canResolve to false and explain the missing state.

Return JSON only:
{
  "canResolve": true,
  "elementId": "atlas-... or empty for upload_media active paste surface",
  "nodeId": "n_... optional AgentPageGraph node id when clearer than elementId",
  "targetRole": "button",
  "targetName": "Exact accessible name, only when elementId is unavailable for click_element",
  "targetReason": "Short reason grounded in visible facts.",
  "confidence": "high|medium|low"
}
`.trim();
}

function buildAnalyzerPrompt({
  userGoal,
  observationPacket,
  executedActions,
  graphDiff,
  recentMessages,
  blockComment,
  blockError,
  usedShortcuts,
  stepMode,
  threadMemory,
  sessionMemory,
  executionJournal,
  mediaAttachments,
  retryMode,
}) {
  return `
User goal:
${userGoal}

Agent identity and operating contract:
- You are analyzing the state of an autonomous AI browser agent.
- The user's request is the source of truth for what the agent should accomplish.
- Attached thread media are real assets available to the agent and should be treated as intended payload when the goal refers to the supplied photo, video, image, file, or media.
- upload_media is the agent's native clipboard-paste media delivery capability, not a manual OS file workflow.
- The planner should choose upload_media for attachment steps and let the runtime paste files into the current composer/paste surface. Native picker plumbing is forbidden.
- Operational instructions like "post this to Facebook" are not public-facing caption text and must not be treated as text-to-publish.

Executed actions:
${JSON.stringify(executedActions, null, 2)}

AgentPageGraph diff for this block:
${graphDiff ? JSON.stringify(graphDiff, null, 2) : "<not available>"}

Block comment:
${blockComment || "None"}

Block error:
${blockError || "None"}

Analyzer step mode:
${stepMode}

Analyzer retry mode:
${retryMode}

Current page:
${JSON.stringify(observationPacket.page, null, 2)}

Page semantics:
${JSON.stringify(observationPacket.pageSemantics || {}, null, 2)}

Flow summary:
${JSON.stringify(observationPacket.flow || {}, null, 2)}

AgentPageGraph prompt view:
${observationPacket.pageGraph ? JSON.stringify(observationPacket.pageGraph, null, 2) : "<not available>"}

Recent thread messages:
${recentMessages.join("\n")}

Used shortcuts:
${(usedShortcuts || []).map((shortcut) => shortcut.key).join("\n") || "<none>"}

Thread episodic memory:
${formatThreadMemory(threadMemory) || "<none>"}

Session memory:
${formatSessionMemory(sessionMemory) || "<none>"}

Execution journal:
${formatExecutionJournal(executionJournal) || "<none>"}

Available thread media:
${formatMediaAttachments(mediaAttachments) || "<none>"}

Relevant HTML excerpt:
${observationPacket.cleanedHtml || "<empty>"}

Relevant body text:
${observationPacket.bodyText || "<empty>"}

ARIA/accessibility snapshot:
${observationPacket.ariaSnapshot || "<empty>"}

Primary action candidates:
${formatPrimaryActions(observationPacket.relevantElements || []) || "<none>"}

Relevant interactive elements:
${formatInteractive(observationPacket.relevantElements || []) || "<none>"}

Analyze what happened after the last block.
Use the AgentPageGraph diff as the primary structured evidence for whether the page changed as intended. Treat action-level graphDiff entries inside Executed actions as per-action evidence.
If the HTML/text snapshot is too weak, noisy, or inconclusive, request screenshot fallback.
Be strict about semantic mismatches:
- If text was typed into a search field, command palette, or dialog when the goal was to send a message or fill a main-page form, call that out explicitly.
- If the agent pasted the task instruction or operator command into a public composer or post body, call that out explicitly as a semantic failure.
- If attached media existed but the block ignored that media during a posting/upload task, call that out explicitly.
- If the agent opened secondary add-media flows, galleries, libraries, or redundant attachment surfaces even though the active composer already had a usable local upload target or already showed attached media, call that out explicitly.
- If the agent used click_element on an upload-related control where upload_media clipboard-paste should have been used, call that out explicitly as a planning mistake.
- If attached media is already visible in the composer preview, treat the upload step as complete rather than asking for another media-selection step.
- If a final publish CTA was clicked and the composer or dialog then closed, treat that as likely success unless the page shows an explicit error, validation failure, failed upload state, or still-visible unfinished composer.
- If the page shows a visible validation, incompatibility, upload failure, disabled-submit reason, or "cannot combine" style message after attaching media or submitting, treat that page message as authoritative evidence. Do not mark the step successful merely because an upload_media or click action mechanically completed.
- Returning to the feed/profile/main page after a final publish click is not by itself a failure signal.
- Do not conclude that uploaded media was lost just because the composer disappeared after a final publish click.
- If publish completion is uncertain after a final CTA click, set needsVisualFallback to true instead of assuming failure and restarting the flow.
- If the page did not materially change after an input or submit step, assume the wrong target may have been used.
- Prefer diagnosing focus/modals/wrong-field issues over assuming success.
- For publish flows, compare the clicked CTA with the visible action candidates and call out mismatches explicitly.
- If a retrieved shortcut was used and the page signals still point to the same unfinished step, treat that shortcut as a mismatch.
- Use thread memory strategically. If this block repeated a known dead end, wrong target, wrong field, wrong page, or low-value loop, record that explicitly so the planner can avoid it next.
- Manage session memory actively. If this block revealed facts, extracted content, chosen candidates, draft text, constraints, or important failures that may matter later, write them into session memory now.
- Failure memory is especially important. When something fails or dead-ends, store precise identifiers: URL, host, page title, visible label, nearby text, descriptor, element id, or field hint.
- Update the execution journal rigorously. For every important block, explain success or failure, why it happened, what must change next, and what reusable information was obtained.
- The journal should make the next model call safer and smarter. Token cost is acceptable when the step is strategically important.
- If the execution journal already records successful media attachment and a recent final publish click, treat that journal history as stronger evidence than a simple return to the feed page.
- Treat almost every bad page state as recoverable. Prefer proposing a new attempt, a different source, a backtrack, or a new strategy instead of declaring that the agent cannot continue.
- Internal reasoning is not an executed browser step. Do not describe unsupported internal operations as if they were real actions.
- If the planner proposed an unsupported action name, mark that block as a planning error and explain that the intended reasoning should have happened internally before the next supported browser action.
- Do not claim that a derived summary, draft, or transformed text was saved anywhere unless it appears in memoryWrites or in the current session memory.
- The agent is fully autonomous. Never say that you are waiting for the user, waiting for text, waiting for approval, or waiting for confirmation.
- If a publish/upload composer is ready, the correct next step is to finish the flow using the instruction already present in the thread, not to pause for more input.
- Set cannotContinue to false for missing-caption situations. Missing explicit caption is recoverable by leaving the composer text empty when the platform allows media-only publishing.
- If a final publish click likely succeeded, set taskComplete to true.
- Do not write session-memory facts like uploaded=false, media_lost=true, or failure-only composer_closed states solely because the composer closed after a final publish action.

Return JSON only in this exact shape:
{
  "comment": "Short analysis comment for the user in the same language as the user's latest message.",
  "progressSummary": "Compact internal summary in English.",
  "taskComplete": false,
  "needsVisualFallback": false,
  "nextFocus": "What the next block should aim for.",
  "cannotContinue": false,
  "failureReason": "Optional recovery explanation for the next attempt.",
  "outcomeStatus": "good|bad|unknown",
  "outcomeReason": "Why this block outcome or current target was or was not useful.",
  "memoryEntries": [
    {
      "kind": "success|failure|avoid|note",
      "action": "Short action family or action label.",
      "target": "Optional target description to remember or avoid.",
      "url": "Optional URL related to the target.",
      "host": "Optional host/domain related to the target.",
      "reason": "Short English reason.",
      "summary": "Compact English summary."
    }
  ],
  "memoryWrites": [
    {
      "key": "stable_memory_key",
      "kind": "fact|content|constraint|draft|avoid|failure|success|note",
      "value": "The concrete information to store for later use.",
      "reason": "Why this will matter later in the thread.",
      "importance": "low|medium|high",
      "identifiers": ["Concrete identifiers such as URL, host, title, label, descriptor, element id."],
      "replace": false
    }
  ],
  "journalEntries": [
    {
      "status": "success|failure|dead_end|partial",
      "actionSummary": "What this block actually tried to do.",
      "outcome": "What happened after the actions.",
      "why": "Why it succeeded or failed.",
      "nextGuidance": "What the next step should do differently or reuse.",
      "reusableData": "Concrete data, links, text, titles, or facts learned here.",
      "shouldAffectNextSteps": true
    }
  ]
}
`.trim();
}

function buildVisualAnalyzerPrompt({
  userGoal,
  executedActions,
  recentMessages,
  blockError,
  usedShortcuts,
  threadMemory,
  sessionMemory,
  executionJournal,
  mediaAttachments,
}) {
  return `
User goal:
${userGoal}

Agent identity and operating contract:
- You are analyzing a screenshot for an autonomous AI browser agent.
- The user's request is the source of truth for what the agent should accomplish.
- Attached thread media are real assets available to the agent and should be treated as intended payload when the goal refers to the supplied photo, video, image, file, or media.
- upload_media is the agent's native clipboard-paste media delivery capability, not a manual OS file workflow.
- The planner should use upload_media for attachment steps and let the runtime paste files into the current page surface.
- Operational instructions like "post this to Facebook" are not public-facing caption text and must not be treated as text-to-publish.

Executed actions:
${JSON.stringify(executedActions, null, 2)}

Block error:
${blockError || "None"}

Recent thread messages:
${recentMessages.join("\n")}

Used shortcuts:
${formatShortcuts(usedShortcuts) || "<none>"}

Thread episodic memory:
${formatThreadMemory(threadMemory) || "<none>"}

Session memory:
${formatSessionMemory(sessionMemory) || "<none>"}

Execution journal:
${formatExecutionJournal(executionJournal) || "<none>"}

Available thread media:
${formatMediaAttachments(mediaAttachments) || "<none>"}

You are looking at a screenshot of the current browser page because the HTML snapshot was not good enough.

Autonomy rules:
- Never say that you are waiting for the user, waiting for text, waiting for approval, or waiting for confirmation.
- If a publish/upload composer is visible, treat the current thread instruction as sufficient to continue autonomously.
- Never treat the task instruction itself as public post text.
- If no explicit publish text exists, keep the composer text empty and prefer media-only publish when the site allows it.
- If the screenshot already shows attached media in the composer, treat upload as done and move to the final publish step instead of reopening media-related UI.
- If the screenshot shows that the composer disappeared after a recent final Post/Publish/Share click and no error is visible, treat that as likely success rather than restarting the flow.

Return JSON only in this exact shape:
{
  "comment": "Short report in the same language as the user's latest message describing what is visible and what should happen next.",
  "progressSummary": "Compact internal summary in English.",
  "taskComplete": false,
  "nextFocus": "What the next block should aim for.",
  "cannotContinue": false,
  "failureReason": "Optional recovery explanation for the next attempt.",
  "outcomeStatus": "good|bad|unknown",
  "outcomeReason": "Why this block outcome or current target was or was not useful.",
  "memoryEntries": [
    {
      "kind": "success|failure|avoid|note",
      "action": "Short action family or action label.",
      "target": "Optional target description to remember or avoid.",
      "url": "Optional URL related to the target.",
      "host": "Optional host/domain related to the target.",
      "reason": "Short English reason.",
      "summary": "Compact English summary."
    }
  ],
  "memoryWrites": [
    {
      "key": "stable_memory_key",
      "kind": "fact|content|constraint|draft|avoid|failure|success|note",
      "value": "The concrete information to store for later use.",
      "reason": "Why this will matter later in the thread.",
      "importance": "low|medium|high",
      "identifiers": ["Concrete identifiers such as URL, host, title, label, descriptor, element id."],
      "replace": false
    }
  ],
  "journalEntries": [
    {
      "status": "success|failure|dead_end|partial",
      "actionSummary": "What this block actually tried to do.",
      "outcome": "What happened after the actions.",
      "why": "Why it succeeded or failed.",
      "nextGuidance": "What the next step should do differently or reuse.",
      "reusableData": "Concrete data, links, text, titles, or facts learned here.",
      "shouldAffectNextSteps": true
    }
  ]
}
`.trim();
}

const PLANNER_SYSTEM = `
You are the planning brain of a browser agent.
Think step-by-step, but output only compact JSON.
You plan short deterministic action blocks.
Never use CSS selectors.
Never describe actions without putting them into the actions array.
Always write user-facing text fields in the same language as the user's latest message.
Only output real browser actions from the allowed list.
Never turn internal reasoning into a fake action.
The agent is fully autonomous and must never ask the user for more input during task execution.
You are a real AI browser agent with access to page state, thread history, and attached media through upload_media.
The user's request is the source of truth for the task.
Task instructions are not automatically public-facing content.
upload_media is a native clipboard-paste media attach capability and should be planned as a short in-page paste step, not as a long detour through picker-style UI.
Use upload_media for media attachment instead of click_element whenever possible.
Never invent publish text. Never plan manual picker-style flows, gallery surfaces, asset-library detours, or native file dialogs.
`.trim();

const ANALYZER_SYSTEM = `
You are the observation analyst of a browser agent.
Decide what the browser page currently shows and whether the HTML snapshot is sufficient.
Be concise, accurate, and action-oriented.
Output JSON only.
Always write user-facing text fields in the same language as the user's latest message.
The agent is fully autonomous and must never ask the user for more input during task execution.
The user's request is the source of truth for the task.
Task instructions are not automatically public-facing content.
upload_media is a native clipboard-paste media attach capability and should not be analyzed as if the agent needed to manually browse OS files.
Treat any manual picker-style upload flow, gallery/library detour, or invented publish text as a planning failure.
`.trim();

const TARGET_RESOLVER_SYSTEM = `
You are the target-resolution brain of a browser agent.
Choose concrete element ids from structured observations.
Output JSON only.
Never use CSS selectors.
Never invent element ids.
If the observation is ambiguous or missing the right target, return canResolve false.
`.trim();

module.exports = {
  ANALYZER_SYSTEM,
  PLANNER_SYSTEM,
  TARGET_RESOLVER_SYSTEM,
  buildAnalyzerPrompt,
  buildPlannerPrompt,
  buildTargetResolverPrompt,
  buildVisualAnalyzerPrompt,
};
