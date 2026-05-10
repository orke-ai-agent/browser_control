const fs = require("fs");
const path = require("path");

function summariseInteractive(element) {
  return {
    id: element.id,
    tag: element.tag,
    text: element.text,
    label: element.label,
    href: element.href,
    type: element.type,
    accept: element.accept,
    multiple: element.multiple,
    placeholder: element.placeholder,
    role: element.role,
    purpose: element.purpose,
    section: element.section,
    focused: element.focused,
    disabled: element.disabled,
    domIndex: element.domIndex,
    className: element.className,
    ancestorClasses: element.ancestorClasses,
    nearbyText: element.nearbyText,
    descriptor: element.descriptor,
    visibleName: element.visibleName,
  };
}

async function captureObservation({ canvas, threadId, rootDir, logger, captureScreenshot = false }) {
  const page = canvas.page;
  let observation;

  try {
    observation = await page.evaluate(() => {
      function compactText(value) {
        return String(value || "").trim().toLowerCase();
      }

      function classTokens(node) {
        return String(node?.className || "")
          .split(/\s+/)
          .map((item) => item.trim())
          .filter(Boolean)
          .slice(0, 12);
      }

      function ancestorClassSummary(element) {
        const parts = [];
        let current = element.parentElement;
        let depth = 0;

        while (current && depth < 3) {
          const tokens = classTokens(current);
          if (tokens.length) {
            parts.push(tokens.slice(0, 4).join("."));
          }
          current = current.parentElement;
          depth += 1;
        }

        return parts.join(" > ").slice(0, 240);
      }

      function resolveNearbyText(element) {
        const directPlaceholder =
          element.getAttribute("placeholder") || element.getAttribute("aria-placeholder") || "";
        if (directPlaceholder.trim()) {
          return directPlaceholder.trim().slice(0, 160);
        }

        const candidates = [
          element.parentElement,
          element.closest("[class]"),
          element.parentElement?.querySelector('[class*="placeholder"], [class*="label"]'),
          element.closest("label, form, fieldset, [role='group']"),
        ].filter(Boolean);

        for (const candidate of candidates) {
          if (!candidate) {
            continue;
          }

          const placeholderNode =
            candidate.matches?.('[class*="placeholder"], [class*="label"]')
              ? candidate
              : candidate.querySelector?.('[class*="placeholder"], [class*="label"]');

          const text = (placeholderNode?.textContent || candidate.textContent || "").trim();
          if (text) {
            return text.slice(0, 160);
          }
        }

        return "";
      }

      function resolveVisibleName(element) {
        return (
          (element.textContent || "").trim() ||
          (element.getAttribute("aria-label") || "").trim() ||
          resolveNearbyText(element) ||
          (element.getAttribute("placeholder") || "").trim() ||
          (element.getAttribute("aria-placeholder") || "").trim()
        ).slice(0, 160);
      }

      function isVisible(element) {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        const isFileInput =
          element.tagName.toLowerCase() === "input" &&
          compactText(element.getAttribute("type")) === "file";
        return (
          isFileInput ||
          (style &&
            style.visibility !== "hidden" &&
            style.display !== "none" &&
            rect.width > 0 &&
            rect.height > 0)
        );
      }

      function scoreInteractivePriority(element, index) {
        const purpose = inferPurpose(element);
        const section = inferSection(element);
        const tag = element.tagName.toLowerCase();
        let score = 0;

        if (
          tag === "input" &&
          compactText(element.getAttribute("type")) === "file"
        ) {
          score += 72;
        }

        if (
          tag === "textarea" ||
          tag === "input" ||
          element.getAttribute("role") === "textbox" ||
          (element.hasAttribute("contenteditable") &&
            element.getAttribute("contenteditable") !== "false")
        ) {
          score += 50;
        }

        if (purpose === "editable") {
          score += 40;
        } else if (purpose === "button") {
          score += 24;
        } else if (purpose === "file_input") {
          score += 56;
        }

        if (section === "main") {
          score += 18;
        } else if (section === "dialog") {
          score += 4;
        } else if (section === "navigation") {
          score -= 8;
        }

        if (document.activeElement === element) {
          score += 30;
        }

        return score - index * 0.001;
      }

      function isEditableElement(element) {
        const tag = element.tagName.toLowerCase();
        return (
          tag === "textarea" ||
          tag === "input" ||
          element.getAttribute("role") === "textbox" ||
          (element.hasAttribute("contenteditable") &&
            element.getAttribute("contenteditable") !== "false")
        );
      }

      function inferPurpose(element) {
        const tag = element.tagName.toLowerCase();
        const role = compactText(element.getAttribute("role"));
        const type = compactText(element.getAttribute("type"));

        if (tag === "input" && type === "file") {
          return "file_input";
        }

        if (isEditableElement(element)) {
          return "editable";
        }

        if (tag === "button" || role === "button") {
          return "button";
        }

        if (tag === "a") {
          return "link";
        }

        if (tag === "select") {
          return "select";
        }

        return "generic";
      }

      function inferSection(element) {
        if (element.closest('[role="dialog"], dialog, [aria-modal="true"]')) {
          return "dialog";
        }

        if (element.closest("header, [role='banner']")) {
          return "header";
        }

        if (element.closest("nav, aside, [role='navigation']")) {
          return "navigation";
        }

        if (element.closest("main, article, [role='main']")) {
          return "main";
        }

        return "other";
      }

      function buildDescriptor(element) {
        const purpose = inferPurpose(element);
        const section = inferSection(element);
        const nearbyText = resolveNearbyText(element);
        const classes = classTokens(element).slice(0, 4).join(".");

        return {
          purpose,
          section,
          nearbyText,
          visibleName: resolveVisibleName(element),
          className: String(element.className || "").slice(0, 240),
          ancestorClasses: ancestorClassSummary(element),
          summary: [purpose, section, resolveVisibleName(element) || nearbyText || classes]
            .filter(Boolean)
            .join(" | ")
            .slice(0, 320),
        };
      }

      const activeEditable = document.activeElement
        ? document.activeElement.closest(
            'textarea, input, [role="textbox"], [contenteditable]:not([contenteditable="false"])',
          )
        : null;

      const interactiveNodes = Array.from(
        document.querySelectorAll(
          'a, button, input, textarea, select, [role="button"], [role="textbox"], [contenteditable]:not([contenteditable="false"])',
        ),
      ).filter(isVisible);

      const prioritizedNodes = interactiveNodes
        .map((element, index) => ({
          element,
          index,
          priority: scoreInteractivePriority(element, index),
        }))
        .sort((left, right) => right.priority - left.priority)
        .slice(0, 140);

      const interactive = prioritizedNodes.map(({ element, index }) => {
        const assignedId = element.dataset.atlasId || `atlas-${Date.now()}-${index}`;
        element.dataset.atlasId = assignedId;
        const descriptor = buildDescriptor(element);

        return {
          id: assignedId,
          tag: element.tagName.toLowerCase(),
          text: (element.textContent || "").trim().slice(0, 200),
          label: (
            element.getAttribute("aria-label") ||
            element.getAttribute("aria-placeholder") ||
            element.getAttribute("name") ||
            element.getAttribute("title") ||
            ""
          )
            .trim()
            .slice(0, 200),
          placeholder: (
            element.getAttribute("placeholder") ||
            element.getAttribute("aria-placeholder") ||
            ""
          )
            .trim()
            .slice(0, 200),
          type: (element.getAttribute("type") || "").trim(),
          accept: (element.getAttribute("accept") || "").trim(),
          multiple: element.hasAttribute("multiple"),
          role: (element.getAttribute("role") || "").trim(),
          href: (element.getAttribute("href") || "").trim().slice(0, 300),
          purpose: descriptor.purpose,
          section: descriptor.section,
          focused: activeEditable === element || document.activeElement === element,
          disabled:
            element.hasAttribute("disabled") ||
            element.getAttribute("aria-disabled") === "true",
          domIndex: index,
          className: descriptor.className,
          ancestorClasses: descriptor.ancestorClasses,
          nearbyText: descriptor.nearbyText,
          descriptor: descriptor.summary,
          visibleName: descriptor.visibleName,
        };
      });

      const root =
        document.querySelector("main") ||
        document.querySelector("article") ||
        document.querySelector('[role="main"]') ||
        document.body ||
        document.documentElement;
      const clone = root ? root.cloneNode(true) : null;
      if (clone) {
        clone
          .querySelectorAll(
            "script, style, noscript, svg, canvas, img, video, audio, picture, source, iframe, aside, nav, footer, header, form",
          )
          .forEach((node) => node.remove());
        clone.querySelectorAll("*").forEach((node) => {
          for (const attribute of Array.from(node.attributes || [])) {
            if (!["href"].includes(attribute.name)) {
              node.removeAttribute(attribute.name);
            }
          }
        });
      }

      return {
        url: window.location.href,
        title: document.title,
        bodyText: (((root && root.innerText) || (root && root.textContent) || "").trim()).slice(
          0,
          4000,
        ),
        cleanedHtml: clone ? clone.innerHTML.replace(/\s+/g, " ").trim().slice(0, 8000) : "",
        interactive,
        pageSemantics: {
          dialogOpen: Boolean(document.querySelector('[role="dialog"], dialog, [aria-modal="true"]')),
          activeElementTag: document.activeElement ? document.activeElement.tagName.toLowerCase() : "",
          activeElementRole: document.activeElement ? document.activeElement.getAttribute("role") || "" : "",
          activeElementPlaceholder: document.activeElement
            ? (document.activeElement.getAttribute("placeholder") || "").trim().slice(0, 200)
            : "",
          focusedEditableId:
            activeEditable && activeEditable.dataset ? activeEditable.dataset.atlasId || "" : "",
          focusedEditablePurpose: activeEditable ? inferPurpose(activeEditable) : "",
        },
      };
    });
  } catch (error) {
    logger.warn("agent.observe", "page_snapshot_dom_fallback", {
      threadId,
      reason: error instanceof Error ? error.message : String(error),
    });
    observation = {
      url: page.url(),
      title: await page.title().catch(() => ""),
      bodyText: "",
      cleanedHtml: "",
      interactive: [],
      pageSemantics: {
        dialogOpen: false,
        activeElementTag: "",
        activeElementRole: "",
        activeElementPlaceholder: "",
        focusedEditableId: "",
        focusedEditablePurpose: "",
      },
    };
  }

  let screenshotPath = "";
  if (captureScreenshot) {
    const screenshotDir = path.join(rootDir, "screenshots");
    fs.mkdirSync(screenshotDir, { recursive: true });
    screenshotPath = path.join(screenshotDir, `${threadId}-${Date.now()}.png`);
    try {
      await page.screenshot({
        path: screenshotPath,
        fullPage: false,
      });
    } catch (error) {
      logger.warn("agent.observe", "screenshot_failed", {
        threadId,
        reason: error instanceof Error ? error.message : String(error),
      });
      screenshotPath = "";
    }
  }

  logger.event("agent.observe", "page_snapshot", {
    threadId,
    url: observation.url,
    title: observation.title,
    interactiveCount: observation.interactive.length,
    screenshotCaptured: Boolean(screenshotPath),
  });

  return {
    page: {
      url: observation.url,
      title: observation.title,
    },
    bodyText: observation.bodyText,
    cleanedHtml: observation.cleanedHtml,
    interactive: observation.interactive.map(summariseInteractive),
    pageSemantics: observation.pageSemantics,
    screenshotPath,
  };
}

module.exports = {
  captureObservation,
};
