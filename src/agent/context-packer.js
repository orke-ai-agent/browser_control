const {
  compact,
  inferFlowProfile,
} = require("./semantic");

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

  if (purpose === "chat_input") score += 30;
  if (purpose === "text_input") score += 24;
  if (purpose === "search_input") score += 12;
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
  if (purpose === "send_button") score += 12;
  if (keywordScore(labelSource, ["post", "publish", "share", "send", "save", "done", "next", "continue"])) {
    score += 22;
  }
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

function keywordScore(source, keywords) {
  const haystack = compact(source);
  let score = 0;

  for (const keyword of keywords) {
    if (haystack.includes(keyword)) {
      score += 4;
    }
  }

  return score;
}

function scoreSearchCandidate(element) {
  let score = 0;
  const haystack = [
    element?.purpose,
    element?.visibleName,
    element?.placeholder,
    element?.label,
    element?.nearbyText,
    element?.descriptor,
  ]
    .map(compact)
    .join(" ");

  if (compact(element?.purpose) === "search_input") score += 30;
  if (haystack.includes("search") || haystack.includes("find")) score += 18;
  if (compact(element?.href)) score += 4;
  if (element?.focused) score += 6;

  return score;
}

function selectCandidates(interactive, mode, expanded) {
  const source = Array.isArray(interactive) ? interactive : [];
  const maxItems = expanded ? 18 : 10;
  let fields = [
    "id",
    "tag",
    "role",
    "purpose",
    "section",
    "visibleName",
    "descriptor",
    "disabled",
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
    ];
    scorer = scoreSearchCandidate;
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
  const profile = inferFlowProfile(observation);
  const packet = {
    mode,
    contextLevel: expanded ? "expanded" : "compact",
    page: observation.page,
    pageSemantics: observation.pageSemantics || {},
    flow: {
      site: profile.site,
      host: profile.host,
      pageKind: profile.pageKind,
      flowKey: profile.flowKey,
      tokens: profile.tokens,
    },
    relevantElements: selectCandidates(observation.interactive, mode, expanded),
  };

  const bodyLimit = expanded ? 1800 : 700;
  const htmlLimit = expanded ? 2200 : 0;
  const bodyText = String(observation.bodyText || "").trim().slice(0, bodyLimit);
  const cleanedHtml = String(observation.cleanedHtml || "").trim().slice(0, htmlLimit);

  if (bodyText) {
    packet.bodyText = bodyText;
  }

  if (cleanedHtml) {
    packet.cleanedHtml = cleanedHtml;
  }

  return packet;
}

module.exports = {
  buildObservationPacket,
};
