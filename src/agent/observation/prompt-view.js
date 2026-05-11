function compact(value) {
  return String(value || "").trim().toLowerCase();
}

function pickFields(source, fields) {
  const payload = {};
  for (const field of fields) {
    const value = source?.[field];
    if (value === undefined || value === null || value === "") {
      continue;
    }
    payload[field] = value;
  }
  return payload;
}

function asLegacyElement(node) {
  const visibleName = node?.name || node?.text || node?.placeholder || "";
  return {
    id: node?.atlasId || "",
    nodeId: node?.nodeId || "",
    tag: node?.tag || "",
    text: node?.text || "",
    label: node?.name || "",
    placeholder: node?.placeholder || "",
    role: node?.role || "",
    type: node?.type || "",
    purpose: purposeForNode(node),
    section: sectionForNode(node),
    focused: Boolean(node?.focused),
    disabled: Boolean(node?.disabled),
    visibleName,
    nearbyText: node?.description || "",
    descriptor: [purposeForNode(node), sectionForNode(node), visibleName || node?.parentChain || ""]
      .filter(Boolean)
      .join(" | "),
    href: node?.href || "",
    bounds: node?.bounds || null,
    inViewport: node?.inViewport,
    actionHints: node?.actionHints || [],
    parentChain: node?.parentChain || "",
  };
}

function purposeForNode(node) {
  const role = compact(node?.role);
  const tag = compact(node?.tag);
  const type = compact(node?.type);
  const hints = Array.isArray(node?.actionHints) ? node.actionHints.map(compact) : [];

  if (tag === "input" && type === "file") return "file_input";
  if (hints.includes("editable") || ["textbox", "combobox", "searchbox"].includes(role)) return "editable";
  if (hints.includes("clickable") || ["button", "menuitem", "tab", "checkbox", "radio", "switch", "option"].includes(role)) {
    return "button";
  }
  if (role === "link" || tag === "a") return "link";
  return "generic";
}

function sectionForNode(node) {
  if (node?.dialogOwner) return "dialog";
  if (node?.formOwner) return "form";
  const chain = compact(node?.parentChain);
  if (chain.includes("nav:navigation")) return "navigation";
  if (chain.includes("main:main")) return "main";
  return "page";
}

function scoreNodeForMode(node, mode) {
  const purpose = purposeForNode(node);
  const role = compact(node?.role);
  const tag = compact(node?.tag);
  const section = sectionForNode(node);
  const hints = Array.isArray(node?.actionHints) ? node.actionHints.map(compact) : [];
  let score = 0;

  if (node?.atlasId) score += 80;
  if (node?.inViewport) score += 10;
  if (node?.disabled) score -= 100;
  if (node?.name || node?.text || node?.placeholder) score += 8;
  if (section === "dialog") score += 14;
  if (section === "form") score += 10;

  if (mode === "text_input") {
    if (purpose === "editable") score += 60;
    if (node?.placeholder) score += 8;
  } else if (mode === "navigation") {
    if (role === "link" || tag === "a" || node?.href) score += 50;
  } else if (mode === "search") {
    if (purpose === "editable") score += 40;
    if (compact(node?.name || node?.placeholder).includes("search")) score += 20;
  } else if (mode === "upload") {
    if (purpose === "file_input") score += 50;
    if (purpose === "editable") score += 35;
  } else {
    if (hints.includes("clickable")) score += 35;
    if (purpose === "editable") score += 20;
  }

  return score;
}

function selectExecutableElements(graph, mode, expanded) {
  const maxItems = expanded ? 48 : 28;
  return (graph?.interactive || [])
    .filter((node) => node?.atlasId)
    .map((node) => ({
      node,
      score: scoreNodeForMode(node, mode),
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, maxItems)
    .map(({ node }) => asLegacyElement(node));
}

function summarizeNode(node) {
  return pickFields(node, [
    "nodeId",
    "atlasId",
    "tag",
    "role",
    "name",
    "text",
    "value",
    "placeholder",
    "disabled",
    "visible",
    "inViewport",
    "bounds",
    "formOwner",
    "dialogOwner",
    "parentChain",
    "actionHints",
  ]);
}

function summarizeForm(form, graph) {
  const byNodeId = new Map((graph?.interactive || []).map((node) => [node.nodeId, node]));
  return {
    ...summarizeNode(form),
    fields: (form.fields || []).slice(0, 24).map((nodeId) => summarizeNode(byNodeId.get(nodeId) || { nodeId })),
    submitControls: (form.submitControls || []).slice(0, 16).map((nodeId) => summarizeNode(byNodeId.get(nodeId) || { nodeId })),
  };
}

function buildGraphPromptView(graph, { mode, expanded }) {
  const textLimit = expanded ? 24 : 10;
  const sectionLimit = expanded ? 12 : 6;
  const ariaLimit = expanded ? 4200 : 1800;
  const executable = selectExecutableElements(graph, mode, expanded);
  const promptGraph = {
    modality: graph.modality || {},
    activeElement: graph.activeElement ? summarizeNode(graph.activeElement) : null,
    dialogs: (graph.dialogs || []).slice(0, sectionLimit).map(summarizeNode),
    forms: (graph.forms || []).slice(0, sectionLimit).map((form) => summarizeForm(form, graph)),
    validationMessages: (graph.validationMessages || []).slice(0, sectionLimit).map(summarizeNode),
    landmarks: (graph.landmarks || []).slice(0, sectionLimit).map(summarizeNode),
    media: (graph.media || []).slice(0, sectionLimit).map(summarizeNode),
    frames: (graph.frames || []).slice(0, sectionLimit).map(summarizeNode),
    textOutline: (graph.textBlocks || [])
      .filter((item) => item.inViewport || expanded)
      .slice(0, textLimit)
      .map((item) => pickFields(item, ["nodeId", "tag", "role", "text", "bounds", "inViewport"])),
    moreAvailable: {
      interactiveTotal: (graph.interactive || []).length,
      executableShown: executable.length,
      formsTotal: (graph.forms || []).length,
      dialogsTotal: (graph.dialogs || []).length,
      textBlocksTotal: (graph.textBlocks || []).length,
      mediaTotal: (graph.media || []).length,
      note: "The runtime keeps the full AgentPageGraph locally; this prompt view is a compact slice.",
    },
  };

  return {
    promptGraph,
    executableElements: executable,
    ariaSnapshot: String(graph.rawRefs?.ariaSnapshot || "").trim().slice(0, ariaLimit),
  };
}

module.exports = {
  buildGraphPromptView,
};
