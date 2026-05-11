const { roles } = require("aria-query");
const { emptyAgentPageGraph } = require("./schema");

const KNOWN_ARIA_ROLES = new Set([...roles.keys()]);

function clampText(value, limit = 240) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function countLines(value) {
  const text = String(value || "").trim();
  if (!text) return 0;
  return text.split("\n").filter((line) => line.trim()).length;
}

function inferModality(graph) {
  const reasons = [];
  const interactiveCount = graph.interactive.length;
  const formCount = graph.forms.length;
  const dialogCount = graph.dialogs.length;
  const textCount = graph.textBlocks.length;
  const canvasCount = graph.media.filter((item) => item.kind === "canvas").length;
  const ariaLines = countLines(graph.rawRefs.ariaSnapshot);

  let kind = "document";
  if (canvasCount > 0 && interactiveCount < 8 && ariaLines < 8) {
    kind = "canvas";
    reasons.push("canvas-heavy page with weak DOM/accessibility controls");
  } else if (dialogCount > 0 || formCount > 0 || interactiveCount >= 30) {
    kind = "app";
    reasons.push("page exposes dialogs, forms, or many interactive controls");
  } else if (textCount >= 8 && interactiveCount < 20) {
    kind = "document";
    reasons.push("page is mostly readable text with limited controls");
  } else {
    kind = "mixed";
    reasons.push("page has a mixed document/app shape");
  }

  const domQuality = interactiveCount || textCount || formCount ? "good" : "weak";
  const ariaQuality = ariaLines >= 20 ? "good" : ariaLines >= 5 ? "partial" : "weak";

  return {
    kind,
    domQuality,
    ariaQuality,
    visualNeeded: kind === "canvas" || ariaQuality === "weak",
    reasons,
  };
}

function summarizeGraph(graph) {
  return {
    url: graph.page.url,
    title: graph.page.title,
    modality: graph.modality,
    counts: {
      interactive: graph.interactive.length,
      forms: graph.forms.length,
      dialogs: graph.dialogs.length,
      landmarks: graph.landmarks.length,
      textBlocks: graph.textBlocks.length,
      validationMessages: graph.validationMessages.length,
      media: graph.media.length,
      frames: graph.frames.length,
    },
    activeElement: graph.activeElement
      ? {
          nodeId: graph.activeElement.nodeId,
          role: graph.activeElement.role,
          name: graph.activeElement.name,
          tag: graph.activeElement.tag,
        }
      : null,
  };
}

async function collectDomGraph(page) {
  return page.evaluate(({ knownRoles }) => {
    const knownRoleSet = new Set(knownRoles || []);

    function compact(value, limit = 240) {
      return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
    }

    function ensureNodeId(element) {
      if (!element || !element.dataset) return "";
      if (!element.dataset.agentNodeId) {
        element.dataset.agentNodeId = `n_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      }
      return element.dataset.agentNodeId;
    }

    function rectFor(element) {
      const rect = element.getBoundingClientRect();
      return {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    }

    function visible(element) {
      if (!element || !element.isConnected) return false;
      const tag = element.tagName.toLowerCase();
      const type = String(element.getAttribute("type") || "").toLowerCase();
      if (tag === "input" && type === "file") return true;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return Boolean(
        style &&
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          Number(style.opacity || "1") > 0 &&
          rect.width > 0 &&
          rect.height > 0,
      );
    }

    function inViewport(element) {
      const rect = element.getBoundingClientRect();
      return rect.bottom >= 0 && rect.right >= 0 && rect.top <= window.innerHeight && rect.left <= window.innerWidth;
    }

    function explicitRole(element) {
      const role = compact(element.getAttribute("role"), 80).toLowerCase();
      return knownRoleSet.has(role) ? role : "";
    }

    function implicitRole(element) {
      const tag = element.tagName.toLowerCase();
      const type = String(element.getAttribute("type") || "").toLowerCase();
      if (tag === "a" && element.hasAttribute("href")) return "link";
      if (tag === "button") return "button";
      if (tag === "textarea") return "textbox";
      if (tag === "select") return "combobox";
      if (tag === "input") {
        if (["button", "submit", "reset", "image"].includes(type)) return "button";
        if (type === "checkbox") return "checkbox";
        if (type === "radio") return "radio";
        if (type === "range") return "slider";
        if (type === "file") return "file";
        return "textbox";
      }
      if (/^h[1-6]$/.test(tag)) return "heading";
      if (tag === "nav") return "navigation";
      if (tag === "main") return "main";
      if (tag === "form") return "form";
      if (tag === "dialog") return "dialog";
      if (tag === "img") return "img";
      return "";
    }

    function roleFor(element) {
      return explicitRole(element) || implicitRole(element);
    }

    function textByIdList(idList) {
      return compact(
        String(idList || "")
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.innerText || document.getElementById(id)?.textContent || "")
          .filter(Boolean)
          .join(" "),
        240,
      );
    }

    function labelFor(element) {
      const id = element.getAttribute("id") || "";
      if (id) {
        const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
        if (label) return compact(label.innerText || label.textContent, 240);
      }
      const closestLabel = element.closest("label");
      return closestLabel ? compact(closestLabel.innerText || closestLabel.textContent, 240) : "";
    }

    function nameFor(element) {
      return (
        compact(element.getAttribute("aria-label"), 240) ||
        textByIdList(element.getAttribute("aria-labelledby")) ||
        labelFor(element) ||
        compact(element.getAttribute("placeholder"), 240) ||
        compact(element.getAttribute("alt"), 240) ||
        compact(element.getAttribute("title"), 240) ||
        compact(element.innerText || element.textContent, 240)
      );
    }

    function descriptionFor(element) {
      return textByIdList(element.getAttribute("aria-describedby"));
    }

    function nodePath(element) {
      const parts = [];
      let current = element;
      let depth = 0;
      while (current && current.nodeType === Node.ELEMENT_NODE && depth < 5) {
        const role = roleFor(current);
        parts.unshift([current.tagName.toLowerCase(), role].filter(Boolean).join(":"));
        current = current.parentElement;
        depth += 1;
      }
      return parts.join(" > ");
    }

    function ownerId(element, selector) {
      const owner = element.closest(selector);
      return owner ? ensureNodeId(owner) : "";
    }

    function baseNode(element) {
      return {
        nodeId: ensureNodeId(element),
        atlasId: element.dataset?.atlasId || "",
        tag: element.tagName.toLowerCase(),
        role: roleFor(element),
        name: nameFor(element),
        description: descriptionFor(element),
        text: compact(element.innerText || element.textContent, 320),
        value: compact(element.value, 240),
        placeholder: compact(element.getAttribute("placeholder"), 240),
        disabled: Boolean(element.disabled || element.getAttribute("aria-disabled") === "true"),
        visible: visible(element),
        inViewport: inViewport(element),
        bounds: rectFor(element),
        formOwner: ownerId(element, "form"),
        dialogOwner: ownerId(element, '[role="dialog"], dialog, [aria-modal="true"]'),
        parentChain: nodePath(element),
      };
    }

    function actionHints(element) {
      const role = roleFor(element);
      const tag = element.tagName.toLowerCase();
      const type = String(element.getAttribute("type") || "").toLowerCase();
      const hints = [];
      if (["button", "link", "checkbox", "radio", "switch", "tab", "menuitem", "option"].includes(role)) hints.push("clickable");
      if (role === "textbox" || element.isContentEditable || tag === "textarea") hints.push("editable");
      if (tag === "input" && type === "file") hints.push("file-input");
      if (tag === "button" && ["submit", ""].includes(type)) hints.push("submit-like");
      if (element.getAttribute("aria-expanded")) hints.push("expandable");
      return hints;
    }

    function summarizeInteractive(element) {
      return {
        ...baseNode(element),
        type: compact(element.getAttribute("type"), 80),
        href: compact(element.getAttribute("href"), 500),
        checked: element.checked === undefined ? null : Boolean(element.checked),
        selected: element.selected === undefined ? null : Boolean(element.selected),
        expanded: compact(element.getAttribute("aria-expanded"), 24),
        actionHints: actionHints(element),
      };
    }

    const interactiveSelector = [
      "a[href]",
      "button",
      "input",
      "textarea",
      "select",
      "summary",
      "[role]",
      "[aria-label]",
      "[aria-labelledby]",
      "[aria-haspopup]",
      "[onclick]",
      "[tabindex]:not([tabindex='-1'])",
      "[contenteditable]:not([contenteditable='false'])",
    ].join(",");

    const interactive = Array.from(document.querySelectorAll(interactiveSelector))
      .filter((element) => visible(element) || (element.tagName.toLowerCase() === "input" && String(element.type).toLowerCase() === "file"))
      .slice(0, 500)
      .map(summarizeInteractive);

    const forms = Array.from(document.querySelectorAll("form"))
      .filter(visible)
      .slice(0, 80)
      .map((form) => ({
        ...baseNode(form),
        fields: Array.from(form.querySelectorAll("input, textarea, select, [contenteditable]:not([contenteditable='false'])"))
          .filter(visible)
          .slice(0, 80)
          .map((field) => summarizeInteractive(field).nodeId),
        submitControls: Array.from(form.querySelectorAll("button, input[type='submit'], input[type='button']"))
          .filter(visible)
          .slice(0, 40)
          .map((control) => summarizeInteractive(control).nodeId),
      }));

    const dialogs = Array.from(document.querySelectorAll('[role="dialog"], dialog, [aria-modal="true"]'))
      .filter(visible)
      .slice(0, 30)
      .map((dialog) => ({
        ...baseNode(dialog),
        controls: Array.from(dialog.querySelectorAll(interactiveSelector))
          .filter(visible)
          .slice(0, 120)
          .map((control) => ensureNodeId(control)),
      }));

    const landmarks = Array.from(document.querySelectorAll("main, nav, header, footer, aside, [role='main'], [role='navigation'], [role='banner'], [role='contentinfo'], [role='complementary']"))
      .filter(visible)
      .slice(0, 40)
      .map(baseNode);

    const textBlocks = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6,p,li,article,section,[role='heading']"))
      .filter(visible)
      .map((element) => ({
        nodeId: ensureNodeId(element),
        tag: element.tagName.toLowerCase(),
        role: roleFor(element),
        text: compact(element.innerText || element.textContent, 700),
        bounds: rectFor(element),
        inViewport: inViewport(element),
      }))
      .filter((item) => item.text.length >= 3)
      .slice(0, 120);

    const validationMessages = Array.from(document.querySelectorAll("[role='alert'], [aria-invalid='true'], .error, .invalid, .warning"))
      .filter(visible)
      .slice(0, 80)
      .map((element) => ({
        ...baseNode(element),
        severity: element.getAttribute("aria-invalid") === "true" ? "invalid" : "message",
      }));

    const media = Array.from(document.querySelectorAll("img, video, canvas, svg"))
      .filter(visible)
      .slice(0, 120)
      .map((element) => ({
        nodeId: ensureNodeId(element),
        kind: element.tagName.toLowerCase(),
        name: nameFor(element),
        src: compact(element.currentSrc || element.src || "", 500),
        bounds: rectFor(element),
        inViewport: inViewport(element),
      }));

    const frames = Array.from(document.querySelectorAll("iframe, frame"))
      .filter(visible)
      .slice(0, 40)
      .map((element) => ({
        nodeId: ensureNodeId(element),
        title: compact(element.getAttribute("title"), 240),
        src: compact(element.getAttribute("src"), 500),
        bounds: rectFor(element),
        inViewport: inViewport(element),
      }));

    const active = document.activeElement && document.activeElement !== document.body
      ? summarizeInteractive(document.activeElement)
      : null;

    return {
      page: {
        url: window.location.href,
        title: document.title,
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight,
        },
        scroll: {
          x: Math.round(window.scrollX),
          y: Math.round(window.scrollY),
        },
      },
      activeElement: active,
      landmarks,
      dialogs,
      forms,
      interactive,
      textBlocks,
      validationMessages,
      media,
      frames,
      diagnostics: [],
    };
  }, { knownRoles: [...KNOWN_ARIA_ROLES] });
}

async function observePageGraph({ canvas, threadId, logger, screenshotPath = "" }) {
  const page = canvas.page;
  const fallback = emptyAgentPageGraph({
    url: page.url(),
    title: await page.title().catch(() => ""),
  });

  try {
    const domGraph = await collectDomGraph(page);
    let ariaSnapshot = "";
    try {
      ariaSnapshot = await page.locator("body").ariaSnapshot({ timeout: 1200 });
    } catch (error) {
      logger.warn("agent.observe", "page_graph_aria_snapshot_failed", {
        threadId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }

    const graph = {
      ...emptyAgentPageGraph(domGraph.page),
      ...domGraph,
      capturedAt: new Date().toISOString(),
      rawRefs: {
        ariaSnapshot: clampText(ariaSnapshot, 12000),
        screenshotPath: screenshotPath || "",
      },
      diagnostics: domGraph.diagnostics || [],
    };
    graph.modality = inferModality(graph);

    logger.event("agent.observe", "page_graph_snapshot", {
      threadId,
      summary: summarizeGraph(graph),
    });

    return graph;
  } catch (error) {
    logger.error("agent.observe", "page_graph_snapshot_failed", error, {
      threadId,
    });
    return fallback;
  }
}

module.exports = {
  observePageGraph,
  summarizeGraph,
};
