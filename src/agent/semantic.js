function compact(value) {
  return String(value || "").trim().toLowerCase();
}

function tokenize(value) {
  return compact(value)
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 24);
}

function sanitizeSegment(value, fallback = "generic") {
  const normalized = compact(value).replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return normalized || fallback;
}

function hostFromUrl(url) {
  try {
    return new URL(String(url || "")).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function baseSiteFromHost(host) {
  const source = compact(host);
  if (!source) {
    return "unknown";
  }

  const known = [
    "facebook",
    "wikipedia",
    "bing",
    "duckduckgo",
    "x",
    "chatgpt",
    "openai",
    "google",
    "youtube",
  ];

  for (const candidate of known) {
    if (source.includes(candidate)) {
      return candidate;
    }
  }

  const parts = source.split(".").filter(Boolean);
  if (parts.length >= 2) {
    return parts[parts.length - 2];
  }

  return parts[0] || "unknown";
}

function keywordMatch(text, keywords) {
  const haystack = compact(text);
  return keywords.some((keyword) => haystack.includes(keyword));
}

function inferActionFamilyFromAction(action) {
  const type = compact(action?.type);

  if (type === "open_url" || type === "open_search") {
    return "navigation";
  }

  if (type === "insert" || type === "type_element") {
    return "text_input";
  }

  if (type === "click_element" || type === "click_by_text") {
    return "click";
  }

  if (type === "press_key") {
    return "keyboard";
  }

  if (type === "scroll" || type === "read_page") {
    return "explore";
  }

  return "generic";
}

function inferActionFamilyFromText(text) {
  const source = compact(text);

  if (
    keywordMatch(source, [
      "type",
      "enter",
      "fill",
      "write",
      "input",
      "message",
      "reply",
      "введ",
      "напеч",
      "поле",
      "текст",
      "напиши",
    ])
  ) {
    return "text_input";
  }

  if (
    keywordMatch(source, [
      "click",
      "press",
      "button",
      "post",
      "publish",
      "share",
      "send",
      "save",
      "done",
      "submit",
      "continue",
      "open the composer",
      "наж",
      "кноп",
      "опубли",
      "отправ",
      "сохран",
    ])
  ) {
    return "click";
  }

  if (
    keywordMatch(source, [
      "search",
      "find",
      "result",
      "lookup",
      "искать",
      "найти",
      "результат",
    ])
  ) {
    return "search";
  }

  if (
    keywordMatch(source, [
      "open",
      "go to",
      "visit",
      "navigate",
      "перейт",
      "откры",
      "зайди",
      "url",
      "link",
    ])
  ) {
    return "navigation";
  }

  return "generic";
}

function dominantValues(items, field, limit = 2) {
  const counts = new Map();

  for (const item of items) {
    const value = compact(item?.[field]);
    if (!value) {
      continue;
    }
    counts.set(value, (counts.get(value) || 0) + 1);
  }

  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, limit)
    .map(([value]) => value);
}

function inferPageKind({ host, pathName, observation }) {
  const title = compact(observation?.page?.title);
  const body = compact(observation?.bodyText).slice(0, 800);
  const semantics = observation?.pageSemantics || {};

  if (host.includes("facebook")) {
    if (pathName.includes("/groups/")) return "group";
    if (pathName.includes("/messages") || pathName.includes("messenger")) return "messenger";
    if (pathName.includes("/search")) return "search";
    if (pathName.includes("profile.php")) return "profile";
    if (semantics.dialogOpen && keywordMatch(`${title} ${body}`, ["create post", "what's on your mind", "post"])) {
      return "post_dialog";
    }
    if (pathName === "/" || !pathName) return "feed";
  }

  if (keywordMatch(`${title} ${body}`, ["search results", "result"])) {
    return "results";
  }

  if (semantics.dialogOpen) {
    return "dialog";
  }

  return "page";
}

function inferFlowProfile(observation) {
  const url = String(observation?.page?.url || "");
  const host = hostFromUrl(url);
  const site = baseSiteFromHost(host);
  let pathName = "";

  try {
    pathName = new URL(url).pathname.toLowerCase();
  } catch {
    pathName = "";
  }

  const semantics = observation?.pageSemantics || {};
  const pageKind = inferPageKind({ host, pathName, observation });
  const dominantSections = dominantValues(observation?.interactive || [], "section");
  const dominantPurposes = dominantValues(observation?.interactive || [], "purpose");
  const tokens = [
    site,
    pageKind,
    semantics.dialogOpen ? "dialog_open" : "dialog_closed",
    semantics.focusedEditablePurpose ? `focus_${sanitizeSegment(semantics.focusedEditablePurpose)}` : "",
    ...dominantSections.map((item) => `section_${sanitizeSegment(item)}`),
    ...dominantPurposes.map((item) => `purpose_${sanitizeSegment(item)}`),
  ].filter(Boolean);

  return {
    host,
    site,
    pathName,
    pageKind,
    tokens,
    flowKey: tokens.slice(0, 6).join("_"),
  };
}

function inferStepMode({ userGoal, priorAnalysis, observation, executedActions }) {
  if (compact(observation?.page?.url) === "about:blank") {
    return "navigation";
  }

  if (Array.isArray(executedActions) && executedActions.length) {
    const lastAction = executedActions[executedActions.length - 1];
    const family = inferActionFamilyFromAction(lastAction);
    if (family !== "generic") {
      return family;
    }
  }

  const nextFocusFamily = inferActionFamilyFromText(
    [priorAnalysis?.nextFocus, priorAnalysis?.progressSummary].filter(Boolean).join(" "),
  );
  if (nextFocusFamily !== "generic") {
    return nextFocusFamily;
  }

  const semantics = observation?.pageSemantics || {};

  if (semantics.focusedEditableId || semantics.focusedEditablePurpose) {
    return "text_input";
  }

  if (semantics.dialogOpen) {
    return "click";
  }

  const source = [userGoal].filter(Boolean).join(" ");

  let family = inferActionFamilyFromText(source);
  if (family !== "generic") {
    return family;
  }

  return "generic";
}

function familyToIntent(actionFamily, observation) {
  const profile = inferFlowProfile(observation);
  if (actionFamily === "text_input") {
    return profile.pageKind === "post_dialog" ? "compose_text" : "fill_input";
  }
  if (actionFamily === "click") {
    if (profile.pageKind === "post_dialog") {
      return "confirm_dialog";
    }
    return "click_primary";
  }
  if (actionFamily === "navigation") {
    return "navigate";
  }
  if (actionFamily === "search") {
    return "search";
  }
  return "generic";
}

module.exports = {
  baseSiteFromHost,
  compact,
  familyToIntent,
  hostFromUrl,
  inferActionFamilyFromAction,
  inferActionFamilyFromText,
  inferFlowProfile,
  inferStepMode,
  sanitizeSegment,
  tokenize,
};
