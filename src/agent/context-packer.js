const { buildGraphPromptView } = require("./observation/prompt-view");

function compact(value) {
  return String(value || "").trim().toLowerCase();
}

function pickFields(element, fields) {
  const payload = {};

  for (const field of fields) {
    const value = element?.[field];
    if (value === undefined || value === null || value === "") {
      continue;
    }
    payload[field] = value;
  }

  return payload;
}

function scoreInputCandidate(element) {
  let score = 0;
  const purpose = compact(element?.purpose);
  const section = compact(element?.section);

  if (purpose === "editable") score += 30;
  if (purpose === "file_input") score -= 20;
  if (element?.focused) score += 18;
  if (section === "composer") score += 16;
  if (section === "dialog") score += 14;
  if (section === "main") score += 8;
  if (element?.disabled) score -= 20;
  if (compact(element?.placeholder)) score += 6;
  if (compact(element?.visibleName)) score += 5;

  return score;
}

function scoreClickCandidate(element) {
  let score = 0;
  const section = compact(element?.section);
  const purpose = compact(element?.purpose);
  const labelSource = [
    element?.visibleName,
    element?.text,
    element?.label,
    element?.nearbyText,
  ]
    .map(compact)
    .join(" ");

  if (element?.tag === "button" || compact(element?.role) === "button") score += 18;
  if (section === "dialog") score += 18;
  if (section === "composer") score += 16;
  if (section === "main") score += 6;
  if (section === "navigation") score += 4;
  if (purpose === "button") score += 12;
  if (purpose === "link") score += 8;
  if (labelSource) score += 5;
  if (element?.disabled) score -= 20;

  return score;
}

function scoreNavigationCandidate(element) {
  let score = 0;
  const labelSource = [element?.visibleName, element?.text, element?.label]
    .map(compact)
    .join(" ");

  if (compact(element?.href)) score += 20;
  if (element?.tag === "a") score += 16;
  if (labelSource) score += 6;
  if (compact(element?.section) === "navigation") score += 5;
  if (element?.disabled) score -= 20;

  return score;
}

function rankUploadCandidate(element) {
  let score = 0;
  const tag = compact(element?.tag);
  const role = compact(element?.role);
  const type = compact(element?.type);

  if (tag === "input" && type === "file") score += 80;
  if (element?.accept) score += 24;
  if (element?.multiple) score += 8;
  if (tag === "button" || role === "button" || tag === "label") score += 12;
  if (element?.focused) score += 4;
  if (element?.disabled) score -= 40;

  return score;
}

function scoreSearchCandidate(element) {
  let score = 0;

  if (compact(element?.purpose) === "editable") score += 24;
  if (element?.tag === "input" || element?.tag === "textarea") score += 10;
  if (compact(element?.role) === "textbox") score += 10;
  if (compact(element?.placeholder)) score += 6;
  if (compact(element?.visibleName)) score += 5;
  if (compact(element?.href)) score += 4;
  if (element?.focused) score += 6;

  return score;
}

function selectCandidates(interactive, mode, expanded) {
  const source = Array.isArray(interactive) ? interactive : [];
  const maxItems = expanded ? 32 : 16;
  let fields = [
    "id",
    "tag",
    "role",
    "purpose",
    "section",
    "visibleName",
    "descriptor",
    "disabled",
    "bounds",
    "inViewport",
  ];
  let scorer = scoreClickCandidate;

  if (mode === "text_input") {
    fields = [
      "id",
      "tag",
      "role",
      "type",
      "purpose",
      "section",
      "focused",
      "disabled",
      "visibleName",
      "placeholder",
      "label",
      "nearbyText",
      "descriptor",
      "bounds",
      "inViewport",
    ];
    scorer = scoreInputCandidate;
  } else if (mode === "navigation") {
    fields = [
      "id",
      "tag",
      "role",
      "href",
      "section",
      "visibleName",
      "text",
      "label",
      "descriptor",
      "disabled",
      "bounds",
      "inViewport",
    ];
    scorer = scoreNavigationCandidate;
  } else if (mode === "search") {
    fields = [
      "id",
      "tag",
      "role",
      "type",
      "purpose",
      "section",
      "focused",
      "visibleName",
      "placeholder",
      "label",
      "nearbyText",
      "href",
      "descriptor",
      "disabled",
      "bounds",
      "inViewport",
    ];
    scorer = scoreSearchCandidate;
  } else if (mode === "upload") {
    fields = [
      "id",
      "tag",
      "role",
      "type",
      "accept",
      "multiple",
      "focused",
      "disabled",
      "visibleName",
      "placeholder",
      "label",
      "nearbyText",
      "text",
      "descriptor",
      "bounds",
      "inViewport",
    ];
    scorer = rankUploadCandidate;
  } else if (mode === "generic") {
    fields = [
      "id",
      "tag",
      "role",
      "type",
      "purpose",
      "section",
      "focused",
      "disabled",
      "visibleName",
      "placeholder",
      "label",
      "nearbyText",
      "text",
      "href",
      "descriptor",
      "bounds",
      "inViewport",
    ];
    scorer = (element) =>
      Math.max(
        scoreClickCandidate(element),
        scoreInputCandidate(element),
        scoreNavigationCandidate(element),
      );
  }

  return source
    .map((element) => ({
      element,
      score: scorer(element),
    }))
    .filter((item) => item.score > -10)
    .sort((left, right) => right.score - left.score)
    .slice(0, maxItems)
    .map(({ element }) => pickFields(element, fields));
}

function buildObservationPacket(observation, { mode, expanded }) {
  if (observation?.pageGraph) {
    const graph = observation.pageGraph;
    const view = buildGraphPromptView(graph, { mode, expanded });
    const page = {
      url: graph.page?.url || observation.page?.url || "",
      title: graph.page?.title || observation.page?.title || "",
    };
    const textOutline = view.promptGraph.textOutline || [];
    const bodyText = textOutline
      .map((item) => item.text)
      .filter(Boolean)
      .join("\n")
      .slice(0, expanded ? 2200 : 900);

    return {
      mode,
      contextLevel: expanded ? "expanded_graph" : "compact_graph",
      page,
      pageSemantics: {
        ...(observation.pageSemantics || {}),
        viewport: graph.page?.viewport || observation.pageSemantics?.viewport || null,
        scroll: graph.page?.scroll || null,
        modality: graph.modality || {},
        activeElement: view.promptGraph.activeElement || null,
      },
      flow: {
        host: hostFromUrl(page.url),
        modality: graph.modality?.kind || "unknown",
        domQuality: graph.modality?.domQuality || "unknown",
        ariaQuality: graph.modality?.ariaQuality || "unknown",
        visualNeeded: Boolean(graph.modality?.visualNeeded),
      },
      pageGraph: view.promptGraph,
      relevantElements: view.executableElements,
      bodyText,
      ariaSnapshot: view.ariaSnapshot,
      cleanedHtml: "",
    };
  }

  const host = hostFromUrl(observation?.page?.url || "");
  const packet = {
    mode,
    contextLevel: expanded ? "expanded" : "compact",
    page: observation.page,
    pageSemantics: observation.pageSemantics || {},
    flow: {
      host,
      modality: "legacy_snapshot",
      flowKey: [
        host || "unknown_host",
        observation?.pageSemantics?.dialogOpen ? "dialog_open" : "dialog_closed",
        observation?.pageSemantics?.focusedEditableId ? "focus_active" : "focus_none",
      ].join("|"),
      tokens: [
        host ? `host_${host}` : "host_unknown",
        observation?.pageSemantics?.dialogOpen ? "dialog_open" : "dialog_closed",
        observation?.pageSemantics?.focusedEditableId ? "focus_active" : "focus_none",
      ],
    },
    relevantElements: selectCandidates(observation.interactive, mode, expanded),
  };

  const bodyLimit = expanded ? 1800 : 700;
  const htmlLimit = expanded ? 2200 : 0;
  const ariaLimit = expanded ? 2600 : 1200;
  const bodyText = String(observation.bodyText || "").trim().slice(0, bodyLimit);
  const cleanedHtml = String(observation.cleanedHtml || "").trim().slice(0, htmlLimit);
  const ariaSnapshot = String(observation.ariaSnapshot || "").trim().slice(0, ariaLimit);

  if (bodyText) {
    packet.bodyText = bodyText;
  }

  if (cleanedHtml) {
    packet.cleanedHtml = cleanedHtml;
  }

  if (ariaSnapshot) {
    packet.ariaSnapshot = ariaSnapshot;
  }

  return packet;
}

function hostFromUrl(url) {
  try {
    return new URL(String(url || "")).hostname.toLowerCase();
  } catch {
    return "";
  }
}

module.exports = {
  buildObservationPacket,
};
