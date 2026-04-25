function compact(value) {
  return String(value || "").trim().toLowerCase();
}

function scoreSearchInput(element, hint) {
  const haystack = [
    element.text,
    element.label,
    element.placeholder,
    element.type,
    element.role,
  ]
    .map(compact)
    .join(" ");

  let score = 0;

  if (element.tag === "input" || element.tag === "textarea") {
    score += 5;
  }

  if (haystack.includes("search") || haystack.includes("искать") || haystack.includes("поиск")) {
    score += 8;
  }

  if (haystack.includes("find")) {
    score += 3;
  }

  if (hint && haystack.includes(compact(hint))) {
    score += 12;
  }

  return score;
}

function scoreGenericInput(element, hint, text) {
  const haystack = [
    element.text,
    element.label,
    element.placeholder,
    element.type,
    element.role,
    element.purpose,
    element.section,
    element.className,
    element.ancestorClasses,
    element.nearbyText,
    element.descriptor,
  ]
    .map(compact)
    .join(" ");

  const normalizedHint = compact(hint);
  const normalizedText = compact(text);
  let score = 0;

  if (element.disabled) {
    return -1000;
  }

  if (element.tag === "textarea") {
    score += 9;
  } else if (element.tag === "input") {
    score += 7;
  } else if (element.role === "textbox") {
    score += 6;
  }

  if (element.focused) {
    score += 4;
  }

  if (element.section === "main") {
    score += 5;
  }

  if (element.section === "composer") {
    score += 18;
  }

  if (element.section === "dialog") {
    score -= 2;
  }

  if (element.section === "sidebar" || element.section === "navigation") {
    score -= 14;
  }

  if (element.purpose === "chat_input") {
    score += 18;
  }

  if (element.purpose === "text_input") {
    score += 8;
  }

  if (element.purpose === "search_input") {
    score -= 8;
  }

  if (haystack.includes("input-message") || haystack.includes("new-message-wrapper")) {
    score += 28;
  }

  if (haystack.includes("input-search") || haystack.includes("sidebar-header")) {
    score -= 24;
  }

  if (normalizedHint.includes("search") || normalizedHint.includes("поиск")) {
    if (element.purpose === "search_input") {
      score += 16;
    }
  }

  if (
    normalizedHint.includes("chat") ||
    normalizedHint.includes("message") ||
    normalizedHint.includes("composer") ||
    normalizedHint.includes("prompt") ||
    normalizedHint.includes("сообщ") ||
    normalizedHint.includes("чат")
  ) {
    if (element.purpose === "chat_input") {
      score += 24;
    }
    if (element.purpose === "search_input") {
      score -= 18;
    }
  }

  if (normalizedHint && haystack.includes(normalizedHint)) {
    score += 14;
  }

  if (
    normalizedText &&
    (normalizedText.includes("how are you") ||
      normalizedText.includes("как дела") ||
      normalizedText.includes("hello") ||
      normalizedText.includes("привет"))
  ) {
    if (element.purpose === "chat_input") {
      score += 10;
    }
  }

  return score;
}

function scoreTextCandidate(element, text) {
  const haystack = [element.text, element.label, element.href].map(compact).join(" ");
  const needle = compact(text);
  let score = 0;

  if (haystack === needle) {
    score += 30;
  }

  if (haystack.includes(needle)) {
    score += 18;
  }

  if (compact(element.text).startsWith(needle)) {
    score += 8;
  }

  return score;
}

function scoreUploadCandidate(element, hint, mediaKind) {
  const haystack = [
    element.text,
    element.label,
    element.placeholder,
    element.type,
    element.role,
    element.purpose,
    element.section,
    element.className,
    element.ancestorClasses,
    element.nearbyText,
    element.descriptor,
    element.accept,
  ]
    .map(compact)
    .join(" ");
  const normalizedHint = compact(hint);
  const kind = compact(mediaKind);
  let score = 0;

  if (element.disabled) {
    return -1000;
  }

  if (element.type === "file") {
    score += 60;
  }

  if (element.purpose === "file_input") {
    score += 40;
  }

  if (element.purpose === "upload_trigger") {
    score += 28;
  }

  if (element.section === "main" || element.section === "composer") {
    score += 12;
  }

  if (element.section === "sidebar" || element.section === "navigation") {
    score -= 14;
  }

  if (
    haystack.includes("upload") ||
    haystack.includes("attach") ||
    haystack.includes("photo") ||
    haystack.includes("video") ||
    haystack.includes("media") ||
    haystack.includes("image") ||
    haystack.includes("file")
  ) {
    score += 24;
  }

  if (normalizedHint && haystack.includes(normalizedHint)) {
    score += 18;
  }

  if (kind === "video" && (haystack.includes("video") || haystack.includes("reel"))) {
    score += 14;
  }

  if (kind === "image" && (haystack.includes("image") || haystack.includes("photo"))) {
    score += 14;
  }

  return score;
}

function findSearchElement(observation, hint) {
  const candidates = observation.interactive
    .map((element) => ({
      element,
      score: scoreSearchInput(element, hint),
    }))
    .sort((left, right) => right.score - left.score);

  return candidates.length && candidates[0].score > 0 ? candidates[0].element : null;
}

function findTextElement(observation, text) {
  const candidates = observation.interactive
    .map((element) => ({
      element,
      score: scoreTextCandidate(element, text),
    }))
    .sort((left, right) => right.score - left.score);

  return candidates.length && candidates[0].score > 0 ? candidates[0].element : null;
}

function findInsertElement(observation, hint, text) {
  const candidates = observation.interactive
    .map((element) => ({
      element,
      score: scoreGenericInput(element, hint, text),
    }))
    .sort((left, right) => right.score - left.score);

  return candidates.length && candidates[0].score > 0 ? candidates[0].element : null;
}

function findUploadElement(observation, hint, mediaKind) {
  const candidates = observation.interactive
    .map((element) => ({
      element,
      score: scoreUploadCandidate(element, hint, mediaKind),
    }))
    .sort((left, right) => right.score - left.score);

  return candidates.length && candidates[0].score > 0 ? candidates[0].element : null;
}

function searchUrlFor(engine, query) {
  const q = encodeURIComponent(query);
  const name = compact(engine) || "duckduckgo";

  if (name === "bing") {
    return `https://www.bing.com/search?q=${q}`;
  }

  if (name === "ya" || name === "yandex" || name === "ya.ru") {
    return `https://ya.ru/search/?text=${q}`;
  }

  return `https://duckduckgo.com/?q=${q}`;
}

function selectorForAtlasId(atlasId) {
  return `[data-atlas-id="${atlasId}"]`;
}

function mediaKindToAcceptHints(mediaKind) {
  const kind = compact(mediaKind);

  if (kind === "video") {
    return ["video/", ".mp4", ".mov", ".m4v", ".webm"];
  }

  if (kind === "image") {
    return ["image/", ".png", ".jpg", ".jpeg", ".gif", ".webp"];
  }

  return [];
}

function scoreDomUploadCandidate(candidate, hint, mediaKind, triggerAtlasId) {
  const haystack = [
    candidate.tag,
    candidate.type,
    candidate.accept,
    candidate.label,
    candidate.text,
    candidate.className,
    candidate.nearbyText,
    candidate.containerSummary,
    candidate.reasons.join(" "),
  ]
    .map(compact)
    .join(" ");
  const normalizedHint = compact(hint);
  const acceptHints = mediaKindToAcceptHints(mediaKind);
  let score = 0;

  if (candidate.disabled) {
    return -1000;
  }

  if (candidate.type === "file") {
    score += 90;
  }

  if (candidate.isConnectedTrigger) {
    score += 30;
  }

  if (candidate.source === "trigger-associated") {
    score += 26;
  } else if (candidate.source === "same-container") {
    score += 16;
  } else if (candidate.source === "global") {
    score += 8;
  }

  if (candidate.visible) {
    score += 6;
  }

  if (candidate.multiple) {
    score += 3;
  }

  if (candidate.atlasId && candidate.atlasId === triggerAtlasId) {
    score += 40;
  }

  if (
    haystack.includes("upload") ||
    haystack.includes("attach") ||
    haystack.includes("photo") ||
    haystack.includes("video") ||
    haystack.includes("media") ||
    haystack.includes("image") ||
    haystack.includes("file")
  ) {
    score += 18;
  }

  if (normalizedHint && haystack.includes(normalizedHint)) {
    score += 14;
  }

  if (!candidate.accept) {
    score += 4;
  }

  if (
    acceptHints.length &&
    acceptHints.some((item) => compact(candidate.accept).includes(compact(item)))
  ) {
    score += 18;
  }

  return score;
}

async function collectUploadCandidates({ page, triggerAtlasId, hint, mediaKind }) {
  const candidates = await page.evaluate(
    ({ triggerAtlasId: providedTriggerAtlasId }) => {
      function compactText(value) {
        return String(value || "").trim().toLowerCase();
      }

      function ensureAtlasId(element, prefix) {
        if (!element || !element.dataset) {
          return "";
        }

        if (!element.dataset.atlasId) {
          element.dataset.atlasId = `atlas-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        }

        return element.dataset.atlasId;
      }

      function isVisible(element) {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return Boolean(
          style &&
            style.visibility !== "hidden" &&
            style.display !== "none" &&
            rect.width >= 0 &&
            rect.height >= 0,
        );
      }

      function summarizeNode(element) {
        return [
          element.getAttribute("aria-label"),
          element.getAttribute("title"),
          element.getAttribute("name"),
          element.getAttribute("placeholder"),
          element.textContent,
          element.className,
        ]
          .filter(Boolean)
          .join(" ")
          .trim()
          .slice(0, 240);
      }

      function addCandidate(store, input, source, reason, trigger) {
        if (!input || input.tagName?.toLowerCase() !== "input") {
          return;
        }

        if (compactText(input.getAttribute("type")) !== "file") {
          return;
        }

        const atlasId = ensureAtlasId(input, "upload-input");
        const key = atlasId || input.id || `${source}:${reason}`;

        if (!store.has(key)) {
          const style = window.getComputedStyle(input);
          store.set(key, {
            atlasId,
            tag: input.tagName.toLowerCase(),
            type: input.getAttribute("type") || "",
            accept: input.getAttribute("accept") || "",
            multiple: input.hasAttribute("multiple"),
            disabled:
              input.hasAttribute("disabled") || input.getAttribute("aria-disabled") === "true",
            visible: isVisible(input),
            hiddenByStyle:
              style.display === "none" ||
              style.visibility === "hidden" ||
              style.opacity === "0",
            source,
            reasons: [],
            label:
              input.getAttribute("aria-label") ||
              input.getAttribute("name") ||
              input.getAttribute("title") ||
              "",
            text: (input.textContent || "").trim().slice(0, 200),
            className: String(input.className || "").slice(0, 240),
            nearbyText: summarizeNode(input.parentElement || input),
            containerSummary: summarizeNode(
              input.closest('[role="dialog"], dialog, form, main, article, section, [class*="composer"], [class*="upload"]') ||
                input.parentElement ||
                input,
            ),
            triggerAtlasId: trigger?.dataset?.atlasId || "",
            isConnectedTrigger: Boolean(
              trigger &&
                (trigger === input ||
                  trigger.contains(input) ||
                  input.contains(trigger) ||
                  (trigger.closest("label") && trigger.closest("label").contains(input))),
            ),
          });
        }

        store.get(key).reasons.push(reason);
      }

      const fileInputs = Array.from(document.querySelectorAll('input[type="file"]'));
      const trigger = providedTriggerAtlasId
        ? document.querySelector(`[data-atlas-id="${providedTriggerAtlasId}"]`)
        : null;
      const store = new Map();

      for (const input of fileInputs) {
        addCandidate(store, input, "global", "global-file-input", trigger);
      }

      if (trigger) {
        const triggerId = trigger.getAttribute("id") || "";
        const enclosingLabel =
          trigger.tagName?.toLowerCase() === "label" ? trigger : trigger.closest("label");
        const triggerContainers = [
          trigger.closest('[role="dialog"]'),
          trigger.closest("dialog"),
          trigger.closest("form"),
          trigger.closest('[class*="composer"]'),
          trigger.closest('[class*="upload"]'),
          trigger.parentElement,
          trigger.parentElement?.parentElement,
        ].filter(Boolean);

        if (compactText(trigger.getAttribute("type")) === "file") {
          addCandidate(store, trigger, "trigger-associated", "trigger-is-file-input", trigger);
        }

        if (triggerId) {
          const labelByFor = document.querySelector(`label[for="${CSS.escape(triggerId)}"]`);
          if (labelByFor) {
            for (const nestedInput of Array.from(labelByFor.querySelectorAll('input[type="file"]'))) {
              addCandidate(store, nestedInput, "trigger-associated", "label-for-trigger", trigger);
            }
          }
        }

        if (enclosingLabel) {
          for (const nestedInput of Array.from(enclosingLabel.querySelectorAll('input[type="file"]'))) {
            addCandidate(store, nestedInput, "trigger-associated", "trigger-inside-label", trigger);
          }

          const htmlFor = enclosingLabel.getAttribute("for");
          if (htmlFor) {
            const linkedInput = document.getElementById(htmlFor);
            addCandidate(store, linkedInput, "trigger-associated", "label-for-input", trigger);
          }
        }

        const ariaControls = trigger.getAttribute("aria-controls") || "";
        if (ariaControls) {
          for (const id of ariaControls.split(/\s+/).map((item) => item.trim()).filter(Boolean)) {
            addCandidate(
              store,
              document.getElementById(id),
              "trigger-associated",
              "aria-controls-input",
              trigger,
            );
          }
        }

        for (const nestedInput of Array.from(trigger.querySelectorAll('input[type="file"]'))) {
          addCandidate(store, nestedInput, "trigger-associated", "trigger-contains-input", trigger);
        }

        for (const container of triggerContainers) {
          for (const nestedInput of Array.from(container.querySelectorAll('input[type="file"]'))) {
            addCandidate(store, nestedInput, "same-container", "shared-container", trigger);
          }
        }
      }

      return Array.from(store.values());
    },
    { triggerAtlasId },
  );

  return candidates
    .map((candidate) => ({
      ...candidate,
      score: scoreDomUploadCandidate(candidate, hint, mediaKind, triggerAtlasId),
    }))
    .sort((left, right) => right.score - left.score);
}

async function trySetFilesOnInput({ page, atlasId, filePaths, logger, attempt }) {
  const locator = page.locator(selectorForAtlasId(atlasId)).first();
  await locator.setInputFiles(filePaths);
  const verification = await locator.evaluate((element) => ({
    fileCount: element.files ? element.files.length : 0,
    value: element.value || "",
    accept: element.getAttribute("accept") || "",
    multiple: element.hasAttribute("multiple"),
  }));

  logger.event("agent.executor", "upload_input_files_applied", {
    attempt,
    atlasId,
    fileCount: verification.fileCount,
    accept: verification.accept,
    multiple: verification.multiple,
    valuePreview: String(verification.value || "").slice(-120),
  });

  if (!verification.fileCount) {
    throw new Error(`Input ${atlasId} accepted setInputFiles but has no selected files.`);
  }

  return verification;
}

async function uploadViaRuntime({ canvas, logger, resolvedElement, elementId, filePaths, mediaKind, hint }) {
  const selector = elementId ? selectorForAtlasId(elementId) : "";
  let fileChooser = null;

  const initialCandidates = await collectUploadCandidates({
    page: canvas.page,
    triggerAtlasId: elementId,
    hint,
    mediaKind,
  });

  logger.event("agent.executor", "upload_candidates_resolved", {
    triggerAtlasId: elementId,
    resolvedPurpose: resolvedElement?.purpose || "",
    resolvedType: resolvedElement?.type || "",
    mediaKind,
    candidateCount: initialCandidates.length,
    topCandidates: initialCandidates.slice(0, 5).map((candidate) => ({
      atlasId: candidate.atlasId,
      score: candidate.score,
      source: candidate.source,
      reasons: candidate.reasons,
      accept: candidate.accept,
      multiple: candidate.multiple,
      visible: candidate.visible,
      hiddenByStyle: candidate.hiddenByStyle,
      disabled: candidate.disabled,
      isConnectedTrigger: candidate.isConnectedTrigger,
    })),
  });

  const prioritizedInputs = initialCandidates.filter((candidate) => candidate.atlasId);
  for (const candidate of prioritizedInputs) {
    try {
      const verification = await trySetFilesOnInput({
        page: canvas.page,
        atlasId: candidate.atlasId,
        filePaths,
        logger,
        attempt: `${candidate.source}:${candidate.atlasId}`,
      });
      return {
        method: "set_input_files",
        atlasId: candidate.atlasId,
        verification,
        source: candidate.source,
      };
    } catch (error) {
      logger.error("agent.executor", "upload_input_attempt_failed", error, {
        atlasId: candidate.atlasId,
        source: candidate.source,
        reasons: candidate.reasons,
      });
    }
  }

  if (selector) {
    const fileChooserPromise = canvas.page.waitForEvent("filechooser", {
      timeout: 2500,
    }).catch(() => null);

    try {
      await canvas.click(selector, {
        note: hint || "",
      });
    } catch (error) {
      logger.error("agent.executor", "upload_trigger_click_failed", error, {
        selector,
        triggerAtlasId: elementId,
      });
    }

    fileChooser = await fileChooserPromise;
    if (!fileChooser) {
      const dispatchChooserPromise = canvas.page.waitForEvent("filechooser", {
        timeout: 1500,
      }).catch(() => null);

      try {
        await canvas.page.locator(selector).dispatchEvent("click");
      } catch (error) {
        logger.error("agent.executor", "upload_trigger_dispatch_failed", error, {
          selector,
          triggerAtlasId: elementId,
        });
      }

      fileChooser = await dispatchChooserPromise;
    }

    if (fileChooser) {
      await fileChooser.setFiles(filePaths);
      logger.event("agent.executor", "upload_filechooser_applied", {
        triggerAtlasId: elementId,
        fileCount: filePaths.length,
      });
      return {
        method: "filechooser",
        atlasId: elementId,
      };
    }
  }

  const postClickCandidates = await collectUploadCandidates({
    page: canvas.page,
    triggerAtlasId: elementId,
    hint,
    mediaKind,
  });

  logger.event("agent.executor", "upload_post_click_candidates_resolved", {
    triggerAtlasId: elementId,
    candidateCount: postClickCandidates.length,
    topCandidates: postClickCandidates.slice(0, 5).map((candidate) => ({
      atlasId: candidate.atlasId,
      score: candidate.score,
      source: candidate.source,
      reasons: candidate.reasons,
      accept: candidate.accept,
      multiple: candidate.multiple,
      visible: candidate.visible,
      hiddenByStyle: candidate.hiddenByStyle,
      disabled: candidate.disabled,
      isConnectedTrigger: candidate.isConnectedTrigger,
    })),
  });

  for (const candidate of postClickCandidates.filter((item) => item.atlasId)) {
    try {
      const verification = await trySetFilesOnInput({
        page: canvas.page,
        atlasId: candidate.atlasId,
        filePaths,
        logger,
        attempt: `post-click:${candidate.source}:${candidate.atlasId}`,
      });
      return {
        method: "post_click_set_input_files",
        atlasId: candidate.atlasId,
        verification,
        source: candidate.source,
      };
    } catch (error) {
      logger.error("agent.executor", "upload_post_click_input_failed", error, {
        atlasId: candidate.atlasId,
        source: candidate.source,
        reasons: candidate.reasons,
      });
    }
  }

  logger.warn("agent.executor", "upload_runtime_exhausted", {
    triggerAtlasId: elementId,
    resolvedPurpose: resolvedElement?.purpose || "",
    resolvedType: resolvedElement?.type || "",
    mediaKind,
    fileCount: filePaths.length,
  });
  throw new Error("Upload runtime could not resolve a usable file input or file chooser.");
}

async function executeAction({ action, canvas, observation, logger }) {
  logger.event("agent.executor", "action_start", { action });

  switch (action.type) {
    case "open_search": {
      const query = String(action.query || "").trim();
      if (!query) {
        throw new Error("open_search requires a query.");
      }

      const url = searchUrlFor(action.engine, query);
      await canvas.open(url);
      return {
        resolvedTarget: {
          kind: "navigation",
          url,
          engine: compact(action.engine) || "duckduckgo",
        },
      };
    }

    case "open_url":
      await canvas.open(action.url);
      return {
        resolvedTarget: {
          kind: "navigation",
          url: action.url,
        },
      };

    case "search_site": {
      const element = findSearchElement(observation, action.inputHint || "search");

      if (!element) {
        throw new Error("Could not find a search input on the current page.");
      }

      logger.event("agent.executor", "action_target_resolved", {
        type: action.type,
        elementId: element.id,
        purpose: element.purpose || "",
        section: element.section || "",
        descriptor: element.descriptor || "",
        className: element.className || "",
        nearbyText: element.nearbyText || "",
        placeholder: element.placeholder || "",
        label: element.label || "",
      });

      await canvas.insert(`[data-atlas-id="${element.id}"]`, action.query);

      if (action.submit !== false) {
        await canvas.press(action.submitKey || "Enter");
        await canvas.settle();
      }

      return {
        resolvedTarget: {
          kind: "element",
          elementId: element.id,
          purpose: element.purpose || "",
          section: element.section || "",
          descriptor: element.descriptor || "",
          className: element.className || "",
          nearbyText: element.nearbyText || "",
          placeholder: element.placeholder || "",
          label: element.label || "",
          text: element.text || "",
        },
      };
    }

    case "insert": {
      let elementId = action.elementId;
      let resolvedElement = null;

      if (!elementId) {
        const element = findInsertElement(
          observation,
          action.inputHint || "",
          action.text || "",
        );
        resolvedElement = element;
        elementId = element ? element.id : "";
      }

      if (!elementId && observation.pageSemantics?.focusedEditableId) {
        elementId = observation.pageSemantics.focusedEditableId;
        resolvedElement =
          observation.interactive.find((element) => element.id === elementId) || null;
      }

      if (!elementId) {
        throw new Error("Could not resolve an input target for insert.");
      }

      if (!resolvedElement) {
        resolvedElement = observation.interactive.find((element) => element.id === elementId) || null;
      }

      logger.event("agent.executor", "action_target_resolved", {
        type: action.type,
        elementId,
        purpose: resolvedElement?.purpose || "",
        section: resolvedElement?.section || "",
        descriptor: resolvedElement?.descriptor || "",
        className: resolvedElement?.className || "",
        nearbyText: resolvedElement?.nearbyText || "",
        placeholder: resolvedElement?.placeholder || "",
        label: resolvedElement?.label || "",
        inputHint: action.inputHint || "",
      });

      await canvas.insert(`[data-atlas-id="${elementId}"]`, action.text || "", {
        clear: action.clear !== false,
      });

      if (action.submitKey) {
        await canvas.press(action.submitKey);
        await canvas.settle();
      } else if (action.submit) {
        await canvas.press("Enter");
        await canvas.settle();
      }
      return {
        resolvedTarget: {
          kind: "element",
          elementId,
          purpose: resolvedElement?.purpose || "",
          section: resolvedElement?.section || "",
          descriptor: resolvedElement?.descriptor || "",
          className: resolvedElement?.className || "",
          nearbyText: resolvedElement?.nearbyText || "",
          placeholder: resolvedElement?.placeholder || "",
          label: resolvedElement?.label || "",
          text: resolvedElement?.text || "",
          inputHint: action.inputHint || "",
        },
      };
    }

    case "type_element":
      await canvas.insert(`[data-atlas-id="${action.elementId}"]`, action.text || "", {
        clear: action.clear !== false,
      });

      if (action.submitKey) {
        await canvas.press(action.submitKey);
        await canvas.settle();
      }
      return {
        resolvedTarget: {
          kind: "element",
          elementId: action.elementId,
        },
      };

    case "click_element":
      await canvas.click(`[data-atlas-id="${action.elementId}"]`, {
        note: action.note || "",
      });
      await canvas.settle();
      return {
        resolvedTarget: {
          kind: "element",
          elementId: action.elementId,
        },
      };

    case "click_by_text": {
      const element = findTextElement(observation, action.text);

      if (!element) {
        throw new Error(`Could not resolve an element for text "${action.text}".`);
      }

      await canvas.click(`[data-atlas-id="${element.id}"]`, {
        note: action.note || "",
      });
      await canvas.settle();
      return {
        resolvedTarget: {
          kind: "element",
          elementId: element.id,
          purpose: element.purpose || "",
          section: element.section || "",
          descriptor: element.descriptor || "",
          className: element.className || "",
          nearbyText: element.nearbyText || "",
          placeholder: element.placeholder || "",
          label: element.label || "",
          text: element.text || "",
        },
      };
    }

    case "press_key":
      await canvas.press(action.key);
      await canvas.settle();
      return {
        resolvedTarget: {
          kind: "keyboard",
          key: action.key,
        },
      };

    case "scroll":
      await canvas.scroll({
        deltaY: action.deltaY || 320,
        note: action.note || "",
      });
      return {
        resolvedTarget: {
          kind: "scroll",
          deltaY: action.deltaY || 320,
        },
      };

    case "read_page":
      await canvas.read({
        loops: action.loops || 1,
      });
      return {
        resolvedTarget: {
          kind: "read",
          loops: action.loops || 1,
        },
      };

    case "upload_media": {
      const resolveMediaSelection = typeof action.resolveMediaSelection === "function"
        ? action.resolveMediaSelection
        : null;

      if (!resolveMediaSelection) {
        throw new Error("upload_media requires resolveMediaSelection.");
      }

      const selectedMedia = resolveMediaSelection(action.mediaRef || "first_media");
      if (!Array.isArray(selectedMedia) || !selectedMedia.length) {
        throw new Error(`Could not resolve media for ref "${action.mediaRef || "first_media"}".`);
      }

      const mediaKind = compact(selectedMedia[0]?.kind || "file");
      let resolvedElement = null;
      let elementId = compact(action.elementId);

      if (elementId) {
        resolvedElement = observation.interactive.find((element) => element.id === elementId) || null;
      }

      if (!resolvedElement) {
        resolvedElement = findUploadElement(
          observation,
          action.inputHint || action.note || "upload media",
          mediaKind,
        );
        elementId = resolvedElement?.id || "";
      }

      if (!elementId) {
        throw new Error("Could not resolve a media upload target on the current page.");
      }

      const filePaths = selectedMedia.map((item) => item.filePath);

      logger.event("agent.executor", "action_target_resolved", {
        type: action.type,
        elementId,
        mediaRef: action.mediaRef || "first_media",
        mediaCount: selectedMedia.length,
        mediaKinds: selectedMedia.map((item) => item.kind),
        purpose: resolvedElement?.purpose || "",
        section: resolvedElement?.section || "",
        descriptor: resolvedElement?.descriptor || "",
        className: resolvedElement?.className || "",
        nearbyText: resolvedElement?.nearbyText || "",
        label: resolvedElement?.label || "",
        inputHint: action.inputHint || "",
      });

      const uploadResult = await uploadViaRuntime({
        canvas,
        logger,
        resolvedElement,
        elementId,
        filePaths,
        mediaKind,
        hint: action.inputHint || action.note || "upload media",
      });

      await canvas.settle();
      return {
        resolvedTarget: {
          kind: "media_upload",
          elementId,
          uploadMethod: uploadResult.method,
          uploadAtlasId: uploadResult.atlasId || "",
          mediaRef: action.mediaRef || "first_media",
          mediaCount: selectedMedia.length,
          purpose: resolvedElement?.purpose || "",
          section: resolvedElement?.section || "",
          descriptor: resolvedElement?.descriptor || "",
          className: resolvedElement?.className || "",
          nearbyText: resolvedElement?.nearbyText || "",
          label: resolvedElement?.label || "",
          usedMedia: selectedMedia.map((item) => ({
            id: item.id,
            fileName: item.fileName,
            mimeType: item.mimeType,
            kind: item.kind,
            url: item.url,
          })),
        },
      };
    }

    default:
      throw new Error(`Unsupported action type "${action.type}".`);
  }
}

module.exports = {
  executeAction,
  findInsertElement,
  findSearchElement,
  findUploadElement,
  collectUploadCandidates,
  uploadViaRuntime,
};
