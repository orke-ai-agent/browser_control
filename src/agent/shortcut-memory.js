const fs = require("fs");
const path = require("path");
const {
  compact,
  familyToIntent,
  inferFlowProfile,
  sanitizeSegment,
  inferActionFamilyFromAction,
} = require("./semantic");

function ensureDirectory(directoryPath) {
  fs.mkdirSync(directoryPath, { recursive: true });
}

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }

  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, payload) {
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
}

function nowIso() {
  return new Date().toISOString();
}

function randomId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function filteredText(value, limit = 80) {
  return String(value || "").trim().slice(0, limit);
}

function buildTargetHints(action, resolvedTarget) {
  return {
    descriptor: filteredText(resolvedTarget?.descriptor, 140),
    purpose: filteredText(resolvedTarget?.purpose, 48),
    section: filteredText(resolvedTarget?.section, 48),
    visibleName: filteredText(
      resolvedTarget?.visibleName || resolvedTarget?.label || resolvedTarget?.text || "",
      120,
    ),
    placeholder: filteredText(resolvedTarget?.placeholder, 120),
    nearbyText: filteredText(resolvedTarget?.nearbyText, 120),
    label: filteredText(resolvedTarget?.label, 120),
    href: filteredText(resolvedTarget?.href || resolvedTarget?.url, 220),
    submitKey: filteredText(action?.submitKey, 24),
  };
}

function hasMeaningfulTargetHints(targetHints) {
  return Boolean(
    targetHints.descriptor ||
      targetHints.purpose ||
      targetHints.section ||
      targetHints.visibleName ||
      targetHints.placeholder ||
      targetHints.nearbyText ||
      targetHints.label ||
      targetHints.href,
  );
}

function primaryTargetLabel(targetHints) {
  return (
    targetHints.visibleName ||
    targetHints.placeholder ||
    targetHints.nearbyText ||
    targetHints.label ||
    targetHints.purpose ||
    "target"
  );
}

function buildRecipeKey({ site, flowKey, actionFamily, targetHints }) {
  const label = sanitizeSegment(primaryTargetLabel(targetHints), "target");
  return `${sanitizeSegment(site)}_${sanitizeSegment(flowKey)}_${sanitizeSegment(actionFamily)}_${label}`.slice(
    0,
    120,
  );
}

function successRate(recipe) {
  const total = Number(recipe.successCount || 0) + Number(recipe.failureCount || 0);
  if (!total) {
    return 1;
  }
  return Number(recipe.successCount || 0) / total;
}

function summarizeRecipe(recipe) {
  return {
    id: recipe.id,
    key: recipe.key,
    site: recipe.site,
    host: recipe.host,
    flowKey: recipe.flowKey,
    actionFamily: recipe.actionFamily,
    intent: recipe.intent,
    targetHints: recipe.targetHints,
    usageCount: recipe.usageCount || 0,
    successCount: recipe.successCount || 0,
    failureCount: recipe.failureCount || 0,
    successRate: successRate(recipe),
    lastUsedAt: recipe.lastUsedAt || "",
    updatedAt: recipe.updatedAt || "",
  };
}

function overlapScore(recipe, flowProfile, actionFamily) {
  let score = 0;

  if (recipe.host && recipe.host === flowProfile.host) {
    score += 40;
  } else if (recipe.site && recipe.site === flowProfile.site) {
    score += 28;
  }

  if (recipe.actionFamily === actionFamily) {
    score += 24;
  }

  if (recipe.flowKey === flowProfile.flowKey) {
    score += 26;
  }

  const recipeTokens = new Set(recipe.flowTokens || []);
  for (const token of flowProfile.tokens) {
    if (recipeTokens.has(token)) {
      score += 6;
    }
  }

  if (recipe.targetHints?.section && flowProfile.tokens.includes(`section_${sanitizeSegment(recipe.targetHints.section)}`)) {
    score += 4;
  }

  score += Math.round(successRate(recipe) * 12);
  score += Math.min(12, Number(recipe.usageCount || 0));

  return score;
}

function createShortcutMemory({ filePath, logger }) {
  ensureDirectory(path.dirname(filePath));

  function loadState() {
    return readJson(filePath, {
      version: 1,
      recipes: [],
    });
  }

  function saveState(state) {
    writeJson(filePath, state);
  }

  function listForClient() {
    return loadState()
      .recipes
      .filter((recipe) => !recipe.disabled)
      .filter((recipe) => recipe.site !== "unknown")
      .filter((recipe) => hasMeaningfulTargetHints(recipe.targetHints || {}))
      .sort((left, right) => (right.updatedAt || "").localeCompare(left.updatedAt || ""))
      .map(summarizeRecipe);
  }

  function retrieve({ observation, actionFamily, limit = 3 }) {
    const state = loadState();
    const flowProfile = inferFlowProfile(observation);

    return state.recipes
      .filter((recipe) => !recipe.disabled)
      .filter((recipe) => recipe.site !== "unknown")
      .filter((recipe) => hasMeaningfulTargetHints(recipe.targetHints || {}))
      .map((recipe) => ({
        recipe,
        score: overlapScore(recipe, flowProfile, actionFamily),
      }))
      .filter((item) => item.score >= 40)
      .sort((left, right) => right.score - left.score)
      .slice(0, limit)
      .map(({ recipe, score }) => ({
        ...summarizeRecipe(recipe),
        matchScore: score,
      }));
  }

  function upsertFromAction({ observation, action, resolvedTarget, origin = "learned" }) {
    const actionFamily = inferActionFamilyFromAction(action);

    if (!["click", "text_input", "navigation"].includes(actionFamily)) {
      return null;
    }

    const flowProfile = inferFlowProfile(observation);
    const targetHints = buildTargetHints(action, resolvedTarget);

    if (flowProfile.site === "unknown") {
      return null;
    }

    if (!hasMeaningfulTargetHints(targetHints)) {
      return null;
    }

    const key = buildRecipeKey({
      site: flowProfile.site,
      flowKey: flowProfile.flowKey,
      actionFamily,
      targetHints,
    });
    const state = loadState();
    const currentTime = nowIso();
    const existing = state.recipes.find((recipe) => recipe.key === key);

    if (existing) {
      existing.updatedAt = currentTime;
      existing.lastObservedAt = currentTime;
      existing.disabled = false;
      existing.origin = existing.origin || origin;
      existing.flowTokens = flowProfile.tokens;
      existing.targetHints = {
        ...existing.targetHints,
        ...targetHints,
      };
      saveState(state);
      logger.event("agent.memory", "shortcut_refreshed", {
        key,
        site: flowProfile.site,
        actionFamily,
      });
      return summarizeRecipe(existing);
    }

    const recipe = {
      id: randomId(),
      key,
      site: flowProfile.site,
      host: flowProfile.host,
      flowKey: flowProfile.flowKey,
      flowTokens: flowProfile.tokens,
      pageKind: flowProfile.pageKind,
      actionFamily,
      intent: familyToIntent(actionFamily, observation),
      origin,
      actionTemplate: {
        type: action.type,
      },
      targetHints,
      usageCount: 0,
      successCount: 0,
      failureCount: 0,
      createdAt: currentTime,
      updatedAt: currentTime,
      lastObservedAt: currentTime,
      lastUsedAt: "",
      disabled: false,
    };

    state.recipes.push(recipe);
    saveState(state);
    logger.event("agent.memory", "shortcut_created", {
      key,
      site: flowProfile.site,
      actionFamily,
    });
    return summarizeRecipe(recipe);
  }

  function markRecipeResult({ key, success }) {
    if (!key) {
      return null;
    }

    const state = loadState();
    const recipe = state.recipes.find((item) => item.key === key);

    if (!recipe) {
      return null;
    }

    recipe.usageCount = Number(recipe.usageCount || 0) + 1;
    recipe.lastUsedAt = nowIso();
    recipe.updatedAt = recipe.lastUsedAt;

    if (success) {
      recipe.successCount = Number(recipe.successCount || 0) + 1;
    } else {
      recipe.failureCount = Number(recipe.failureCount || 0) + 1;
    }

    saveState(state);
    logger.event("agent.memory", success ? "shortcut_success" : "shortcut_failure", {
      key: recipe.key,
      site: recipe.site,
      actionFamily: recipe.actionFamily,
      successRate: successRate(recipe),
    });
    return summarizeRecipe(recipe);
  }

  return {
    listForClient,
    markRecipeResult,
    retrieve,
    upsertFromAction,
  };
}

module.exports = {
  createShortcutMemory,
};
