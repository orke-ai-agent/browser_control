function compact(value) {
  return String(value || "").trim().toLowerCase();
}

function actionFamilyFromAction(action) {
  const type = compact(action?.type);
  if (type === "open_url" || type === "open_search") return "navigation";
  if (type === "insert" || type === "type_element") return "text_input";
  if (type === "click_element" || type === "click_by_text") return "click";
  if (type === "upload_media") return "upload";
  if (type === "press_key") return "keyboard";
  if (type === "scroll" || type === "read_page") return "explore";
  return "generic";
}

function graphFlowSignature(observation) {
  const graph = observation?.pageGraph || {};
  const page = graph.page || observation?.page || {};
  let host = "";
  try {
    host = new URL(String(page.url || "")).hostname.toLowerCase();
  } catch {}

  const modality = graph.modality || {};
  return [
    host || "unknown_host",
    compact(modality.kind) || "unknown_modality",
    compact(modality.domQuality) || "unknown_dom",
    compact(modality.ariaQuality) || "unknown_aria",
    Array.isArray(graph.dialogs) && graph.dialogs.length ? "dialog_open" : "dialog_closed",
    graph.activeElement?.nodeId ? "focus_active" : "focus_none",
    Array.isArray(graph.forms) && graph.forms.length ? "forms_present" : "forms_absent",
  ].join("|");
}

function inferGraphStepMode({ observation, executedActions }) {
  if (compact(observation?.page?.url) === "about:blank") {
    return "navigation";
  }

  if (Array.isArray(executedActions) && executedActions.length) {
    const family = actionFamilyFromAction(executedActions[executedActions.length - 1]);
    if (family !== "generic") {
      return family;
    }
  }

  const graph = observation?.pageGraph || null;
  if (!graph) {
    return "generic";
  }

  const active = graph.activeElement || null;
  const activeHints = Array.isArray(active?.actionHints) ? active.actionHints.map(compact) : [];
  if (active && (activeHints.includes("editable") || ["textbox", "combobox", "searchbox"].includes(compact(active.role)))) {
    return "text_input";
  }

  if (Array.isArray(graph.validationMessages) && graph.validationMessages.length) {
    return "generic";
  }

  if (Array.isArray(graph.dialogs) && graph.dialogs.length) {
    return "generic";
  }

  const modality = compact(graph.modality?.kind);
  if (modality === "canvas") {
    return "generic";
  }

  return "generic";
}

module.exports = {
  actionFamilyFromAction,
  graphFlowSignature,
  inferGraphStepMode,
};
