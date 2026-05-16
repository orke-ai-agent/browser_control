const path = require("path");
const { createAtlasSession } = require("../atlas");
const { createGeminiClient } = require("./gemini");
const { captureObservation } = require("./page-state");
const { observePageGraph, summarizeGraph } = require("./observation");
const { diffPageGraphs } = require("./observation/diff");
const { graphNodeById, resolveNodeActionTarget } = require("./observation/node-resolver");
const { graphFlowSignature, inferGraphStepMode } = require("./observation/routing");
const { executeAction } = require("./executor");
const {
  ANALYZER_SYSTEM,
  PLANNER_SYSTEM,
  TARGET_RESOLVER_SYSTEM,
  buildAnalyzerPrompt,
  buildPlannerPrompt,
  buildTargetResolverPrompt,
  buildVisualAnalyzerPrompt,
} = require("./prompts");
const { buildObservationPacket } = require("./context-packer");

const MAX_RECOVERY_ATTEMPTS = 2;
const DEFAULT_STEP_LIMIT = 5;
const MAX_GEMINI_503_RETRIES_PER_STEP = 3;
const GEMINI_503_BACKOFF_MS = 1500;
const MAX_GEMINI_503_RUN_PAUSES = 8;
const GEMINI_503_RUN_BACKOFF_BASE_MS = 15000;
const GEMINI_503_RUN_BACKOFF_MAX_MS = 300000;
const ESSENTIAL_RUN_EVENTS = new Set([
  "run_started",
  "block_planned",
  "action_target_model_resolved",
  "node_target_resolved",
  "action_start",
  "action_target_resolved",
  "page_snapshot",
  "page_graph_snapshot",
  "decision_trace",
  "outcome_trace",
  "block_finished",
  "analysis_dead_end_recovering",
  "thread_memory_plan_blocked",
  "gemini_503_retry_scheduled",
  "gemini_503_retry_exhausted",
  "gemini_503_run_paused",
  "gemini_503_run_resume_scheduled",
  "run_failed",
  "run_finished",
]);

function inferResponseLanguage(text) {
  const source = String(text || "");
  let cyrillicCount = 0;

  for (const character of source) {
    if (character >= "\u0400" && character <= "\u04FF") {
      cyrillicCount += 1;
      if (cyrillicCount >= 2) {
        return "ru";
      }
    }
  }

  return "en";
}

function resolveThreadMediaSelection(mediaAttachments, mediaRef) {
  const items = Array.isArray(mediaAttachments) ? mediaAttachments : [];
  const normalizedRef = String(mediaRef || "first_media").trim().toLowerCase();

  if (!items.length) {
    return [];
  }

  if (normalizedRef === "first_media") return [items[0]];
  if (normalizedRef === "first_image") {
    const match = items.find((item) => item.kind === "image");
    return match ? [match] : [];
  }
  if (normalizedRef === "first_video") {
    const match = items.find((item) => item.kind === "video");
    return match ? [match] : [];
  }
  if (normalizedRef === "all_media") return items;
  if (normalizedRef === "all_images") return items.filter((item) => item.kind === "image");
  if (normalizedRef === "all_videos") return items.filter((item) => item.kind === "video");
  if (normalizedRef.startsWith("media:")) {
    const mediaId = normalizedRef.slice("media:".length);
    const match = items.find((item) =>
      String(item.id || "").trim().toLowerCase() === mediaId ||
      String(item.fileName || "").trim().toLowerCase() === mediaId
    );
    return match ? [match] : [];
  }

  return [];
}

function localize(language, englishText, russianText) {
  return language === "ru" ? russianText : englishText;
}

function describeMessageMedia(message) {
  const attachments = Array.isArray(message?.meta?.attachments)
    ? message.meta.attachments
    : [];

  if (!attachments.length) {
    return "";
  }

  return attachments
    .map((item) => {
      const kind = String(item?.kind || "file").trim();
      const name = String(item?.fileName || item?.id || kind).trim();
      return `${kind}:${name}`;
    })
    .join(", ");
}

function buildPlanningFailureReport({
  language,
  plan,
  planResult,
  observation,
  stepMode,
  priorAnalysis,
  lastError,
  recoveryAttempts,
  retrievedShortcuts,
}) {
  const page = observation?.page || {};
  const candidateCount = Array.isArray(observation?.interactive) ? observation.interactive.length : 0;
  const plannerComment = String(plan?.comment || "").trim();
  const plannerGoal = String(plan?.blockGoal || "").trim();
  const priorReason = String(priorAnalysis?.failureReason || priorAnalysis?.outcomeReason || "").trim();
  const nextFocus = String(priorAnalysis?.nextFocus || "").trim();
  const details = [
    `page: ${page.title || "Untitled"} (${page.url || "unknown URL"})`,
    `mode: ${stepMode || "unknown"} / ${planResult?.contextLevel || "unknown"} / ${planResult?.retryMode || "unknown"}`,
    `visible candidates collected: ${candidateCount}`,
    `recovery attempts used: ${recoveryAttempts}`,
    `shortcuts offered: ${Array.isArray(retrievedShortcuts) ? retrievedShortcuts.length : 0}`,
    plannerComment ? `planner comment: ${plannerComment}` : "",
    plannerGoal ? `planner goal: ${plannerGoal}` : "",
    lastError ? `latest execution error: ${lastError}` : "",
    priorReason ? `previous analysis reason: ${priorReason}` : "",
    nextFocus ? `previous next focus: ${nextFocus}` : "",
  ].filter(Boolean);

  const heading = localize(
    language,
    "Planner stopped because it returned no executable browser actions.",
    "Планировщик остановился, потому что вернул ноль исполнимых браузерных действий.",
  );
  const guidance = localize(
    language,
    "This usually means the current observation did not expose a safe target, or the previous error made the planner avoid repeating the same target.",
    "Обычно это значит, что текущее наблюдение не дало безопасной цели, либо предыдущая ошибка заставила планировщик не повторять тот же target.",
  );

  return `${heading}\n${guidance}\n\n${details.join("\n")}`;
}

function recentThreadMessages(thread) {
  return thread.messages.slice(-6).map((message) => {
    const media = describeMessageMedia(message);
    return media
      ? `${message.role}: ${message.text} [media: ${media}]`
      : `${message.role}: ${message.text}`;
  });
}

function recentBlockSummaries(thread) {
  return thread.messages
    .filter((message) => message.kind === "block")
    .slice(-3)
    .map((message) => {
      const meta = message.meta || {};
      const actionPreview = Array.isArray(meta.actions)
        ? meta.actions.map((action) => `${action.status}:${action.label}`).join(", ")
        : "";
      return `cycle=${meta.cycle || "?"} status=${meta.status || "unknown"} goal=${meta.blockGoal || ""} actions=${actionPreview}`;
    });
}

function describeAction(action) {
  return (
    action.label ||
    action.note ||
    action.text ||
    action.query ||
    action.url ||
    action.type
  );
}

function emptyUsage() {
  return {
    promptTokens: 0,
    candidateTokens: 0,
    totalTokens: 0,
    thoughtsTokens: 0,
  };
}

function mergeUsage(...items) {
  return items.reduce(
    (accumulator, item) => ({
      promptTokens: accumulator.promptTokens + Number(item?.promptTokens || 0),
      candidateTokens: accumulator.candidateTokens + Number(item?.candidateTokens || 0),
      totalTokens: accumulator.totalTokens + Number(item?.totalTokens || 0),
      thoughtsTokens: accumulator.thoughtsTokens + Number(item?.thoughtsTokens || 0),
    }),
    emptyUsage(),
  );
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatRunStamp(date = new Date()) {
  return date.toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

function isGemini503Error(error) {
  return Number(error?.status || 0) === 503;
}

function gemini503RunBackoffMs(pauseCount) {
  const exponent = Math.max(0, Number(pauseCount || 1) - 1);
  return Math.min(GEMINI_503_RUN_BACKOFF_MAX_MS, GEMINI_503_RUN_BACKOFF_BASE_MS * (2 ** exponent));
}

function gemini503StepBackoffMs(attempt) {
  const exponent = Math.max(0, Number(attempt || 1) - 1);
  return Math.min(10000, GEMINI_503_BACKOFF_MS * (2 ** exponent));
}

function buildGemini503StopMessage(task) {
  const taskLabel = String(task || "step").trim() || "step";
  return `Gemini returned HTTP 503 three times during ${taskLabel}. Stopping this run to avoid hammering the API.`;
}

function buildGemini503PauseMessage(task, resumeAt) {
  const taskLabel = String(task || "step").trim() || "step";
  return `Gemini is overloaded during ${taskLabel}. I paused this run and will retry automatically at ${resumeAt}.`;
}

function collectUsedShortcuts(actions, retrievedShortcuts) {
  const shortcutMap = new Map((retrievedShortcuts || []).map((shortcut) => [shortcut.key, shortcut]));
  const keys = new Set();

  for (const action of actions || []) {
    if (action?.shortcutKey) {
      keys.add(action.shortcutKey);
    }
  }

  return [...keys].map((key) => shortcutMap.get(key) || { key });
}

function summarizeTraceAction(action) {
  return {
    type: String(action?.type || "").trim(),
    label: String(action?.label || "").trim(),
    elementId: String(action?.elementId || "").trim(),
    nodeId: String(action?.nodeId || "").trim(),
    targetRole: String(action?.targetRole || action?.accessibilityRole || action?.role || "").trim(),
    targetName: String(action?.targetName || action?.accessibilityName || action?.name || "").trim(),
    mediaRef: String(action?.mediaRef || "").trim(),
    url: String(action?.url || "").trim(),
    query: String(action?.query || "").trim(),
    targetReason: String(action?.targetReason || action?.note || "").trim().slice(0, 300),
  };
}

function summarizeTraceActionResult(action) {
  const resolved = action?.resolvedTarget || {};
  return {
    type: String(action?.type || "").trim(),
    label: String(action?.label || "").trim(),
    status: String(action?.status || "").trim(),
    errorCode: String(action?.errorCode || "").trim(),
    error: String(action?.error || "").trim().slice(0, 300),
    resolvedKind: String(resolved.kind || "").trim(),
    resolvedRole: String(resolved.role || "").trim(),
    resolvedName: String(resolved.visibleName || resolved.name || resolved.label || "").trim().slice(0, 160),
    uploadMethod: String(resolved.uploadMethod || "").trim(),
    mediaCount: Number(resolved.mediaCount || 0),
  };
}

function summarizeTraceObservation(observation) {
  return {
    title: String(observation?.page?.title || "").trim(),
    url: String(observation?.page?.url || "").trim(),
    interactiveCount: Array.isArray(observation?.interactive) ? observation.interactive.length : 0,
    graphCounts: observation?.pageGraph ? summarizeGraph(observation.pageGraph).counts : null,
    modality: observation?.pageGraph?.modality || null,
  };
}

function sanitizeShortcutKey(shortcutKey, retrievedShortcuts, logger, threadId, cycle) {
  const normalized = String(shortcutKey || "").trim();
  if (!normalized) {
    return "";
  }

  const allowed = new Set((retrievedShortcuts || []).map((shortcut) => shortcut.key));
  if (allowed.has(normalized)) {
    return normalized;
  }

  logger.warn("agent.service", "shortcut_key_rejected", {
    threadId,
    cycle,
    shortcutKey: normalized,
  });
  return "";
}

function compactText(value) {
  return String(value || "").trim().toLowerCase();
}

function serializeStructuredValue(value) {
  if (value == null) {
    return "";
  }

  if (typeof value === "string") {
    return value.trim();
  }

  try {
    const serialized = JSON.stringify(value);
    if (serialized && serialized !== "{}" && serialized !== "[]") {
      return serialized;
    }
  } catch {}

  return String(value).trim();
}

function normalizeMemoryEntry(entry) {
  if (!entry) {
    return null;
  }

  const kind = String(entry.kind || "").trim().toLowerCase() || "note";
  const action = String(entry.action || "").trim();
  const target = String(entry.target || entry.title || "").trim();
  const url = String(entry.url || "").trim();
  const host = String(entry.host || entry.domain || "").trim().toLowerCase() || "";
  const reason = String(entry.reason || "").trim();
  const summary = String(entry.summary || "").trim();

  if (!url && !target && !host && !summary && !reason && !action) {
    return null;
  }

  return {
    kind,
    action,
    target,
    url,
    host,
    reason,
    summary,
  };
}

function mergeThreadMemory(existing, additions) {
  const map = new Map();

  for (const item of [...(existing || []), ...(additions || [])]) {
    const normalized = normalizeMemoryEntry(item);
    if (!normalized) {
      continue;
    }
    const key = [
      normalized.kind,
      compactText(normalized.action),
      compactText(normalized.target),
      normalized.url,
      normalized.host,
      compactText(normalized.summary),
    ].join("|");
    map.set(key, normalized);
  }

  return [...map.values()].slice(-12);
}

function normalizeSessionMemoryEntry(entry) {
  if (!entry) {
    return null;
  }

  const key = String(entry.key || "").trim();
  const kind = String(entry.kind || "").trim().toLowerCase() || "note";
  const value = serializeStructuredValue(entry.value);
  const reason = String(entry.reason || "").trim();
  const importance = String(entry.importance || "").trim().toLowerCase() || "medium";
  const replace = Boolean(entry.replace);
  const identifiers = Array.isArray(entry.identifiers)
    ? entry.identifiers.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 12)
    : [];

  if (!key && !value) {
    return null;
  }

  return {
    key: key || `${kind}:${value.slice(0, 48)}`,
    kind,
    value,
    reason,
    importance,
    replace,
    identifiers,
  };
}

function mergeSessionMemory(existing, writes) {
  const next = Array.isArray(existing) ? [...existing] : [];

  for (const rawEntry of writes || []) {
    const entry = normalizeSessionMemoryEntry(rawEntry);
    if (!entry) {
      continue;
    }

    const index = next.findIndex((item) => item.key === entry.key);
    if (index === -1) {
      next.push(entry);
      continue;
    }

    if (entry.replace || !next[index].value) {
      next[index] = entry;
    } else {
      next[index] = {
        ...next[index],
        kind: entry.kind || next[index].kind,
        value: entry.value || next[index].value,
        reason: entry.reason || next[index].reason,
        importance: entry.importance || next[index].importance,
        identifiers: entry.identifiers?.length ? entry.identifiers : next[index].identifiers,
      };
    }
  }

  return next.slice(-24);
}

function normalizeJournalEntry(entry, cycle) {
  if (!entry) {
    return null;
  }

  const status = String(entry.status || "").trim().toLowerCase() || "partial";
  const actionSummary = String(entry.actionSummary || "").trim();
  const outcome = serializeStructuredValue(entry.outcome);
  const why = String(entry.why || "").trim();
  const nextGuidance = String(entry.nextGuidance || "").trim();
  const reusableData = serializeStructuredValue(entry.reusableData);
  const shouldAffectNextSteps = entry.shouldAffectNextSteps !== false;

  if (!actionSummary && !outcome && !why && !nextGuidance && !reusableData) {
    return null;
  }

  return {
    cycle,
    status,
    actionSummary,
    outcome,
    why,
    nextGuidance,
    reusableData,
    shouldAffectNextSteps,
  };
}

function mergeExecutionJournal(existing, additions, cycle) {
  const next = Array.isArray(existing) ? [...existing] : [];

  for (const item of additions || []) {
    const normalized = normalizeJournalEntry(item, cycle);
    if (!normalized) {
      continue;
    }
    next.push(normalized);
  }

  return next.slice(-40);
}

function summarizeActions(actionResults) {
  return (actionResults || [])
    .map((action) => `${action.type}:${action.status}:${action.label || ""}`.trim())
    .join(" | ");
}

function inferJournalEntriesFromAnalysis(analysis, observation, actionResults, blockError) {
  const entries = Array.isArray(analysis?.journalEntries) ? [...analysis.journalEntries] : [];
  const outcomeStatus = String(analysis?.outcomeStatus || "").trim().toLowerCase();
  const fallbackStatus = blockError
    ? "failure"
    : outcomeStatus || (analysis?.taskComplete ? "success" : "partial");

  entries.push({
    status: fallbackStatus,
    actionSummary: summarizeActions(actionResults),
    outcome: String(analysis?.comment || "").trim() || String(analysis?.progressSummary || "").trim(),
    why: blockError
      ? blockError
      : String(analysis?.outcomeReason || analysis?.failureReason || "").trim(),
    nextGuidance: String(analysis?.nextFocus || "").trim(),
    reusableData: String(analysis?.progressSummary || "").trim(),
    shouldAffectNextSteps: true,
  });

  return entries;
}

function inferSessionMemoryWrites(analysis, observation, userGoal, executedActions, blockError) {
  const writes = Array.isArray(analysis?.memoryWrites) ? [...analysis.memoryWrites] : [];
  const latestAction = executedActions?.length
    ? executedActions[executedActions.length - 1]
    : null;
  const latestIdentifiers = collectActionIdentifiers(latestAction, observation);
  const outcomeStatus = String(analysis?.outcomeStatus || "").trim().toLowerCase();
  const outcomeReason = String(analysis?.outcomeReason || analysis?.failureReason || analysis?.progressSummary || "").trim();
  const cannotContinue = Boolean(analysis?.cannotContinue);

  if (blockError) {
    writes.push({
      key: `failure:${latestAction?.type || "block"}`,
      kind: "failure",
      value: blockError,
      reason: "Execution failed and this may matter for later recovery.",
      importance: "high",
      identifiers: latestIdentifiers,
      replace: true,
    });
  }

  if (!blockError && ["bad", "failure", "dead_end"].includes(outcomeStatus) && cannotContinue) {
    writes.push({
      key: `avoid:${latestAction?.type || "block"}`,
      kind: "avoid",
      value: outcomeReason || "The previous step did not make usable progress.",
      reason: "High-priority failure memory that should influence later planning.",
      importance: "high",
      identifiers: latestIdentifiers,
      replace: true,
    });
  }

  if (
    latestAction?.type === "read_page" &&
    !writes.some((entry) => String(entry?.kind || "").trim().toLowerCase() === "content")
  ) {
    const snippet = String(observation?.bodyText || "").trim().slice(0, 1200);
    if (snippet) {
      writes.push({
        key: `page_content:${hostFromObservation(observation) || "page"}`,
        kind: "content",
        value: snippet,
        reason: "Page content read from the browser may be needed later in the same thread.",
        importance: "high",
        identifiers: collectObservationIdentifiers(observation),
        replace: true,
      });
    }
  }

  return writes;
}

function hostFromObservation(observation) {
  try {
    return new URL(String(observation?.page?.url || "")).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function collectObservationIdentifiers(observation) {
  return [
    observation?.page?.url,
    hostFromObservation(observation),
    observation?.page?.title,
  ]
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .slice(0, 8);
}

function collectActionIdentifiers(actionResult, observation) {
  const resolved = actionResult?.resolvedTarget || {};
  return [
    actionResult?.label,
    actionResult?.type,
    actionResult?.nodeId,
    resolved.url,
    resolved.elementId,
    resolved.text,
    resolved.label,
    resolved.placeholder,
    resolved.nearbyText,
    resolved.descriptor,
    observation?.page?.url,
    observation?.page?.title,
    hostFromObservation(observation),
  ]
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .slice(0, 12);
}

function inferThreadMemoryFromAnalysis(analysis, observation, executedActions, blockError) {
  const additions = [];
  const latestAction = executedActions?.length
    ? executedActions[executedActions.length - 1]
    : null;

  if (Array.isArray(analysis?.memoryEntries)) {
    additions.push(...analysis.memoryEntries);
  }

  if (Array.isArray(analysis?.rejectedTargets)) {
    additions.push(
      ...analysis.rejectedTargets.map((entry) => ({
        kind: "avoid",
        action: latestAction?.type || "",
        target: entry.title || "",
        url: entry.url || "",
        host: entry.host || entry.domain || "",
        reason: entry.reason || "",
        summary: entry.reason || "",
      })),
    );
  }

  const outcomeStatus = String(analysis?.outcomeStatus || analysis?.sourceStatus || "")
    .trim()
    .toLowerCase();
  const outcomeReason = String(analysis?.outcomeReason || analysis?.sourceReason || analysis?.progressSummary || "").trim();
  const cannotContinue = Boolean(analysis?.cannotContinue);

  if (outcomeStatus === "bad" && cannotContinue) {
    additions.push({
      kind: "avoid",
      action: latestAction?.type || "",
      target: observation?.page?.title || latestAction?.label || "",
      url: observation?.page?.url || "",
      host: hostFromObservation(observation),
      reason: outcomeReason,
      summary: outcomeReason,
    });
  } else if (!blockError && outcomeStatus === "good") {
    additions.push({
      kind: "success",
      action: latestAction?.type || "",
      target: observation?.page?.title || latestAction?.label || "",
      url: observation?.page?.url || "",
      host: hostFromObservation(observation),
      reason: outcomeReason,
      summary: outcomeReason || String(analysis?.progressSummary || "").trim(),
    });
  }

  if (blockError) {
    additions.push({
      kind: "failure",
      action: latestAction?.type || "",
      target: latestAction?.label || "",
      url: "",
      host: "",
      reason: blockError,
      summary: `Execution failed: ${blockError}`,
    });
  }

  return mergeThreadMemory([], additions);
}

function memoryEntryMatchesText(entry, value) {
  const source = compactText(value);
  if (!source) {
    return false;
  }

  const target = compactText(entry?.target);
  const host = compactText(entry?.host);
  const url = compactText(entry?.url);
  const summary = compactText(entry?.summary);

  return Boolean(
    (target && source.includes(target)) ||
      (host && source.includes(host)) ||
      (url && source.includes(url)) ||
      (summary && source.includes(summary)) ||
      (Array.isArray(entry?.identifiers) &&
        entry.identifiers.some((identifier) => {
          const normalized = compactText(identifier);
          return normalized && source.includes(normalized);
        })),
  );
}

function normalizeIdentifier(value) {
  return compactText(value);
}

function isStrongIdentifier(value) {
  const normalized = normalizeIdentifier(value);
  if (!normalized) {
    return false;
  }

  return (
    normalized.includes("atlas-") ||
    normalized.includes(" | ") ||
    normalized.includes("/") ||
    normalized.includes("?") ||
    normalized.length >= 24
  );
}

function collectPlannedActionIdentifiers(action) {
  const accessibleTarget = actionAccessibleTarget(action);
  return [
    action?.elementId,
    action?.nodeId,
    action?.url,
    accessibleTarget ? `${accessibleTarget.role} | ${accessibleTarget.name}` : "",
  ]
    .map(normalizeIdentifier)
    .filter(Boolean);
}

function actionElementId(action) {
  return String(action?.elementId || "").trim();
}

function actionNodeId(action) {
  return String(action?.nodeId || "").trim();
}

function actionAccessibleTarget(action) {
  const role = compactText(action?.targetRole || action?.accessibilityRole || action?.role);
  const name = String(action?.targetName || action?.accessibilityName || action?.name || "").trim();
  if (!role || !name) {
    return null;
  }
  return { role, name };
}

function targetModeForAction(action) {
  const type = compactText(action?.type);

  if (type === "insert" || type === "type_element") {
    return "text_input";
  }

  if (type === "upload_media") {
    return "upload";
  }

  if (type === "open_url" || type === "open_search") {
    return "navigation";
  }

  return "generic";
}

function actionNeedsModelTarget(action, observation = null) {
  const type = compactText(action?.type);

  if (["insert", "upload_media", "click_element", "type_element"].includes(type)) {
    if (type === "upload_media") {
      return false;
    }
    const elementId = actionElementId(action);
    const nodeId = actionNodeId(action);
    if (type === "click_element" && actionAccessibleTarget(action)) {
      return false;
    }
    if (!elementId && !nodeId) {
      return true;
    }
    if (!observation || !Array.isArray(observation.interactive)) {
      return false;
    }
    if (elementId && observation.interactive.some((element) => String(element?.id || "").trim() === elementId)) {
      return false;
    }
    if (nodeId && graphNodeById(observation.pageGraph, nodeId)) {
      return false;
    }
    return true;
  }

  return type === "click_by_text";
}

function applyResolvedTarget(action, resolution) {
  const elementId = String(resolution?.elementId || "").trim();
  const nodeId = String(resolution?.nodeId || "").trim();
  const targetReason = String(resolution?.targetReason || "").trim();
  const targetRole = compactText(resolution?.targetRole || resolution?.accessibilityRole || resolution?.role);
  const targetName = String(resolution?.targetName || resolution?.accessibilityName || resolution?.name || "").trim();
  const type = compactText(action?.type);

  if (!elementId && !nodeId && !(type === "click_element" && targetRole && targetName)) {
    return action;
  }

  if (type === "click_by_text") {
    return {
      ...action,
      type: "click_element",
      elementId,
      nodeId,
      targetReason,
      note: action.note || action.text || action.label || "",
    };
  }

  return {
    ...action,
    elementId,
    nodeId,
    targetReason,
    ...(targetRole && targetName ? { targetRole, targetName } : {}),
  };
}

function hasStrongIdentifierOverlap(entry, action) {
  const actionIdentifiers = collectPlannedActionIdentifiers(action);
  if (!actionIdentifiers.length) {
    return false;
  }

  const entryIdentifiers = Array.isArray(entry?.identifiers)
    ? entry.identifiers.map(normalizeIdentifier).filter(Boolean)
    : [];

  return entryIdentifiers.some(
    (identifier) => isStrongIdentifier(identifier) && actionIdentifiers.includes(identifier),
  );
}

function shouldAvoidShortcut(shortcut, threadMemory, sessionMemory) {
  const haystack = [
    shortcut?.targetHints?.visibleName,
    shortcut?.targetHints?.placeholder,
    shortcut?.targetHints?.nearbyText,
    shortcut?.targetHints?.label,
    shortcut?.targetHints?.href,
    shortcut?.targetHints?.text,
  ]
    .filter(Boolean)
    .join(" ");

  return (threadMemory || []).some(
    (entry) => String(entry?.kind || "").trim().toLowerCase() === "avoid" && memoryEntryMatchesText(entry, haystack),
  ) || (sessionMemory || []).some((entry) => {
    const kind = String(entry?.kind || "").trim().toLowerCase();
    const importance = String(entry?.importance || "").trim().toLowerCase();
    return (
      ["failure", "avoid"].includes(kind) &&
      importance === "high" &&
      memoryEntryMatchesText(entry, haystack)
    );
  });
}

function priorAnalysisAllowsRetry(priorAnalysis) {
  if (!priorAnalysis || priorAnalysis.cannotContinue !== false) {
    return false;
  }

  const status = compactText(priorAnalysis.outcomeStatus || priorAnalysis.sourceStatus);
  const nextFocus = compactText(priorAnalysis.nextFocus);
  const failureReason = compactText(priorAnalysis.failureReason);

  return Boolean(nextFocus && !failureReason && ["bad", "partial", "unclear"].includes(status));
}

function shouldAvoidAction(action, threadMemory, sessionMemory, planningContext = {}) {
  const actionType = compactText(action?.type);
  if (actionType === "click_element" && priorAnalysisAllowsRetry(planningContext.priorAnalysis)) {
    return false;
  }

  const haystack = [
    action?.url,
    action?.text,
    action?.note,
    action?.label,
    action?.inputHint,
  ]
    .filter(Boolean)
    .join(" ");

  return (threadMemory || []).some(
    (entry) =>
      String(entry?.kind || "").trim().toLowerCase() === "avoid" &&
      (!compactText(entry?.action) || compactText(entry?.action) === actionType) &&
      (hasStrongIdentifierOverlap(entry, action) || memoryEntryMatchesText(entry, haystack)),
  ) || (sessionMemory || []).some((entry) => {
    const kind = String(entry?.kind || "").trim().toLowerCase();
    const importance = String(entry?.importance || "").trim().toLowerCase();
    const entryAction = compactText(
      String(entry?.key || "").startsWith("avoid:") || String(entry?.key || "").startsWith("failure:")
        ? String(entry?.key || "").split(":").slice(1).join(":")
        : "",
    );

    return (
      ["failure", "avoid"].includes(kind) &&
      importance === "high" &&
      (!entryAction || entryAction === actionType) &&
      hasStrongIdentifierOverlap(entry, action)
    );
  });
}

function actionTypes(actions) {
  return (actions || []).map((action) => compactText(action?.type)).filter(Boolean);
}

function isOnlyScrollRead(actions) {
  const types = actionTypes(actions);
  return Boolean(types.length && types.every((type) => type === "scroll" || type === "read_page"));
}

function journalEntryMentionsScrollRead(entry) {
  const summary = compactText(
    [
      entry?.actionSummary,
      entry?.outcome,
      entry?.why,
      entry?.nextGuidance,
    ].join(" "),
  );
  return summary.includes("scroll") && summary.includes("read_page");
}

function recentScrollReadLoopCount(executionJournal) {
  let count = 0;
  const entries = Array.isArray(executionJournal) ? [...executionJournal].reverse() : [];
  for (const entry of entries.slice(0, 6)) {
    if (!journalEntryMentionsScrollRead(entry)) {
      break;
    }
    count += 1;
  }
  return count;
}

function shouldBlockScrollReadLoop(actions, executionJournal, priorAnalysis) {
  if (!isOnlyScrollRead(actions)) {
    return false;
  }
  if (recentScrollReadLoopCount(executionJournal) >= 2) {
    return true;
  }
  const nextFocus = compactText(priorAnalysis?.nextFocus);
  const outcomeReason = compactText(priorAnalysis?.outcomeReason || priorAnalysis?.failureReason);
  return (
    recentScrollReadLoopCount(executionJournal) >= 1 &&
    (nextFocus.includes("not visible") ||
      nextFocus.includes("не вид") ||
      outcomeReason.includes("not visible") ||
      outcomeReason.includes("не вид"))
  );
}

function detectShortcutMismatch({
  stepMode,
  analysis,
  preObservation,
  postObservation,
  usedShortcutKeys,
  blockError,
}) {
  if (!usedShortcutKeys.length || blockError || analysis.taskComplete || analysis.cannotContinue) {
    return false;
  }

  if (
    ["bad", "failure", "avoid"].includes(
      String(analysis?.outcomeStatus || analysis?.sourceStatus || "").trim().toLowerCase(),
    )
  ) {
    return true;
  }

  const preFlow = graphFlowSignature(preObservation);
  const postFlow = graphFlowSignature(postObservation);

  return stepMode !== "generic" && preFlow === postFlow;
}

async function planWithRetry({
  threadId,
  requestGemini,
  observation,
  userGoal,
  recentMessages,
  priorAnalysis,
  previousBlocks,
  lastError,
  recoveryAttempts,
  stepLimit,
  currentCycle,
  stepMode,
  shortcuts,
  threadMemory,
  sessionMemory,
  executionJournal,
  mediaAttachments,
}) {
  const compactPacket = buildObservationPacket(observation, {
    mode: stepMode,
    expanded: false,
  });
  let retryMode = "compact_first_pass";
  let result = await requestGemini(threadId, {
    task: "plan_block",
    systemInstruction: PLANNER_SYSTEM,
    prompt: buildPlannerPrompt({
      userGoal,
      observationPacket: compactPacket,
      recentMessages,
      priorAnalysis,
      previousBlocks,
      lastError,
      recoveryAttempts,
      stepLimit,
      currentCycle,
      shortcuts,
      threadMemory,
      sessionMemory,
      executionJournal,
      mediaAttachments,
      retryMode,
    }),
  });
  let planUsage = result.usage || emptyUsage();
  let plan = result.data;
  let contextLevel = compactPacket.contextLevel;

  if (!Array.isArray(plan?.actions) || !plan.actions.length) {
    const expandedPacket = buildObservationPacket(observation, {
      mode: stepMode,
      expanded: true,
    });
    retryMode = "expanded_retry_after_compact_miss";
    const retryResult = await requestGemini(threadId, {
      task: "plan_block",
      systemInstruction: PLANNER_SYSTEM,
      prompt: buildPlannerPrompt({
        userGoal,
        observationPacket: expandedPacket,
        recentMessages,
        priorAnalysis,
        previousBlocks,
        lastError,
        recoveryAttempts,
        stepLimit,
        currentCycle,
        shortcuts,
        threadMemory,
        sessionMemory,
        executionJournal,
        mediaAttachments,
        retryMode,
      }),
    });
    plan = retryResult.data;
    planUsage = mergeUsage(planUsage, retryResult.usage || emptyUsage());
    result = retryResult;
    contextLevel = expandedPacket.contextLevel;
  }

  return {
    contextLevel,
    plan,
    planUsage,
    retryMode,
  };
}

async function resolveActionTargetWithModel({
  threadId,
  requestGemini,
  observation,
  userGoal,
  action,
  recentMessages,
  lastError,
  logger,
}) {
  if (!actionNeedsModelTarget(action, observation)) {
    return action;
  }

  const packet = buildObservationPacket(observation, {
    mode: targetModeForAction(action),
    expanded: true,
  });
  const result = await requestGemini(threadId, {
    task: "resolve_target",
    systemInstruction: TARGET_RESOLVER_SYSTEM,
    prompt: buildTargetResolverPrompt({
      userGoal,
      observationPacket: packet,
      action,
      recentMessages,
      lastError,
    }),
  });
  const resolution = result.data || {};
  const resolvedElementId = String(resolution.elementId || "").trim();
  const resolvedNodeId = String(resolution.nodeId || "").trim();
  const resolvedTargetRole = compactText(
    resolution.targetRole || resolution.accessibilityRole || resolution.role,
  );
  const resolvedTargetName = String(
    resolution.targetName || resolution.accessibilityName || resolution.name || "",
  ).trim();
  const candidateIds = new Set(
    (packet.relevantElements || []).map((element) => String(element?.id || "").trim()).filter(Boolean),
  );

  if (!resolution.canResolve || (!resolvedElementId && !resolvedNodeId && !(resolvedTargetRole && resolvedTargetName))) {
    const error = new Error(
      String(resolution.targetReason || "").trim() ||
        `The model could not resolve a target for ${action?.type || "action"}.`,
    );
    error.name = "TargetResolutionError";
    error.code = "TARGET_UNRESOLVED";
    error.action = action;
    error.resolution = resolution;
    throw error;
  }

  if (resolvedElementId && !candidateIds.has(resolvedElementId) && !(resolvedTargetRole && resolvedTargetName)) {
    const error = new Error(`The model returned elementId "${resolvedElementId}", but it was not in the target candidates.`);
    error.name = "TargetResolutionError";
    error.code = "TARGET_NOT_IN_CANDIDATES";
    error.action = action;
    error.resolution = resolution;
    throw error;
  }

  if (resolvedNodeId && !graphNodeById(observation.pageGraph, resolvedNodeId)) {
    const error = new Error(`The model returned nodeId "${resolvedNodeId}", but it was not in the latest AgentPageGraph.`);
    error.name = "TargetResolutionError";
    error.code = "NODE_NOT_IN_GRAPH";
    error.action = action;
    error.resolution = resolution;
    throw error;
  }

  const safeResolution = {
    ...resolution,
    elementId: resolvedElementId && candidateIds.has(resolvedElementId) ? resolvedElementId : "",
    nodeId: resolvedNodeId,
  };
  const resolved = applyResolvedTarget(action, safeResolution);
  logger.event("agent.service", "action_target_model_resolved", {
    originalType: action?.type || "",
    resolvedType: resolved?.type || "",
    elementId: resolved.elementId || "",
    nodeId: resolved.nodeId || "",
    targetRole: resolved.targetRole || "",
    targetName: resolved.targetName || "",
    targetReason: resolved.targetReason || "",
    confidence: resolution.confidence || "",
  });
  return resolved;
}

function createAgentService({ env, logger, store, loadSettings, shortcutMemory, dashboardUrl }) {
  const gemini = createGeminiClient({
    apiKey: env.GEMINI_API_KEY || process.env.GEMINI_API_KEY,
    model: env.GEMINI_MODEL || process.env.GEMINI_MODEL || "gemini-2.5-flash",
    logger,
  });
  const runtimes = new Map();
  let sharedSessionPromise = null;

  async function ensureSharedSession() {
    if (sharedSessionPromise) {
      return sharedSessionPromise;
    }

    const userDataDir = path.join(
      process.cwd(),
      "runtime",
      "browser-profile",
      "chromium",
    );

    sharedSessionPromise = createAtlasSession({
      sessionName: "persistent-browser",
      headless: String(env.ATLAS_HEADLESS || "false") === "true",
      userDataDir,
      launchOptions: {
        args: [
          "--start-maximized",
          "--disable-blink-features=AutomationControlled",
        ],
      },
      contextOptions: {
        viewport: null,
        locale: "en-US",
        colorScheme: "dark",
      },
    });

    const session = await sharedSessionPromise;
    logger.event("agent.service", "persistent_session_ready", {
      userDataDir,
    });
    return session;
  }

  async function warmup() {
    const session = await ensureSharedSession();
    const pages = session.context.pages();
    const targetUrl = String(dashboardUrl || "").trim();

    const page = pages[0] || (await session.context.newPage());
    await session.attachToPage(page);

    try {
      if (targetUrl) {
        await page.goto(targetUrl, {
          waitUntil: "domcontentloaded",
        });
      }
      await page.bringToFront();
      logger.event("agent.service", "persistent_browser_dashboard_opened", {
        url: targetUrl || page.url(),
        pageCount: session.context.pages().length,
      });
    } catch (error) {
      logger.error("agent.service", "persistent_browser_warmup_failed", error);
    }

    return session;
  }

  async function ensureRuntime(threadId) {
    if (runtimes.has(threadId)) {
      return runtimes.get(threadId);
    }

    const session = await ensureSharedSession();
    const canvas = await session.newCanvas();
    const runtime = {
      session,
      canvas,
      lastObservation: {
        page: {
          url: "about:blank",
          title: "Blank",
        },
        bodyText: "",
        cleanedHtml: "",
        interactive: [],
        screenshotPath: "",
        pageGraph: null,
      },
      lastPageGraph: null,
      recoveryAttempts: 0,
      pendingGoals: [],
      running: false,
      stopRequested: false,
    };

    runtimes.set(threadId, runtime);
    return runtime;
  }

  function addAssistantMessage(threadId, kind, text, meta = {}) {
    return store.appendMessage(threadId, {
      role: "assistant",
      kind,
      text,
      meta,
    });
  }

  async function requestGemini(threadId, request, activeLogger = logger) {
    const task = String(request?.task || "").trim() || "unknown_task";

    for (let attempt = 1; attempt <= MAX_GEMINI_503_RETRIES_PER_STEP; attempt += 1) {
      const thread = store.getThread(threadId);
      const nextGeminiCount = (thread?.meta?.geminiRequestCount || 0) + 1;
      const modelOverride = thread?.meta?.selectedModel || undefined;

      try {
        const result = await gemini.requestJson({
          ...request,
          modelOverride,
        });
        const usage = result.usage || emptyUsage();
        store.updateMeta(threadId, {
          geminiRequestCount: nextGeminiCount,
          selectedModel: result.model || modelOverride || "",
          totalPromptTokens: Number(thread?.meta?.totalPromptTokens || 0) + usage.promptTokens,
          totalCandidateTokens: Number(thread?.meta?.totalCandidateTokens || 0) + usage.candidateTokens,
          totalTokens: Number(thread?.meta?.totalTokens || 0) + usage.totalTokens,
        });
        return result;
      } catch (error) {
        store.updateMeta(threadId, {
          geminiRequestCount: nextGeminiCount,
        });

        if (!isGemini503Error(error)) {
          throw error;
        }

        const details = {
          threadId,
          task,
          attempt,
          maxAttempts: MAX_GEMINI_503_RETRIES_PER_STEP,
          status: Number(error?.status || 0),
        };

        if (attempt >= MAX_GEMINI_503_RETRIES_PER_STEP) {
          const finalError = new Error(buildGemini503StopMessage(task));
          finalError.name = "Gemini503RetryLimitError";
          finalError.task = task;
          finalError.status = 503;
          finalError.cause = error;
          activeLogger.error("agent.service", "gemini_503_retry_exhausted", finalError, details);
          throw finalError;
        }

        const retryInMs = gemini503StepBackoffMs(attempt);
        activeLogger.warn("agent.service", "gemini_503_retry_scheduled", {
          ...details,
          retryInMs,
        });
        await wait(retryInMs);
      }
    }

    throw new Error(buildGemini503StopMessage(task));
  }

  async function observe(threadId, runtime, activeLogger = logger, options = {}) {
    const observation = await captureObservation({
      canvas: runtime.canvas,
      threadId,
      rootDir: path.join(process.cwd(), "logs"),
      logger: activeLogger,
      captureScreenshot: Boolean(options.captureScreenshot),
    });
    const pageGraph = await observePageGraph({
      canvas: runtime.canvas,
      threadId,
      logger: activeLogger,
      screenshotPath: observation.screenshotPath || "",
    });
    observation.pageGraph = pageGraph;
    runtime.lastObservation = observation;
    runtime.lastPageGraph = pageGraph;
    store.updateMeta(threadId, {
      lastKnownUrl: observation.page.url,
      lastKnownTitle: observation.page.title,
      lastPageGraphSummary: summarizeGraph(pageGraph),
    });
    return observation;
  }

  function appendBlockMessage(threadId, payload) {
    return addAssistantMessage(threadId, "block", payload.comment, payload);
  }

  function shouldStop(runtime) {
    return runtime.stopRequested;
  }

  async function runLoop(threadId, userGoal) {
    const runtime = await ensureRuntime(threadId);
    const responseLanguage = inferResponseLanguage(userGoal);
    const threadConfig = store.getThread(threadId)?.meta || {};
    const stepLimit = Math.max(1, Math.min(12, Number(threadConfig.stepLimit || DEFAULT_STEP_LIMIT)));

    if (runtime.running) {
      runtime.pendingGoals.push(userGoal);
      logger.event("agent.service", "goal_queued_while_running", {
        threadId,
        pendingCount: runtime.pendingGoals.length,
      });
      return;
    }

    runtime.running = true;
    runtime.stopRequested = false;
    runtime.recoveryAttempts = 0;
    const runId = `run-${threadId}-${Date.now().toString(36)}`;
    const runLogger = logger.fork({
      filePath: path.join(process.cwd(), "logs", `${runId}-${formatRunStamp()}.jsonl`),
      bindings: {
        threadId,
        runId,
      },
      shouldWrite(entry) {
        return entry.level !== "info" || ESSENTIAL_RUN_EVENTS.has(String(entry.event || "").trim());
      },
    });
    store.setStatus(threadId, "running");
    runLogger.event("agent.service", "run_started", {
      userGoal,
    });
    let gemini503ResumeDelayMs = 0;
    const threadAtStart = store.getThread(threadId);
    const preservedSessionMemory = (threadAtStart?.meta?.sessionMemory || []).filter((entry) => {
      const key = String(entry?.key || "").trim();
      return key !== "publish_policy_default_text" && key !== "publish_text_seed";
    });
    const initialSessionMemory = mergeSessionMemory(preservedSessionMemory, [
      {
        key: "user_goal",
        kind: "fact",
        value: userGoal,
        reason: "Primary thread objective. Every step should stay aligned with this goal.",
        importance: "high",
        replace: true,
      },
      {
        key: "execution_policy_autonomy",
        kind: "constraint",
        value:
          "Operate fully autonomously. Never wait for user input, approval, confirmation, caption, or follow-up. Finish the task with the information already present in the thread.",
        reason: "The agent must continue execution without delegating missing decisions back to the user.",
        importance: "high",
        replace: true,
      },
      {
        key: "request_truth_policy",
        kind: "constraint",
        value:
          "The user request is the source of truth for the task. Treat it as an execution instruction, not as public-facing text to paste into websites unless the user explicitly asked to publish that exact text.",
        reason: "The agent must keep a strict boundary between operator intent and content entered into public UI fields.",
        importance: "high",
        replace: true,
      },
      {
        key: "thread_media_capability",
        kind: "constraint",
        value:
          "Attached thread media are real assets available for upload. upload_media is a native clipboard-paste file delivery capability. If the goal refers to this photo, this image, this video, this file, or this media, use the attached media as the payload.",
        reason: "The agent should understand and trust its own media-handling capability.",
        importance: "high",
        replace: true,
      },
      {
        key: "publish_text_boundary",
        kind: "constraint",
        value:
          "For social posting and upload flows, never invent, rewrite, summarize, or derive public-facing publish text. Do not paste the task instruction into the composer. If the user did not explicitly provide publish text, keep the composer text empty and publish only the requested media when the platform allows it.",
        reason: "Prevents semantic corruption where operational instructions are treated as post content.",
        importance: "high",
        replace: true,
      },
      {
        key: "picker_ban_policy",
        kind: "constraint",
        value:
          "Manual picker handling is forbidden. Never plan around OS file dialogs, filesystem browsing, gallery/library/media-manager detours, upload-button picker flows, or extra asset surfaces. For attachment steps, use upload_media when the relevant composer/post/message surface is active; elementId is optional because runtime delivery is clipboard paste only.",
        reason: "The agent must avoid hanging in manual picker flows while still trusting the runtime uploader.",
        importance: "high",
        replace: true,
      },
      {
        key: "upload_flow_short_path",
        kind: "constraint",
        value:
          "During publish flows, prefer the shortest in-composer media paste path. Use upload_media as soon as the relevant composer/post/message surface is open; do not search for file-type-specific PDF/image/video upload places. Do not open redundant gallery, add-media, album, upload-button picker, or library surfaces when a usable paste surface already exists or when attached media is already visible in the composer.",
        reason: "Planner should avoid unnecessary upload detours and proceed toward final publish once media is attached.",
        importance: "high",
        replace: true,
      },
    ]);
    store.updateMeta(threadId, {
      cycleCount: 0,
      geminiRequestCount: 0,
      responseLanguage,
      lastRunError: "",
      sessionMemory: initialSessionMemory,
    });

    try {
      let priorAnalysis = null;
      let lastError = "";

      for (let cycle = 1; cycle <= stepLimit; cycle += 1) {
        if (shouldStop(runtime)) {
          addAssistantMessage(
            threadId,
            "report",
            localize(responseLanguage, "Stopping this thread now.", "Останавливаю этот тред."),
            {
              phase: "stopped",
              cycle,
            },
          );
          break;
        }

        store.updateMeta(threadId, {
          cycleCount: cycle,
        });

        const thread = store.getThread(threadId);
        const observation = runtime.lastObservation || (await observe(threadId, runtime, runLogger));
        const previousBlocks = recentBlockSummaries(thread);
        const recentMessages = recentThreadMessages(thread);
        const threadMemory = Array.isArray(thread.meta?.threadMemory)
          ? thread.meta.threadMemory
          : [];
        const sessionMemory = Array.isArray(thread.meta?.sessionMemory)
          ? thread.meta.sessionMemory
          : [];
        const executionJournal = Array.isArray(thread.meta?.executionJournal)
          ? thread.meta.executionJournal
          : [];
        const mediaAttachments = Array.isArray(thread.meta?.mediaAttachments)
          ? thread.meta.mediaAttachments
          : [];
        const stepMode = inferGraphStepMode({
          userGoal,
          priorAnalysis,
          observation,
        });
        const retrievedShortcuts = shortcutMemory
          ? shortcutMemory
              .retrieve({
                observation,
                actionFamily: stepMode,
              })
              .filter((shortcut) => !shouldAvoidShortcut(shortcut, threadMemory, sessionMemory))
          : [];

        let planResult = await planWithRetry({
          threadId,
          requestGemini: (targetThreadId, request) => requestGemini(targetThreadId, request, runLogger),
          observation,
          userGoal,
          recentMessages,
          priorAnalysis,
          previousBlocks,
          lastError,
          recoveryAttempts: runtime.recoveryAttempts,
          stepLimit,
          currentCycle: cycle,
          stepMode,
          shortcuts: retrievedShortcuts,
          threadMemory,
          sessionMemory,
          executionJournal,
          mediaAttachments,
        });
        let plan = planResult.plan;
        let planUsage = planResult.planUsage || emptyUsage();
        let actions = (Array.isArray(plan.actions) ? plan.actions.slice(0, 3) : []).map((action) => ({
          ...action,
          shortcutKey: sanitizeShortcutKey(
            action.shortcutKey,
            retrievedShortcuts,
            runLogger,
            threadId,
            cycle,
          ),
        }));

        if (shouldBlockScrollReadLoop(actions, executionJournal, priorAnalysis)) {
          runLogger.warn("agent.service", "scroll_read_loop_blocked", {
            threadId,
            cycle,
            actions,
            recentScrollReadLoopCount: recentScrollReadLoopCount(executionJournal),
            priorAnalysis,
          });
          lastError =
            "Repeated scroll+read_page did not make progress. Do not keep scrolling to search for the same thing; choose a concrete visible target, a non-scroll recovery action, or report the blocker.";
          const scrollLoopRetry = await planWithRetry({
            threadId,
            requestGemini: (targetThreadId, request) => requestGemini(targetThreadId, request, runLogger),
            observation,
            userGoal,
            recentMessages,
            priorAnalysis,
            previousBlocks,
            lastError,
            recoveryAttempts: runtime.recoveryAttempts,
            stepLimit,
            currentCycle: cycle,
            stepMode,
            shortcuts: [],
            threadMemory,
            sessionMemory,
            executionJournal,
            mediaAttachments,
          });
          planResult = scrollLoopRetry;
          plan = scrollLoopRetry.plan || plan;
          planUsage = mergeUsage(planUsage, scrollLoopRetry.planUsage || emptyUsage());
          actions = (Array.isArray(plan.actions) ? plan.actions.slice(0, 3) : [])
            .map((action) => ({
              ...action,
              shortcutKey: "",
            }));
          if (shouldBlockScrollReadLoop(actions, executionJournal, priorAnalysis)) {
            actions = [];
            lastError =
              "Planner repeated scroll+read_page after repeated no-progress scroll attempts. Stopping instead of looping.";
          }
        }

        if (actions.some((action) => shouldAvoidAction(action, threadMemory, sessionMemory, { priorAnalysis }))) {
          runLogger.warn("agent.service", "thread_memory_plan_blocked", {
            threadId,
            cycle,
            threadMemory,
            sessionMemory,
            actions,
          });
          lastError = "Thread memory blocked a repeated dead end. Pick a different path.";
          const guardedRetry = await planWithRetry({
            threadId,
            requestGemini: (targetThreadId, request) => requestGemini(targetThreadId, request, runLogger),
            observation,
            userGoal,
            recentMessages,
            priorAnalysis,
            previousBlocks,
            lastError,
            recoveryAttempts: runtime.recoveryAttempts,
            stepLimit,
            currentCycle: cycle,
            stepMode,
            shortcuts: retrievedShortcuts,
            threadMemory,
            sessionMemory,
            executionJournal,
            mediaAttachments,
          });
          planResult = guardedRetry;
          plan = guardedRetry.plan || plan;
          planUsage = mergeUsage(planUsage, guardedRetry.planUsage || emptyUsage());
          actions = (Array.isArray(plan.actions) ? plan.actions.slice(0, 3) : [])
            .map((action) => ({
              ...action,
              shortcutKey: sanitizeShortcutKey(
                action.shortcutKey,
                retrievedShortcuts,
                runLogger,
                threadId,
                cycle,
              ),
            }))
            .filter((action) => !shouldAvoidAction(action, threadMemory, sessionMemory, { priorAnalysis }));

          if (!actions.length) {
            lastError =
              "The previous retry repeated blocked targets. Choose a materially different recovery action; do not return an empty plan unless no browser recovery is possible.";
            const recoveryRetry = await planWithRetry({
              threadId,
              requestGemini: (targetThreadId, request) => requestGemini(targetThreadId, request, runLogger),
              observation,
              userGoal,
              recentMessages,
              priorAnalysis,
              previousBlocks,
              lastError,
              recoveryAttempts: runtime.recoveryAttempts,
              stepLimit,
              currentCycle: cycle,
              stepMode,
              shortcuts: [],
              threadMemory,
              sessionMemory,
              executionJournal,
              mediaAttachments,
            });
            planResult = recoveryRetry;
            plan = recoveryRetry.plan || plan;
            planUsage = mergeUsage(planUsage, recoveryRetry.planUsage || emptyUsage());
            actions = (Array.isArray(plan.actions) ? plan.actions.slice(0, 3) : [])
              .map((action) => ({
                ...action,
                shortcutKey: "",
              }))
              .filter((action) => !shouldAvoidAction(action, threadMemory, sessionMemory, { priorAnalysis }));
          }
        }

        runLogger.event("agent.service", "block_planned", {
          threadId,
          cycle,
          comment: plan.comment || "",
          stepMode,
          contextLevel: planResult.contextLevel,
          retrievedShortcutKeys: retrievedShortcuts.map((shortcut) => shortcut.key),
          actions,
        });
        runLogger.event("agent.service", "decision_trace", {
          threadId,
          cycle,
          phase: "planned",
          page: summarizeTraceObservation(observation),
          stepMode,
          contextLevel: planResult.contextLevel,
          retryMode: planResult.retryMode,
          comment: String(plan.comment || "").trim(),
          goal: String(plan.blockGoal || "").trim(),
          why: String(plan.reason || plan.targetReason || "").trim().slice(0, 500),
          actions: actions.map(summarizeTraceAction),
          shortcutKeys: retrievedShortcuts.map((shortcut) => shortcut.key).slice(0, 6),
        });

        if (!actions.length) {
          const failureReport = buildPlanningFailureReport({
            language: responseLanguage,
            plan,
            planResult,
            observation,
            stepMode,
            priorAnalysis,
            lastError,
            recoveryAttempts: runtime.recoveryAttempts,
            retrievedShortcuts,
          });
          store.updateMeta(threadId, {
            lastRunError: failureReport,
          });
          addAssistantMessage(
            threadId,
            "error",
            failureReport,
            {
              cycle,
              phase: "plan",
              plan,
              planningMode: stepMode,
              plannerContextLevel: planResult.contextLevel,
              plannerRetryMode: planResult.retryMode,
              observationSummary: {
                page: observation.page,
                interactiveCount: Array.isArray(observation.interactive) ? observation.interactive.length : 0,
                pageSemantics: observation.pageSemantics || {},
              },
              priorAnalysis,
              lastError,
              recoveryAttempts: runtime.recoveryAttempts,
            },
          );
          break;
        }

        const actionResults = [];
        let blockError = "";
        const successfulActionMemories = [];

        for (const action of actions) {
          if (shouldStop(runtime)) {
            blockError = localize(responseLanguage, "Stopped by user.", "Остановлено пользователем.");
            break;
          }

          const observationBeforeAction = runtime.lastObservation || observation;
          const graphBeforeAction = observationBeforeAction.pageGraph || runtime.lastPageGraph || null;
          let executableAction = action;
          const actionResult = {
            type: action.type,
            label: describeAction(action),
            status: "completed",
            shortcutKey: action.shortcutKey || "",
          };

          try {
            executableAction = await resolveActionTargetWithModel({
              threadId,
              requestGemini: (targetThreadId, request) => requestGemini(targetThreadId, request, runLogger),
              observation: observationBeforeAction,
              userGoal,
              action,
              recentMessages: recentThreadMessages(store.getThread(threadId)),
              lastError,
              logger: runLogger,
            });
            executableAction = resolveNodeActionTarget(
              executableAction,
              observationBeforeAction,
              {
                logger: runLogger,
                threadId,
                cycle,
              },
            );
            actionResult.type = executableAction.type;
            actionResult.label = describeAction(executableAction);
            actionResult.targetReason = executableAction.targetReason || "";
            actionResult.resolvedByModel = executableAction !== action;
            actionResult.nodeId = executableAction.resolvedNodeId || executableAction.nodeId || "";

            const executionResult = await executeAction({
              action: {
                ...executableAction,
                resolveMediaSelection: (mediaRef) =>
                  resolveThreadMediaSelection(mediaAttachments, mediaRef),
              },
              canvas: runtime.canvas,
              observation: runtime.lastObservation,
              logger: runLogger,
            });
            if (executionResult?.resolvedTarget) {
              actionResult.resolvedTarget = executionResult.resolvedTarget;
              if (Array.isArray(executionResult.resolvedTarget.usedMedia)) {
                actionResult.usedMedia = executionResult.resolvedTarget.usedMedia;
              }
              successfulActionMemories.push({
                action: executableAction,
                observationBeforeAction,
                resolvedTarget: executionResult.resolvedTarget,
              });
            }
            const afterActionObservation = await observe(threadId, runtime, runLogger);
            if (graphBeforeAction && afterActionObservation.pageGraph) {
              actionResult.graphDiff = diffPageGraphs(graphBeforeAction, afterActionObservation.pageGraph);
              runLogger.event("agent.service", "page_graph_diff", {
                threadId,
                cycle,
                actionType: actionResult.type,
                label: actionResult.label || "",
                diff: actionResult.graphDiff,
              });
            }
          } catch (error) {
            blockError = error instanceof Error ? error.message : String(error);
            actionResult.status = "failed";
            actionResult.error = blockError;
            if (error?.code) {
              actionResult.errorCode = error.code;
            }
            if (error?.nodeId) {
              actionResult.nodeId = error.nodeId;
            }
            store.updateMeta(threadId, {
              lastRunError: blockError,
            });
          }

          actionResults.push(actionResult);

          if (blockError) {
            break;
          }
        }

        if (shouldStop(runtime) && !blockError) {
          blockError = localize(responseLanguage, "Stopped by user.", "Остановлено пользователем.");
        }

        const analyzedObservation = await observe(threadId, runtime, runLogger);
        const blockGraphDiff = observation.pageGraph && analyzedObservation.pageGraph
          ? diffPageGraphs(observation.pageGraph, analyzedObservation.pageGraph)
          : null;
        const analyzerPacket = buildObservationPacket(analyzedObservation, {
          mode: inferGraphStepMode({
            userGoal,
            priorAnalysis,
            observation: analyzedObservation,
            executedActions: actionResults,
          }),
          expanded: false,
        });
        const usedShortcuts = collectUsedShortcuts(actions, retrievedShortcuts);
        let analysisResult = await requestGemini(threadId, {
          task: "analyze_block",
          systemInstruction: ANALYZER_SYSTEM,
          prompt: buildAnalyzerPrompt({
            userGoal,
            observationPacket: analyzerPacket,
            executedActions: actionResults,
            graphDiff: blockGraphDiff,
            recentMessages: recentThreadMessages(store.getThread(threadId)),
            blockComment: plan.comment || "",
            blockError,
            usedShortcuts,
            stepMode,
            threadMemory,
            sessionMemory,
            executionJournal,
            mediaAttachments,
            retryMode: planResult.retryMode,
          }),
        }, runLogger);
        let analysis = analysisResult.data;
        let analysisUsage = analysisResult.usage || emptyUsage();
        let visualUsage = emptyUsage();

        if (analysis.needsVisualFallback) {
          const visualObservation = analyzedObservation.screenshotPath
            ? analyzedObservation
            : await observe(threadId, runtime, runLogger, { captureScreenshot: true });
          if (visualObservation.screenshotPath) {
            const visualResult = await requestGemini(threadId, {
              task: "analyze_visual_fallback",
              systemInstruction: ANALYZER_SYSTEM,
              prompt: buildVisualAnalyzerPrompt({
                userGoal,
                executedActions: actionResults,
                recentMessages: recentThreadMessages(store.getThread(threadId)),
                blockError,
                usedShortcuts,
                threadMemory,
                sessionMemory,
                executionJournal,
                mediaAttachments,
              }),
              imagePath: visualObservation.screenshotPath,
            }, runLogger);
            analysis = visualResult.data;
            visualUsage = visualResult.usage || emptyUsage();
          } else {
            runLogger.warn("agent.service", "visual_fallback_skipped_no_screenshot", {
              threadId,
            });
          }
        }

        const usedShortcutKeys = actions
          .map((action) => String(action.shortcutKey || "").trim())
          .filter(Boolean);
        const shortcutMismatch = detectShortcutMismatch({
          stepMode,
          analysis,
          preObservation: observation,
          postObservation: analyzedObservation,
          usedShortcutKeys,
          blockError,
        });

        if (shortcutMemory && usedShortcutKeys.length) {
          for (const key of usedShortcutKeys) {
            shortcutMemory.markRecipeResult({
              key,
              success:
                !shortcutMismatch &&
                !blockError &&
                !["bad", "failure", "avoid"].includes(
                  String(analysis?.outcomeStatus || analysis?.sourceStatus || "").trim().toLowerCase(),
                ),
            });
          }
        }

        const journalDelta = inferJournalEntriesFromAnalysis(
          analysis,
          analyzedObservation,
          actionResults,
          blockError,
        );
        const nextThreadMemory = mergeThreadMemory(
          threadMemory,
          inferThreadMemoryFromAnalysis(analysis, analyzedObservation, actionResults, blockError),
        );
        const nextSessionMemory = mergeSessionMemory(
          sessionMemory,
          inferSessionMemoryWrites(analysis, analyzedObservation, userGoal, actionResults, blockError),
        );
        const nextExecutionJournal = mergeExecutionJournal(
          executionJournal,
          journalDelta,
          cycle,
        );
        if (JSON.stringify(nextThreadMemory) !== JSON.stringify(threadMemory)) {
          runLogger.event("agent.service", "thread_memory_updated", {
            threadId,
            cycle,
            threadMemory: nextThreadMemory,
          });
          store.updateMeta(threadId, {
            threadMemory: nextThreadMemory,
          });
        }
        if (JSON.stringify(nextSessionMemory) !== JSON.stringify(sessionMemory)) {
          runLogger.event("agent.service", "session_memory_updated", {
            threadId,
            cycle,
            sessionMemory: nextSessionMemory,
          });
          store.updateMeta(threadId, {
            sessionMemory: nextSessionMemory,
          });
        }
        if (JSON.stringify(nextExecutionJournal) !== JSON.stringify(executionJournal)) {
          runLogger.event("agent.service", "execution_journal_updated", {
            threadId,
            cycle,
            executionJournal: nextExecutionJournal,
          });
          store.updateMeta(threadId, {
            executionJournal: nextExecutionJournal,
          });
        }

        const learnedShortcuts = [];
        if (shortcutMemory && !blockError && !shortcutMismatch) {
          for (const entry of successfulActionMemories) {
            if (entry.action.shortcutKey) {
              continue;
            }
            const learned = shortcutMemory.upsertFromAction({
              observation: entry.observationBeforeAction,
              action: entry.action,
              resolvedTarget: entry.resolvedTarget,
            });
            if (learned) {
              learnedShortcuts.push(learned);
            }
          }
        }

        const blockUsage = mergeUsage(planUsage, analysisUsage, visualUsage);

        const blockStatus = blockError ? "failed" : "completed";
        appendBlockMessage(threadId, {
          cycle,
          kind: "block",
          status: blockStatus,
          comment:
            plan.comment ||
            localize(
              responseLanguage,
              "Working on the next browser block.",
              "Работаю над следующим логическим блоком в браузере.",
            ),
          blockGoal: plan.blockGoal || "",
          actions: actionResults,
          analysisComment: analysis.comment || "",
          nextFocus: analysis.nextFocus || "",
          errorReason: blockError || analysis.failureReason || "",
          planningMode: stepMode,
          plannerContextLevel: planResult.contextLevel,
          plannerRetryMode: planResult.retryMode,
          usedShortcuts,
          shortcutMismatch,
          learnedShortcuts,
          executionJournalDelta: journalDelta,
          usage: {
            plan: planUsage,
            analyze: analysisUsage,
            visualFallback: visualUsage,
            total: blockUsage,
          },
        });

        runLogger.event("agent.service", "block_finished", {
          threadId,
          cycle,
          status: blockStatus,
          errorReason: blockError || "",
          nextFocus: analysis.nextFocus || "",
          planningMode: stepMode,
          usedShortcuts: usedShortcutKeys,
          shortcutMismatch,
          usage: blockUsage,
        });
        runLogger.event("agent.service", "outcome_trace", {
          threadId,
          cycle,
          phase: "analyzed",
          status: blockStatus,
          page: summarizeTraceObservation(analyzedObservation),
          actions: actionResults.map(summarizeTraceActionResult),
          analysis: {
            status: String(analysis?.outcomeStatus || analysis?.sourceStatus || "").trim(),
            comment: String(analysis?.comment || "").trim().slice(0, 500),
            failureReason: String(analysis?.failureReason || "").trim().slice(0, 500),
            nextFocus: String(analysis?.nextFocus || "").trim().slice(0, 500),
            taskComplete: Boolean(analysis?.taskComplete),
            needsVisualFallback: Boolean(analysis?.needsVisualFallback),
          },
          journalDelta: journalDelta.map((entry) => ({
            status: String(entry.status || "").trim(),
            outcome: String(entry.outcome || "").trim().slice(0, 300),
            why: String(entry.why || "").trim().slice(0, 300),
            nextGuidance: String(entry.nextGuidance || "").trim().slice(0, 300),
          })),
          usage: blockUsage,
        });

        if (analysis.taskComplete) {
          store.updateMeta(threadId, {
            lastRunError: "",
          });
          addAssistantMessage(
            threadId,
            "report",
            localize(
              responseLanguage,
              "Done. The browser task looks complete.",
              "Готово. Похоже, браузерная задача завершена.",
            ),
            {
              cycle,
              phase: "done",
            },
          );
          break;
        }

        if (analysis.cannotContinue) {
          runtime.recoveryAttempts += 1;
          lastError =
            analysis.failureReason ||
            localize(
              responseLanguage,
              "The last page state was a dead end. Try a different recovery strategy.",
              "Последнее состояние страницы оказалось тупиком. Нужна другая стратегия восстановления.",
            );
          runLogger.warn("agent.service", "analysis_dead_end_recovering", {
            threadId,
            cycle,
            recoveryAttempts: runtime.recoveryAttempts,
            failureReason: lastError,
            nextFocus: analysis.nextFocus || "",
          });
          store.updateMeta(threadId, {
            lastRunError: lastError,
          });
          continue;
        }

        if (blockError) {
          runtime.recoveryAttempts += 1;
          lastError = blockError;

          if (runtime.recoveryAttempts >= MAX_RECOVERY_ATTEMPTS) {
            const recoveryReport = [
              analysis.failureReason ||
                localize(
                  responseLanguage,
                  "Recovery limit reached after repeated failures.",
                  "Достигнут лимит восстановления после повторных ошибок.",
                ),
              "",
              blockError ? `execution error: ${blockError}` : "",
              analysis.outcomeReason ? `analysis reason: ${analysis.outcomeReason}` : "",
              analysis.nextFocus ? `next focus was: ${analysis.nextFocus}` : "",
            ].filter(Boolean).join("\n");
            store.updateMeta(threadId, {
              lastRunError: recoveryReport,
            });
            addAssistantMessage(
              threadId,
              "error",
              recoveryReport,
              {
                cycle,
                phase: "recovery_failed",
                attemptsUsed: runtime.recoveryAttempts,
                blockError,
                analysis,
              },
            );
            break;
          }
        } else {
          runtime.recoveryAttempts = 0;
          lastError = "";
          store.updateMeta(threadId, {
            lastRunError: "",
          });
        }

        priorAnalysis = analysis;
      }
    } catch (error) {
      if (isGemini503Error(error)) {
        const latestThread = store.getThread(threadId);
        const pauseCount = Number(latestThread?.meta?.gemini503RunPauseCount || 0) + 1;
        gemini503ResumeDelayMs = gemini503RunBackoffMs(pauseCount);
        const resumeAt = new Date(Date.now() + gemini503ResumeDelayMs).toISOString();
        const task = String(error?.task || error?.cause?.task || "LLM request").trim();
        const pauseMessage = pauseCount > MAX_GEMINI_503_RUN_PAUSES
          ? buildGemini503StopMessage(task)
          : buildGemini503PauseMessage(task, resumeAt);

        store.updateMeta(threadId, {
          gemini503RunPauseCount: pauseCount,
          gemini503ResumeAt: pauseCount > MAX_GEMINI_503_RUN_PAUSES ? "" : resumeAt,
          lastRunError: pauseMessage,
        });

        runLogger.warn("agent.service", "gemini_503_run_paused", {
          threadId,
          task,
          pauseCount,
          maxPauses: MAX_GEMINI_503_RUN_PAUSES,
          resumeInMs: gemini503ResumeDelayMs,
          resumeAt,
        });

        addAssistantMessage(
          threadId,
          pauseCount > MAX_GEMINI_503_RUN_PAUSES ? "error" : "block",
          pauseMessage,
          {
            phase: pauseCount > MAX_GEMINI_503_RUN_PAUSES ? "gemini_503_exhausted" : "gemini_503_backoff",
            status: pauseCount > MAX_GEMINI_503_RUN_PAUSES ? "failed" : "paused",
            task,
            pauseCount,
            maxPauses: MAX_GEMINI_503_RUN_PAUSES,
            resumeAt: pauseCount > MAX_GEMINI_503_RUN_PAUSES ? "" : resumeAt,
          },
        );

        if (pauseCount > MAX_GEMINI_503_RUN_PAUSES) {
          gemini503ResumeDelayMs = 0;
        }
      } else {
        runLogger.error("agent.service", "run_failed", error, {
          threadId,
        });
        addAssistantMessage(
          threadId,
          "error",
          localize(
            responseLanguage,
            error instanceof Error ? error.message : String(error),
            error instanceof Error ? error.message : String(error),
          ),
        );
      }
    } finally {
      runtime.stopRequested = false;
      runtime.running = false;
      const shouldResumeAfter503 = gemini503ResumeDelayMs > 0;
      store.setStatus(threadId, shouldResumeAfter503 ? "submitted" : "idle");
      if (!shouldResumeAfter503) {
        store.updateMeta(threadId, {
          gemini503ResumeAt: "",
          gemini503RunPauseCount: 0,
        });
      }
      runLogger.event("agent.service", "run_finished", {
        status: shouldResumeAfter503 ? "submitted" : "idle",
        pendingCount: runtime.pendingGoals.length,
      });

      if (shouldResumeAfter503) {
        runLogger.event("agent.service", "gemini_503_run_resume_scheduled", {
          threadId,
          resumeInMs: gemini503ResumeDelayMs,
        });
        setTimeout(() => {
          runLoop(threadId, userGoal).catch((resumeError) => {
            runLogger.error("agent.service", "gemini_503_resume_failed", resumeError, {
              threadId,
            });
          });
        }, gemini503ResumeDelayMs);
      }

      if (!shouldResumeAfter503 && runtime.pendingGoals.length) {
        const nextGoal = runtime.pendingGoals.shift();
        runLogger.event("agent.service", "dequeue_goal_after_run", {
          threadId,
          pendingCount: runtime.pendingGoals.length,
        });
        if (nextGoal) {
          runLoop(threadId, nextGoal).catch((error) => {
            runLogger.error("agent.service", "queued_prompt_failed", error, {
              threadId,
            });
          });
        }
      }
    }
  }

  async function submitPrompt(threadId, prompt, options = {}) {
    store.appendMessage(threadId, {
      role: "user",
      kind: options.userMessageKind || "chat",
      text: prompt,
      meta: options.userMeta || {},
    });

    runLoop(threadId, prompt).catch((error) => {
      logger.error("agent.service", "submit_prompt_failed", error, {
        threadId,
      });
    });
  }

  return {
    warmup,
    stopThread(threadId) {
      const runtime = runtimes.get(threadId);
      if (!runtime) {
        return false;
      }

      runtime.stopRequested = true;
      store.setStatus(threadId, "stopping");
      const thread = store.getThread(threadId);
      const responseLanguage = thread?.meta?.responseLanguage || "en";
      addAssistantMessage(
        threadId,
        "report",
        localize(
          responseLanguage,
          "Stop requested. I will end after the current step.",
          "Остановка запрошена. Я завершу текущий шаг и остановлюсь.",
        ),
        {
          phase: "stopping",
        },
      );
      return true;
    },
    submitPrompt,
  };
}

module.exports = {
  createAgentService,
};
