const fs = require("fs");
const path = require("path");

function compact(value) {
  return String(value || "").trim().toLowerCase();
}

function targetRequired(actionType, message, details = {}) {
  const error = new Error(message);
  error.code = "TARGET_REQUIRED";
  error.actionType = actionType;
  error.details = details;
  return error;
}

function targetNotFound(actionType, elementId, details = {}) {
  const error = new Error(`Target element "${elementId}" was not found in the latest observation.`);
  error.code = "TARGET_NOT_FOUND";
  error.actionType = actionType;
  error.elementId = elementId;
  error.details = details;
  return error;
}

function actionElementId(action) {
  return String(action?.elementId || "").trim();
}

function actionAccessibleTarget(action) {
  const role = compact(action?.targetRole || action?.accessibilityRole || action?.role);
  const name = textValue(action?.targetName || action?.accessibilityName || action?.name);

  if (!role || !name) {
    return null;
  }

  return { role, name };
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

function mimeTypeForFile(filePath, mediaKind) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  if (ext === ".mp4") return "video/mp4";
  if (ext === ".mov") return "video/quicktime";
  if (ext === ".webm") return "video/webm";
  if (ext === ".pdf") return "application/pdf";
  if (compact(mediaKind) === "image") return "image/png";
  if (compact(mediaKind) === "video") return "video/mp4";
  return "application/octet-stream";
}

function textValue(value) {
  return String(value || "").trim();
}

function uniqueText(values) {
  const seen = new Set();
  const result = [];

  for (const value of values) {
    const text = textValue(value);
    if (!text || seen.has(text)) {
      continue;
    }
    seen.add(text);
    result.push(text);
  }

  return result;
}

function inferAccessibleRole(element) {
  const role = compact(element?.role);
  const tag = compact(element?.tag);
  const type = compact(element?.type);
  const purpose = compact(element?.purpose);

  if (
    [
      "button",
      "link",
      "textbox",
      "checkbox",
      "radio",
      "combobox",
      "menuitem",
      "tab",
      "switch",
      "option",
    ].includes(role)
  ) {
    return role;
  }

  if (tag === "button") return "button";
  if (tag === "a") return "link";
  if (tag === "textarea") return "textbox";
  if (tag === "select") return "combobox";
  if (tag === "input") {
    if (["button", "submit", "reset", "image"].includes(type)) return "button";
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    return "textbox";
  }

  if (purpose === "button") return "button";
  if (purpose === "link") return "link";
  if (purpose === "editable") return "textbox";

  return "";
}

function observedCenterPoint(element, viewport) {
  const bounds = element?.bounds || null;
  if (!bounds || !Number.isFinite(bounds.x) || !Number.isFinite(bounds.y)) {
    return null;
  }

  const width = Number(bounds.width || 0);
  const height = Number(bounds.height || 0);
  if (width <= 0 || height <= 0) {
    return null;
  }

  const x = bounds.x + width / 2;
  const y = bounds.y + height / 2;
  const viewportWidth = Number(viewport?.width || 0);
  const viewportHeight = Number(viewport?.height || 0);

  if (viewportWidth > 0 && viewportHeight > 0) {
    if (x < 0 || y < 0 || x > viewportWidth || y > viewportHeight) {
      return null;
    }
  } else if (element?.inViewport === false) {
    return null;
  }

  return { x, y };
}

function distanceToObservedCenter(box, observed) {
  if (!box || !observed) {
    return Number.POSITIVE_INFINITY;
  }

  const center = {
    x: box.x + box.width / 2,
    y: box.y + box.height / 2,
  };
  return Math.hypot(center.x - observed.x, center.y - observed.y);
}

async function pickVisibleLocatorClosestToObserved(locator, observedPoint, limit = 12) {
  const count = Math.min(await locator.count(), limit);
  let best = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (let index = 0; index < count; index += 1) {
    const candidate = locator.nth(index);
    try {
      if (!(await candidate.isVisible({ timeout: 600 }))) {
        continue;
      }
      const box = await candidate.boundingBox();
      const distance = distanceToObservedCenter(box, observedPoint);
      if (!best || distance < bestDistance) {
        best = candidate;
        bestDistance = distance;
      }
    } catch (error) {
      // Candidate disappeared while the page was changing; try the next one.
    }
  }

  return best;
}

async function clickObservedElementFallback({ canvas, logger, resolvedElement, action, originalError }) {
  const role = inferAccessibleRole(resolvedElement);
  const names = uniqueText([
    resolvedElement?.visibleName,
    resolvedElement?.label,
    resolvedElement?.text,
    resolvedElement?.placeholder,
  ]);
  const observedPoint = observedCenterPoint(resolvedElement, canvas.page.viewportSize?.());

  logger.warn("agent.executor", "click_primary_selector_failed", {
    elementId: actionElementId(action),
    role,
    names,
    bounds: resolvedElement?.bounds || null,
    inViewport: resolvedElement?.inViewport,
    error: originalError instanceof Error ? originalError.message : String(originalError),
  });

  if (role && names.length) {
    for (const name of names) {
      try {
        const locator = canvas.page.getByRole(role, {
          name,
          exact: true,
        });
        const target = await pickVisibleLocatorClosestToObserved(locator, observedPoint);
        if (!target) {
          continue;
        }

        await canvas.click(target, {
          note: action.note || `fallback role=${role} name=${name}`,
          timeout: 5000,
        });
        logger.event("agent.executor", "click_accessible_fallback_succeeded", {
          elementId: actionElementId(action),
          role,
          name,
        });
        return {
          method: "accessible_role_name",
          role,
          name,
        };
      } catch (error) {
        logger.error("agent.executor", "click_accessible_fallback_failed", error, {
          elementId: actionElementId(action),
          role,
          name,
        });
      }
    }
  }

  if (observedPoint) {
    try {
      await canvas.page.mouse.click(observedPoint.x, observedPoint.y);
      logger.event("agent.executor", "click_coordinate_fallback_succeeded", {
        elementId: actionElementId(action),
        point: observedPoint,
      });
      return {
        method: "observed_coordinates",
        point: observedPoint,
      };
    } catch (error) {
      logger.error("agent.executor", "click_coordinate_fallback_failed", error, {
        elementId: actionElementId(action),
        point: observedPoint,
      });
    }
  }

  return null;
}

async function clickAccessibleTarget({ canvas, logger, action, reason }) {
  const target = actionAccessibleTarget(action);
  if (!target) {
    return null;
  }

  const locator = canvas.page.getByRole(target.role, {
    name: target.name,
    exact: true,
  });
  const visibleTarget = await pickVisibleLocatorClosestToObserved(locator, null);
  const targetLocator = visibleTarget || locator.first();
  if ((await locator.count().catch(() => 0)) <= 0) {
    throw new Error(
      `Accessible target role="${target.role}" name="${target.name}" was not found on the current page.`,
    );
  }

  await canvas.click(targetLocator, {
    note: action.note || action.targetReason || reason || `role=${target.role} name=${target.name}`,
    timeout: 5000,
  });
  logger.event("agent.executor", "click_accessible_target_succeeded", {
    elementId: actionElementId(action),
    role: target.role,
    name: target.name,
    reason: reason || "",
  });
  return {
    method: "accessible_role_name",
    role: target.role,
    name: target.name,
  };
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

function scoreDomUploadCandidate(candidate, mediaKind, triggerAtlasId) {
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
      score: scoreDomUploadCandidate(candidate, mediaKind, triggerAtlasId),
    }))
    .sort((left, right) => right.score - left.score);
}

async function grantClipboardPermissions(page) {
  try {
    const origin = new URL(page.url()).origin;
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin });
  } catch {}
}

async function focusBestPasteSurface({ page, elementId, logger }) {
  const result = await page.evaluate(({ selector }) => {
    const visible = (element) => {
      if (!element || !element.isConnected) return false;
      const style = window.getComputedStyle(element);
      if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) {
        return false;
      }
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const isEditable = (element) => {
      if (!element) return false;
      const tag = element.tagName.toLowerCase();
      const type = String(element.getAttribute("type") || "").toLowerCase();
      return (
        element.isContentEditable ||
        element.getAttribute("role") === "textbox" ||
        tag === "textarea" ||
        (tag === "input" && !["button", "submit", "reset", "file", "checkbox", "radio"].includes(type))
      );
    };
    const trigger = selector ? document.querySelector(selector) : null;
    const scope =
      trigger?.closest('[role="dialog"], form, main, section, article') ||
      document.querySelector('[role="dialog"]') ||
      document;
    const candidates = Array.from(
      scope.querySelectorAll('[contenteditable="true"], [role="textbox"], textarea, input'),
    ).filter((element) => visible(element) && isEditable(element));
    const active = isEditable(document.activeElement) && visible(document.activeElement)
      ? document.activeElement
      : null;
    const target = active || candidates[0] || document.body;
    target.focus?.();
    if (target.isContentEditable || target.getAttribute?.("role") === "textbox") {
      const range = document.createRange();
      range.selectNodeContents(target);
      range.collapse(false);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }
    const rect = target.getBoundingClientRect?.();
    return {
      tag: target.tagName || "",
      role: target.getAttribute?.("role") || "",
      contentEditable: Boolean(target.isContentEditable),
      focused: document.activeElement === target,
      candidateCount: candidates.length,
      bounds: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
    };
  }, { selector: elementId ? selectorForAtlasId(elementId) : "" });

  logger.event("agent.executor", "upload_paste_surface_focused", {
    triggerAtlasId: elementId,
    ...result,
  });

  return result;
}

async function writeFilesToBrowserClipboard({ page, filePaths, mediaKind, logger }) {
  const files = filePaths.map((filePath) => ({
    name: path.basename(filePath),
    mimeType: mimeTypeForFile(filePath, mediaKind),
    base64: fs.readFileSync(filePath).toString("base64"),
  }));

  await grantClipboardPermissions(page);

  const result = await page.evaluate(async (items) => {
    if (!navigator.clipboard || typeof navigator.clipboard.write !== "function" || typeof ClipboardItem === "undefined") {
      return { ok: false, reason: "clipboard_file_write_unavailable" };
    }
    const clipboardItems = items.map((item) => {
      const binary = atob(item.base64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      const file = new File([bytes], item.name, { type: item.mimeType });
      return new ClipboardItem({ [item.mimeType]: file });
    });
    await navigator.clipboard.write(clipboardItems);
    return {
      ok: true,
      count: clipboardItems.length,
      types: items.map((item) => item.mimeType),
    };
  }, files).catch((error) => ({
    ok: false,
    reason: error instanceof Error ? error.message : String(error),
  }));

  logger.event("agent.executor", "upload_clipboard_write_result", {
    ok: Boolean(result?.ok),
    reason: result?.reason || "",
    fileCount: files.length,
    types: files.map((file) => file.mimeType),
  });

  return result;
}

async function dispatchSyntheticFilePaste({ page, filePaths, mediaKind, logger }) {
  const files = filePaths.map((filePath) => ({
    name: path.basename(filePath),
    mimeType: mimeTypeForFile(filePath, mediaKind),
    base64: fs.readFileSync(filePath).toString("base64"),
  }));

  const result = await page.evaluate((items) => {
    const target = document.activeElement || document.body;
    if (typeof DataTransfer === "undefined" || typeof File === "undefined") {
      return { ok: false, reason: "data_transfer_unavailable" };
    }
    const dataTransfer = new DataTransfer();
    for (const item of items) {
      const binary = atob(item.base64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      dataTransfer.items.add(new File([bytes], item.name, { type: item.mimeType }));
    }
    const event = new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: dataTransfer,
    });
    const accepted = target.dispatchEvent(event);
    return {
      ok: true,
      accepted,
      fileCount: dataTransfer.files.length,
      targetTag: target.tagName || "",
      targetRole: target.getAttribute?.("role") || "",
    };
  }, files).catch((error) => ({
    ok: false,
    reason: error instanceof Error ? error.message : String(error),
  }));

  logger.event("agent.executor", "upload_synthetic_paste_result", {
    ok: Boolean(result?.ok),
    reason: result?.reason || "",
    accepted: result?.accepted,
    fileCount: result?.fileCount || 0,
    targetTag: result?.targetTag || "",
    targetRole: result?.targetRole || "",
  });

  return result;
}

async function uploadViaRuntime({ canvas, logger, resolvedElement, elementId, filePaths, mediaKind, hint }) {
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

  logger.event("agent.executor", "upload_picker_paths_disabled", {
    triggerAtlasId: elementId,
    reason: "native picker, filechooser, trigger clicks, dispatch clicks, and setInputFiles are forbidden for upload_media",
  });

  await focusBestPasteSurface({
    page: canvas.page,
    elementId,
    logger,
  });

  const clipboardResult = await writeFilesToBrowserClipboard({
    page: canvas.page,
    filePaths,
    mediaKind,
    logger,
  });

  if (clipboardResult?.ok) {
    await canvas.page.keyboard.press(process.platform === "darwin" ? "Meta+V" : "Control+V");
    await canvas.settle();
    return {
      method: "clipboard_paste",
      atlasId: elementId,
      fileCount: filePaths.length,
      clipboardTypes: clipboardResult.types || [],
    };
  }

  const syntheticResult = await dispatchSyntheticFilePaste({
    page: canvas.page,
    filePaths,
    mediaKind,
    logger,
  });
  if (syntheticResult?.ok) {
    await canvas.settle();
    return {
      method: "synthetic_clipboard_paste",
      atlasId: elementId,
      fileCount: filePaths.length,
      syntheticAccepted: syntheticResult.accepted,
    };
  }

  logger.warn("agent.executor", "upload_clipboard_paste_exhausted", {
    triggerAtlasId: elementId,
    resolvedPurpose: resolvedElement?.purpose || "",
    resolvedType: resolvedElement?.type || "",
    mediaKind,
    fileCount: filePaths.length,
    clipboardReason: clipboardResult?.reason || "",
    syntheticReason: syntheticResult?.reason || "",
  });
  throw new Error("Upload runtime could not paste files via clipboard; native picker paths are forbidden.");
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

    case "search_site":
      throw targetRequired(
        "search_site",
        "search_site is deprecated. Use open_search, or resolve a concrete elementId and execute insert.",
      );

    case "insert": {
      const elementId = actionElementId(action);
      if (!elementId) {
        throw targetRequired("insert", "insert requires elementId. Target selection must be resolved by the model.", {
          textPreview: String(action.text || "").slice(0, 120),
        });
      }

      const resolvedElement = observation.interactive.find((element) => element.id === elementId) || null;
      if (!resolvedElement) {
        throw targetNotFound("insert", elementId);
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
        targetReason: action.targetReason || "",
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
          targetReason: action.targetReason || "",
        },
      };
    }

    case "type_element": {
      if (!actionElementId(action)) {
        throw targetRequired("type_element", "type_element requires elementId.");
      }
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
    }

    case "click_element": {
      const elementId = actionElementId(action);
      const accessibleTarget = actionAccessibleTarget(action);
      if (!elementId && !accessibleTarget) {
        throw targetRequired("click_element", "click_element requires elementId or an exact accessibility target.");
      }

      const resolvedElement = elementId
        ? observation.interactive.find((element) => element.id === elementId) || null
        : null;
      if (!resolvedElement) {
        const accessibleClick = await clickAccessibleTarget({
          canvas,
          logger,
          action,
          reason: "element id unavailable; using model-selected accessibility target",
        });
        if (!accessibleClick) {
          throw targetNotFound("click_element", elementId);
        }
        await canvas.settle();
        return {
          resolvedTarget: {
            kind: "element",
            elementId,
            clickFallback: accessibleClick,
            role: accessibleClick.role,
            visibleName: accessibleClick.name,
          },
        };
      }

      logger.event("agent.executor", "action_target_resolved", {
        type: action.type,
        elementId,
        role: resolvedElement?.role || "",
        tag: resolvedElement?.tag || "",
        purpose: resolvedElement?.purpose || "",
        section: resolvedElement?.section || "",
        descriptor: resolvedElement?.descriptor || "",
        className: resolvedElement?.className || "",
        nearbyText: resolvedElement?.nearbyText || "",
        visibleName: resolvedElement?.visibleName || "",
        label: resolvedElement?.label || "",
        text: resolvedElement?.text || "",
        bounds: resolvedElement?.bounds || null,
        targetReason: action.targetReason || "",
      });

      let clickFallback = null;
      try {
        await canvas.click(`[data-atlas-id="${elementId}"]`, {
          note: action.note || "",
        });
      } catch (error) {
        clickFallback = await clickObservedElementFallback({
          canvas,
          logger,
          resolvedElement,
          action,
          originalError: error,
        });
        if (!clickFallback) {
          throw error;
        }
      }

      await canvas.settle();
      return {
        resolvedTarget: {
          kind: "element",
          elementId,
          clickFallback,
          role: resolvedElement?.role || "",
          tag: resolvedElement?.tag || "",
          purpose: resolvedElement?.purpose || "",
          section: resolvedElement?.section || "",
          descriptor: resolvedElement?.descriptor || "",
          visibleName: resolvedElement?.visibleName || "",
          label: resolvedElement?.label || "",
          text: resolvedElement?.text || "",
        },
      };
    }

    case "click_by_text": {
      throw targetRequired(
        "click_by_text",
        "click_by_text is deprecated. The model must resolve a concrete elementId and execute click_element.",
        {
          text: action.text || "",
        },
      );
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
      let elementId = actionElementId(action);

      if (elementId) {
        resolvedElement = observation.interactive.find((element) => element.id === elementId) || null;
      }

      if (!resolvedElement) {
        logger.warn("agent.executor", "upload_target_surface_missing_using_active_surface", {
          elementId,
          mediaRef: action.mediaRef || "first_media",
          mediaKind,
          reason: elementId
            ? "planned paste surface was not present in the latest observation"
            : "upload_media does not require a special target; using active page paste surface",
        });
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
        targetReason: action.targetReason || "",
      });

      const uploadResult = await uploadViaRuntime({
        canvas,
        logger,
        resolvedElement,
        elementId,
        filePaths,
        mediaKind,
        hint: action.targetReason || action.note || "",
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
  collectUploadCandidates,
  uploadViaRuntime,
};
