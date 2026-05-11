const GRAPH_VERSION = 1;

function emptyAgentPageGraph(page = {}) {
  return {
    version: GRAPH_VERSION,
    capturedAt: new Date().toISOString(),
    page: {
      url: page.url || "",
      title: page.title || "",
      loadState: page.loadState || "",
      viewport: page.viewport || null,
      scroll: page.scroll || null,
    },
    modality: {
      kind: "unknown",
      domQuality: "weak",
      ariaQuality: "weak",
      visualNeeded: true,
      reasons: [],
    },
    activeElement: null,
    landmarks: [],
    dialogs: [],
    forms: [],
    interactive: [],
    textBlocks: [],
    validationMessages: [],
    media: [],
    frames: [],
    rawRefs: {
      ariaSnapshot: "",
      screenshotPath: "",
    },
    diagnostics: [],
  };
}

module.exports = {
  GRAPH_VERSION,
  emptyAgentPageGraph,
};
