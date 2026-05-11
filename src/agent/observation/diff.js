function compact(value) {
  return String(value || "").trim();
}

function nodeLabel(node) {
  return compact(node?.name || node?.text || node?.placeholder || node?.role || node?.tag || node?.nodeId);
}

function nodeSignature(node) {
  return [
    node?.nodeId || "",
    node?.atlasId || "",
    node?.tag || "",
    node?.role || "",
    nodeLabel(node),
    node?.disabled ? "disabled" : "enabled",
    node?.visible === false ? "hidden" : "visible",
  ].join("|");
}

function summarizeNode(node) {
  return {
    nodeId: node?.nodeId || "",
    atlasId: node?.atlasId || "",
    tag: node?.tag || "",
    role: node?.role || "",
    name: node?.name || "",
    text: compact(node?.text).slice(0, 160),
    placeholder: node?.placeholder || "",
    disabled: Boolean(node?.disabled),
    visible: node?.visible !== false,
    inViewport: node?.inViewport,
  };
}

function indexByNodeId(nodes) {
  const map = new Map();
  for (const node of nodes || []) {
    const nodeId = compact(node?.nodeId);
    if (nodeId) {
      map.set(nodeId, node);
    }
  }
  return map;
}

function diffNodeList(beforeNodes, afterNodes, limit = 12) {
  const before = indexByNodeId(beforeNodes);
  const after = indexByNodeId(afterNodes);
  const added = [];
  const removed = [];
  const changed = [];

  for (const [nodeId, afterNode] of after.entries()) {
    if (!before.has(nodeId)) {
      added.push(summarizeNode(afterNode));
      continue;
    }
    const beforeNode = before.get(nodeId);
    if (nodeSignature(beforeNode) !== nodeSignature(afterNode)) {
      changed.push({
        before: summarizeNode(beforeNode),
        after: summarizeNode(afterNode),
      });
    }
  }

  for (const [nodeId, beforeNode] of before.entries()) {
    if (!after.has(nodeId)) {
      removed.push(summarizeNode(beforeNode));
    }
  }

  return {
    added: added.slice(0, limit),
    removed: removed.slice(0, limit),
    changed: changed.slice(0, limit),
    counts: {
      added: added.length,
      removed: removed.length,
      changed: changed.length,
    },
  };
}

function diffPageGraphs(beforeGraph, afterGraph) {
  const before = beforeGraph || {};
  const after = afterGraph || {};
  return {
    pageChanged:
      compact(before.page?.url) !== compact(after.page?.url) ||
      compact(before.page?.title) !== compact(after.page?.title),
    beforePage: {
      url: before.page?.url || "",
      title: before.page?.title || "",
    },
    afterPage: {
      url: after.page?.url || "",
      title: after.page?.title || "",
    },
    modalityChanged: compact(before.modality?.kind) !== compact(after.modality?.kind),
    focusChanged: {
      before: summarizeNode(before.activeElement || {}),
      after: summarizeNode(after.activeElement || {}),
      changed: compact(before.activeElement?.nodeId) !== compact(after.activeElement?.nodeId),
    },
    interactive: diffNodeList(before.interactive, after.interactive),
    dialogs: diffNodeList(before.dialogs, after.dialogs, 6),
    forms: diffNodeList(before.forms, after.forms, 6),
    validationMessages: diffNodeList(before.validationMessages, after.validationMessages, 8),
    textBlocks: diffNodeList(before.textBlocks, after.textBlocks, 8),
    counts: {
      beforeInteractive: Array.isArray(before.interactive) ? before.interactive.length : 0,
      afterInteractive: Array.isArray(after.interactive) ? after.interactive.length : 0,
      beforeDialogs: Array.isArray(before.dialogs) ? before.dialogs.length : 0,
      afterDialogs: Array.isArray(after.dialogs) ? after.dialogs.length : 0,
      beforeForms: Array.isArray(before.forms) ? before.forms.length : 0,
      afterForms: Array.isArray(after.forms) ? after.forms.length : 0,
    },
  };
}

module.exports = {
  diffPageGraphs,
};
