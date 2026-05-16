function graphNodeById(pageGraph, nodeId) {
  const targetId = String(nodeId || "").trim();
  if (!targetId || !pageGraph) {
    return null;
  }

  const buckets = [
    pageGraph.interactive,
    pageGraph.forms,
    pageGraph.dialogs,
    pageGraph.landmarks,
    pageGraph.validationMessages,
    pageGraph.media,
    pageGraph.frames,
    pageGraph.textBlocks,
    pageGraph.activeElement ? [pageGraph.activeElement] : [],
  ];

  for (const bucket of buckets) {
    for (const node of bucket || []) {
      if (String(node?.nodeId || "").trim() === targetId) {
        return node;
      }
    }
  }

  return null;
}

function nodeTargetError(code, message, action, nodeId, details = {}) {
  const error = new Error(message);
  error.name = "NodeTargetResolutionError";
  error.code = code;
  error.action = action;
  error.nodeId = nodeId;
  error.details = details;
  return error;
}

function actionNodeId(action) {
  return String(action?.nodeId || "").trim();
}

function actionElementId(action) {
  return String(action?.elementId || "").trim();
}

function resolveNodeActionTarget(action, observation, options = {}) {
  const nodeId = actionNodeId(action);
  if (!nodeId || actionElementId(action)) {
    return action;
  }

  const node = graphNodeById(observation?.pageGraph, nodeId);
  if (!node) {
    throw nodeTargetError(
      "NODE_STALE",
      `AgentPageGraph node "${nodeId}" is no longer present in the latest page graph.`,
      action,
      nodeId,
    );
  }

  if (node.disabled) {
    throw nodeTargetError(
      "NODE_DISABLED",
      `AgentPageGraph node "${nodeId}" is disabled and cannot be targeted safely.`,
      action,
      nodeId,
      { role: node.role || "", name: node.name || "", tag: node.tag || "" },
    );
  }

  if (node.visible === false) {
    throw nodeTargetError(
      "NODE_NOT_VISIBLE",
      `AgentPageGraph node "${nodeId}" is not visible in the latest page graph.`,
      action,
      nodeId,
      { role: node.role || "", name: node.name || "", tag: node.tag || "" },
    );
  }

  const atlasId = String(node.atlasId || "").trim();
  if (!atlasId) {
    throw nodeTargetError(
      "NODE_NOT_EXECUTABLE",
      `AgentPageGraph node "${nodeId}" has no current executable atlas target.`,
      action,
      nodeId,
      { role: node.role || "", name: node.name || "", tag: node.tag || "" },
    );
  }

  if (options.logger) {
    options.logger.event("agent.service", "node_target_resolved", {
      threadId: options.threadId || "",
      cycle: options.cycle || 0,
      nodeId,
      elementId: atlasId,
      actionType: action.type || "",
      role: node.role || "",
      name: node.name || "",
      tag: node.tag || "",
    });
  }

  return {
    ...action,
    elementId: atlasId,
    resolvedNodeId: nodeId,
    targetReason: action.targetReason || `Resolved AgentPageGraph node ${nodeId}`,
  };
}

module.exports = {
  graphNodeById,
  resolveNodeActionTarget,
};
