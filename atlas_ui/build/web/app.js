const STORAGE_KEY = "atlas.tickets.v1";
const palette = ["#fff2a8", "#ffd6d1", "#d8f5ca", "#cfe9ff", "#f1dcff", "#ffe4ba", "#d9f4ef"];
const tilts = ["-2.2deg", "1.8deg", "-1.1deg", "2.6deg", "-3deg", "0.9deg"];

const sampleTickets = [
  {
    id: "ticket-facebook-listings",
    title: "Facebook Listings",
    steps: [
      "Open Facebook and check today's apartment posts in the real estate group.",
      "Capture listings priced from 8 to 12 million.",
      "Send screenshots with prices to Telegram.",
    ],
    frequency: "daily",
    time: "09:00",
    createdAt: new Date().toISOString(),
  },
  {
    id: "ticket-market-scan",
    title: "Market Scan",
    steps: [
      "Check selected competitor pages.",
      "Collect fresh offer screenshots and short notes.",
    ],
    frequency: "hourly",
    time: "25",
    createdAt: new Date().toISOString(),
  },
];

const state = {
  tickets: [],
  activeId: "",
  draft: null,
  activeRunTicketId: "",
  activeRunThreadId: "",
  activeThread: null,
  isStartingRun: false,
  filesByTicketId: {},
};

let runPollTimer = null;

const elements = {
  createTicketButton: document.getElementById("createTicketButton"),
  ticketList: document.getElementById("ticketList"),
  stageRoot: document.getElementById("stageRoot"),
  fileBoxRoot: document.getElementById("fileBoxRoot"),
};

function logEvent(event, payload = {}) {
  const entry = {
    event,
    payload,
    timestamp: new Date().toISOString(),
  };
  console.info("[atlas-ui]", entry);
}

function logError(event, error, payload = {}) {
  console.error("[atlas-ui]", {
    event,
    error: error instanceof Error ? error.message : String(error),
    payload,
    timestamp: new Date().toISOString(),
  });
}

function uid() {
  return `ticket-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function readLocalTickets() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return sampleTickets;
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return sampleTickets;
    }
    return parsed;
  } catch (error) {
    logError("storage_read_failed", error);
    return sampleTickets;
  }
}

function writeLocalTickets() {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state.tickets));
    logEvent("tickets_local_saved", { count: state.tickets.length });
  } catch (error) {
    logError("storage_write_failed", error, { count: state.tickets.length });
  }
}

async function requestJson(url, options = {}) {
  logEvent("api_request", {
    method: options.method || "GET",
    url,
  });
  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    ...options,
  });
  const payload = await response.json();
  logEvent("api_response", {
    method: options.method || "GET",
    url,
    status: response.status,
  });
  if (!response.ok) {
    throw new Error(payload.error || `Request failed with status ${response.status}`);
  }
  return payload;
}

async function loadTickets() {
  try {
    const payload = await requestJson("/api/tickets");
    if (Array.isArray(payload.tickets) && payload.tickets.length) {
      state.tickets = payload.tickets;
      writeLocalTickets();
      return;
    }

    const localTickets = readLocalTickets();
    state.tickets = localTickets;
    await saveTickets();
  } catch (error) {
    logError("tickets_load_failed", error);
    state.tickets = readLocalTickets();
  }
}

async function saveTickets() {
  writeLocalTickets();
  try {
    const payload = await requestJson("/api/tickets", {
      method: "POST",
      body: JSON.stringify({ tickets: state.tickets }),
    });
    if (Array.isArray(payload.tickets)) {
      state.tickets = payload.tickets;
      writeLocalTickets();
    }
    logEvent("tickets_saved", { count: state.tickets.length });
  } catch (error) {
    logError("tickets_save_failed", error, { count: state.tickets.length });
  }
}

function frequencyLabel(frequency) {
  const labels = {
    once: "Once",
    daily: "Every Day",
    weekly: "Every Week",
    hourly: "Every Hour",
  };
  return labels[frequency] || labels.once;
}

function normalizeMinute(value) {
  const minute = Math.max(0, Math.min(59, Number(value) || 0));
  return String(minute).padStart(2, "0");
}

function nextExecution(ticket) {
  if (ticket.frequency === "hourly") {
    return `:${normalizeMinute(ticket.time)}`;
  }
  return ticket.time || "09:00";
}

function shortSteps(ticket) {
  return ticket.steps
    .map((step) => step.trim())
    .filter(Boolean)
    .join(" · ");
}

function sortedTickets() {
  return [...state.tickets].sort((left, right) => nextExecution(left).localeCompare(nextExecution(right)));
}

function activeTicketId() {
  return state.draft?.id || state.activeRunTicketId || "";
}

function upsertTicket(ticket) {
  if (!ticket?.id) {
    return;
  }

  const index = state.tickets.findIndex((item) => item.id === ticket.id);
  if (index >= 0) {
    state.tickets[index] = ticket;
  } else {
    state.tickets.push(ticket);
  }
  writeLocalTickets();
}

function activeRunStatus(ticket) {
  if (state.activeThread?.status) {
    return state.activeThread.status;
  }
  return ticket?.lastRunStatus || "not started";
}

function isRunningStatus(status) {
  return ["running", "submitted", "stopping"].includes(String(status || "").trim().toLowerCase());
}

function ticketRunHistory(ticket) {
  const source = Array.isArray(ticket?.runHistory) ? ticket.runHistory : [];
  const history = source
    .map((run) => ({
      threadId: String(run?.threadId || "").trim(),
      runAt: String(run?.runAt || "").trim(),
      status: String(run?.status || "").trim() || "submitted",
      source: String(run?.source || "").trim() || "manual",
    }))
    .filter((run) => run.threadId);

  if (!history.length && ticket?.lastThreadId) {
    history.push({
      threadId: ticket.lastThreadId,
      runAt: ticket.lastRunAt || "",
      status: ticket.lastRunStatus || "submitted",
      source: "legacy",
    });
  }

  return history;
}

function activeThreadIdForTicket(ticket) {
  return state.activeRunThreadId || ticket?.lastThreadId || "";
}

function latestProgressMessage(thread) {
  const messages = Array.isArray(thread?.messages) ? thread.messages : [];
  const latest = [...messages].reverse().find((message) => message.role === "assistant") || messages[messages.length - 1];
  return latest?.text || "";
}

function formatDateTime(value) {
  const date = new Date(value || "");
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function sanitizeRunLogText(value) {
  const lines = String(value || "").split("\n");
  const cleaned = [];
  let droppingWrappedPath = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (droppingWrappedPath) {
      if (trimmed.startsWith("/Users/") || trimmed.startsWith("/var/") || trimmed.startsWith("/tmp/")) {
        continue;
      }
      droppingWrappedPath = false;
    }

    if (line.includes("local path:")) {
      const beforePath = line.slice(0, line.indexOf("local path:")).trimEnd();
      cleaned.push(beforePath.endsWith(",") ? `${beforePath.slice(0, -1)})` : beforePath);
      droppingWrappedPath = true;
      continue;
    }

    if (trimmed.startsWith("/Users/") || trimmed.startsWith("/var/") || trimmed.startsWith("/tmp/")) {
      continue;
    }

    cleaned.push(line);
  }

  return cleaned.join("\n").replaceAll(" ()", "");
}

function buildTicketPrompt(ticket) {
  const steps = (ticket?.steps || [])
    .map((step, index) => `${index + 1}. ${step}`)
    .join("\n");
  const files = state.filesByTicketId[ticket.id] || [];
  const fileLines = files.length
    ? files.map((file, index) => `${index + 1}. ${file.name} (${file.mimeType}, ${file.size} bytes)`).join("\n")
    : "No files in this ticket asset box.";
  const attachmentRequirements = files.length
    ? [
        "Attachment execution requirements:",
        files.length > 1
          ? "- The task asset box contains multiple files. If the user asks to post, upload, attach, publish, or share these assets, use mediaRef all_media unless the page visibly rejects multiple attachments."
          : "- The task asset box contains one file. If the user asks to post, upload, attach, publish, or share it, use that attached media through upload_media.",
        "- Do not treat the file list as informational text only; it is the payload for upload_media when the task asks for files/media.",
        "",
      ]
    : [];

  return [
    `Execute scheduled ticket: ${ticket.title || "Untitled Ticket"}`,
    "",
    "Ticket asset box files:",
    fileLines,
    "",
    ...attachmentRequirements,
    "Tasks:",
    steps || "1. No task description yet.",
  ].join("\n");
}

function stopRunPolling() {
  if (runPollTimer) {
    clearInterval(runPollTimer);
    runPollTimer = null;
  }
}

function startRunPolling(ticketId) {
  stopRunPolling();
  runPollTimer = setInterval(() => {
    if (state.activeRunTicketId !== ticketId) {
      stopRunPolling();
      return;
    }
    refreshActiveRun({ silent: true });
  }, 2500);
}

async function loadTicketFiles(ticketId) {
  if (!ticketId) {
    return [];
  }

  try {
    const payload = await requestJson(`/api/tickets/${ticketId}/files`);
    state.filesByTicketId[ticketId] = Array.isArray(payload.files) ? payload.files : [];
    updateTicketFileCount(ticketId);
    return state.filesByTicketId[ticketId];
  } catch (error) {
    logError("ticket_files_load_failed", error, { ticketId });
    state.filesByTicketId[ticketId] = [];
    return [];
  }
}

function updateTicketFileCount(ticketId) {
  const ticket = state.tickets.find((item) => item.id === ticketId);
  if (!ticket) {
    return;
  }
  ticket.fileCount = (state.filesByTicketId[ticketId] || []).length;
}

async function uploadFiles(ticketId, files) {
  const items = Array.from(files || []);
  if (!ticketId || !items.length) {
    return;
  }

  const formData = new FormData();
  items.forEach((file) => formData.append("files", file, file.name));
  logEvent("api_request", {
    method: "POST",
    url: `/api/tickets/${ticketId}/files`,
  });

  try {
    const response = await fetch(`/api/tickets/${ticketId}/files`, {
      method: "POST",
      body: formData,
    });
    const payload = await response.json();
    logEvent("api_response", {
      method: "POST",
      url: `/api/tickets/${ticketId}/files`,
      status: response.status,
    });
    if (!response.ok) {
      throw new Error(payload.error || `Upload failed with status ${response.status}`);
    }

    state.filesByTicketId[ticketId] = Array.isArray(payload.files) ? payload.files : [];
    updateTicketFileCount(ticketId);
    render();
  } catch (error) {
    logError("ticket_files_upload_failed", error, { ticketId, count: items.length });
  }
}

function fileIcon(file) {
  const type = String(file.mimeType || "").toLowerCase();
  const name = String(file.name || "").toLowerCase();
  if (type.startsWith("image/")) return "▧";
  if (type.startsWith("video/")) return "▷";
  if (type.includes("pdf") || name.endsWith(".pdf")) return "PDF";
  return "□";
}

function createDraft(ticket) {
  if (ticket) {
    return {
      id: ticket.id,
      title: ticket.title,
      steps: ticket.steps.length ? [...ticket.steps] : [""],
      frequency: ticket.frequency || "once",
      time: ticket.time || "09:00",
      createdAt: ticket.createdAt || new Date().toISOString(),
      lastRunKey: ticket.lastRunKey || "",
      lastRunAt: ticket.lastRunAt || "",
      lastRunStatus: ticket.lastRunStatus || "",
      lastThreadId: ticket.lastThreadId || "",
      isNew: false,
    };
  }

  return {
    id: uid(),
    title: "",
    steps: [""],
    frequency: "daily",
    time: "09:00",
    createdAt: new Date().toISOString(),
    isNew: true,
  };
}

function renderSidebar() {
  elements.ticketList.replaceChildren();

  sortedTickets().forEach((ticket) => {
    const row = document.createElement("article");
    row.className = `sidebar-ticket${ticket.id === state.activeId ? " is-active" : ""}`;

    const text = document.createElement("div");
    const title = document.createElement("div");
    title.className = "sidebar-title";
    title.textContent = ticket.title || "Untitled Ticket";
    const meta = document.createElement("div");
    meta.className = "sidebar-meta";
    meta.textContent = `${frequencyLabel(ticket.frequency)} · ${nextExecution(ticket)} · ${Number(ticket.fileCount || 0)} files`;
    text.append(title, meta);

    const edit = document.createElement("button");
    edit.className = "icon-button";
    edit.type = "button";
    edit.title = "Edit ticket";
    edit.setAttribute("aria-label", `Edit ${ticket.title || "ticket"}`);
    edit.textContent = "✎";
    edit.addEventListener("click", (event) => {
      event.stopPropagation();
      openTicket(ticket.id);
    });

    row.addEventListener("click", () => openTicket(ticket.id));

    row.append(text, edit);
    elements.ticketList.append(row);
  });
}

function renderBoard() {
  const tickets = sortedTickets();
  const board = document.createElement("section");
  board.className = "day-board";
  board.setAttribute("aria-label", "Today board");

  const header = document.createElement("header");
  header.className = "board-header";
  const titleWrap = document.createElement("div");
  const kicker = document.createElement("p");
  kicker.className = "board-kicker";
  kicker.textContent = "Today";
  const heading = document.createElement("h1");
  heading.textContent = new Intl.DateTimeFormat("en", {
    weekday: "long",
    month: "short",
    day: "numeric",
  }).format(new Date());
  titleWrap.append(kicker, heading);
  const count = document.createElement("span");
  count.className = "board-count";
  count.textContent = String(tickets.length);
  header.append(titleWrap, count);

  const paperBoard = document.createElement("div");
  paperBoard.className = "paper-board";
  board.append(header, paperBoard);

  if (!tickets.length) {
    const empty = document.createElement("p");
    empty.className = "empty-board";
    empty.textContent = "No tickets scheduled yet.";
    paperBoard.append(empty);
    return board;
  }

  tickets.forEach((ticket, index) => {
    const paper = document.createElement("button");
    paper.className = "paper-ticket";
    paper.type = "button";
    paper.style.setProperty("--paper-color", palette[index % palette.length]);
    paper.style.setProperty("--paper-tilt", tilts[index % tilts.length]);
    paper.addEventListener("click", () => openTicketRun(ticket.id));

    const title = document.createElement("h2");
    title.className = "paper-title";
    title.textContent = ticket.title || "Untitled Ticket";

    const steps = document.createElement("p");
    steps.className = "paper-steps";
    steps.textContent = shortSteps(ticket) || "No tasks yet.";

    const meta = document.createElement("div");
    meta.className = "paper-meta";
    const time = document.createElement("span");
    time.textContent = nextExecution(ticket);
    const frequency = document.createElement("span");
    frequency.textContent = frequencyLabel(ticket.frequency);
    const files = document.createElement("span");
    files.className = "paper-files";
    files.textContent = `▣ ${Number(ticket.fileCount || 0)}`;
    meta.append(time, frequency, files);

    const status = document.createElement("div");
    status.className = "paper-status";
    status.textContent = ticket.lastThreadId
      ? `${ticket.lastRunStatus || "submitted"} · ${ticket.lastRunAt || ""}`
      : "Ready";

    paper.append(title, steps, status, meta);
    paperBoard.append(paper);
  });

  return board;
}

function renderSteps(stepsList) {
  stepsList.replaceChildren();
  state.draft.steps.forEach((step, index) => {
    const row = document.createElement("div");
    row.className = "step-row";

    const input = document.createElement("textarea");
    input.className = "text-field";
    input.value = step;
    input.rows = 3;
    input.placeholder = index === 0 ? "Open Facebook and check today's real estate group" : "Next task";
    input.addEventListener("input", () => {
      state.draft.steps[index] = input.value;
    });

    const remove = document.createElement("button");
    remove.className = "icon-button remove-step";
    remove.type = "button";
    remove.title = "Remove task";
    remove.setAttribute("aria-label", "Remove task");
    remove.textContent = "×";
    remove.disabled = state.draft.steps.length === 1;
    remove.addEventListener("click", () => {
      state.draft.steps.splice(index, 1);
      renderSteps();
    });

    row.append(input, remove);
    stepsList.append(row);
  });
}

function applyTimeMode(frequencySelect, timeLabel, timeInput) {
  const hourly = frequencySelect.value === "hourly";
  timeLabel.textContent = hourly ? "Minute" : "Time";
  timeInput.type = hourly ? "number" : "time";
  timeInput.min = hourly ? "0" : "";
  timeInput.max = hourly ? "59" : "";
  timeInput.step = hourly ? "1" : "";
  timeInput.value = hourly ? normalizeMinute(state.draft.time) : state.draft.time || "09:00";
}

function renderEditWidget() {
  const panel = document.createElement("section");
  panel.className = "editor-panel";
  panel.setAttribute("aria-label", "Ticket editor");

  const form = document.createElement("form");
  form.className = "ticket-form";

  const toolbar = document.createElement("div");
  toolbar.className = "editor-toolbar";
  const mode = document.createElement("span");
  mode.textContent = state.draft.isNew ? "New Ticket" : "Edit Ticket";
  const close = document.createElement("button");
  close.className = "close-editor";
  close.type = "button";
  close.setAttribute("aria-label", "Close editor");
  close.textContent = "×";
  close.addEventListener("click", closeStageView);
  toolbar.append(mode, close);

  const titleLabel = document.createElement("label");
  titleLabel.className = "field-label";
  titleLabel.textContent = "Title";
  const titleInput = document.createElement("input");
  titleInput.className = "text-field title-field";
  titleInput.type = "text";
  titleInput.autocomplete = "off";
  titleInput.placeholder = "Facebook listings scan";
  titleInput.value = state.draft.title;

  const stepsHead = document.createElement("div");
  stepsHead.className = "steps-head";
  stepsHead.textContent = "Tasks";
  const stepsList = document.createElement("div");
  stepsList.className = "steps-list";
  const addStep = document.createElement("button");
  addStep.className = "add-step";
  addStep.type = "button";
  addStep.innerHTML = '<span aria-hidden="true">+</span><span>Create Task</span>';
  addStep.addEventListener("click", () => {
    state.draft.steps.push("");
    renderSteps(stepsList);
    const inputs = stepsList.querySelectorAll("textarea");
    inputs[inputs.length - 1]?.focus();
  });

  const schedule = document.createElement("div");
  schedule.className = "schedule-grid";
  const frequencyLabelElement = document.createElement("label");
  frequencyLabelElement.className = "field-label";
  frequencyLabelElement.textContent = "Repeat";
  const frequencySelect = document.createElement("select");
  frequencySelect.className = "text-field";
  [
    ["once", "Once"],
    ["daily", "Every Day"],
    ["weekly", "Every Week"],
    ["hourly", "Every Hour"],
  ].forEach(([value, label]) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    frequencySelect.append(option);
  });
  frequencySelect.value = state.draft.frequency;

  const timeLabel = document.createElement("label");
  timeLabel.className = "field-label";
  timeLabel.textContent = "Time";
  const timeInput = document.createElement("input");
  timeInput.className = "text-field";
  schedule.append(frequencyLabelElement, frequencySelect, timeLabel, timeInput);

  frequencySelect.addEventListener("change", () => {
    state.draft.frequency = frequencySelect.value;
    state.draft.time = frequencySelect.value === "hourly" ? "00" : "09:00";
    applyTimeMode(frequencySelect, timeLabel, timeInput);
  });
  timeInput.addEventListener("input", () => {
    state.draft.time = timeInput.value;
  });

  const actions = document.createElement("div");
  actions.className = "form-actions";
  const save = document.createElement("button");
  save.className = "save-action";
  save.type = "submit";
  save.textContent = "Save Ticket";
  actions.append(save);

  form.append(toolbar, titleLabel, titleInput, stepsHead, stepsList, addStep, schedule, actions);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    saveDraftFromForm(titleInput, frequencySelect, timeInput);
  });
  panel.append(form);

  renderSteps(stepsList);
  applyTimeMode(frequencySelect, timeLabel, timeInput);

  queueMicrotask(() => titleInput.focus());
  return panel;
}

function renderRunWidget() {
  const panel = document.createElement("section");
  panel.className = "run-panel";
  panel.setAttribute("aria-label", "Ticket run details");

  const ticket = state.tickets.find((item) => item.id === state.activeRunTicketId);
  const activeThreadId = activeThreadIdForTicket(ticket);
  const toolbar = document.createElement("div");
  toolbar.className = "editor-toolbar";
  const mode = document.createElement("span");
  mode.textContent = ticket ? ticket.title : "Run";
  const close = document.createElement("button");
  close.className = "close-editor";
  close.type = "button";
  close.setAttribute("aria-label", "Close run details");
  close.textContent = "×";
  close.addEventListener("click", closeStageView);
  toolbar.append(mode, close);
  panel.append(toolbar);

  const summaryWrap = document.createElement("div");
  summaryWrap.className = "run-summary";
  const runActions = document.createElement("div");
  runActions.className = "run-actions";
  const runNow = document.createElement("button");
  runNow.className = "save-action";
  runNow.type = "button";
  const status = activeRunStatus(ticket);
  const runIsActive = state.isStartingRun || isRunningStatus(state.activeThread?.status);
  if (runIsActive) {
    const spinner = document.createElement("span");
    spinner.className = "run-spinner run-button-spinner";
    spinner.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    label.textContent = state.isStartingRun ? "Starting..." : "Running";
    runNow.append(spinner, label);
  } else {
    runNow.textContent = "Run Now";
  }
  runNow.disabled = !ticket || runIsActive;
  runNow.addEventListener("click", () => runTicketNow(ticket.id));
  const refresh = document.createElement("button");
  refresh.className = "secondary-action";
  refresh.type = "button";
  refresh.textContent = "Refresh";
  refresh.disabled = !activeThreadId;
  refresh.addEventListener("click", () => refreshActiveRun());
  runActions.append(runNow, refresh);
  summaryWrap.append(runActions);

  const summary = document.createElement("div");
  summary.className = "run-summary-card";
  const cycle = Number(state.activeThread?.meta?.cycleCount || 0);
  const tokens = Number(state.activeThread?.meta?.totalTokens || 0);
  const latest = latestProgressMessage(state.activeThread);
  if (activeThreadId) {
    const statusLine = document.createElement("div");
    statusLine.className = `run-status-line${runIsActive ? " is-running" : ""}`;
    if (runIsActive) {
      const spinner = document.createElement("span");
      spinner.className = "run-spinner";
      spinner.setAttribute("aria-hidden", "true");
      statusLine.append(spinner);
    }
    const statusText = document.createElement("span");
    statusText.textContent = `Thread ${activeThreadId} · ${status} · cycle ${cycle} · ${tokens} tokens · ${formatDateTime(ticket?.lastRunAt) || "no run time"}`;
    statusLine.append(statusText);
    summary.append(statusLine);
    if (latest) {
      const latestLine = document.createElement("div");
      latestLine.className = "run-latest";
      latestLine.textContent = sanitizeRunLogText(latest);
      summary.append(latestLine);
    }
  } else {
    summary.textContent = "No previous run yet.";
  }
  summaryWrap.append(summary);
  panel.append(summaryWrap);

  const messagesWrap = document.createElement("div");
  messagesWrap.className = "run-messages";

  const messages = Array.isArray(state.activeThread?.messages) ? state.activeThread.messages : [];
  if (!messages.length) {
    const empty = document.createElement("p");
    empty.className = "empty-board";
    empty.textContent = activeThreadId ? "Run is still loading or has no messages yet." : "This ticket has not returned a run yet.";
    messagesWrap.append(empty);
    panel.append(messagesWrap);
    return panel;
  }

  [...messages].reverse().forEach((message, index) => {
    const item = document.createElement("article");
    item.className = `run-message${runIsActive && index === 0 ? " is-current" : ""}`;
    const head = document.createElement("div");
    head.className = "run-message-head";
    const time = formatDateTime(message.timestamp);
    head.textContent = `${time ? `${time} · ` : ""}${message.role || "message"} · ${message.kind || "text"}`;
    const body = document.createElement("pre");
    body.textContent = sanitizeRunLogText(message.text || JSON.stringify(message.meta || {}, null, 2));
    item.append(head, body);
    messagesWrap.append(item);
  });
  panel.append(messagesWrap);
  return panel;
}

function renderFileBox() {
  elements.fileBoxRoot.replaceChildren();
  const ticketId = activeTicketId();
  if (!ticketId) {
    return;
  }

  const ticket = state.tickets.find((item) => item.id === ticketId) || state.draft;
  const box = document.createElement("section");
  box.className = "file-box";
  box.addEventListener("dragover", (event) => {
    event.preventDefault();
    box.classList.add("is-dragging");
  });
  box.addEventListener("dragleave", () => {
    box.classList.remove("is-dragging");
  });
  box.addEventListener("drop", (event) => {
    event.preventDefault();
    box.classList.remove("is-dragging");
    uploadFiles(ticketId, event.dataTransfer.files);
  });

  const header = document.createElement("div");
  header.className = "file-box-head";
  const title = document.createElement("div");
  title.textContent = "Asset Box";
  const count = document.createElement("span");
  const files = state.filesByTicketId[ticketId] || [];
  count.textContent = String(files.length);
  header.append(title, count);

  const picker = document.createElement("input");
  picker.type = "file";
  picker.multiple = true;
  picker.hidden = true;
  picker.accept = "image/*,video/*,application/pdf";
  picker.addEventListener("change", () => {
    uploadFiles(ticketId, picker.files);
    picker.value = "";
  });

  const add = document.createElement("button");
  add.className = "file-add";
  add.type = "button";
  add.textContent = "+ Add Files";
  add.addEventListener("click", () => picker.click());

  const hint = document.createElement("div");
  hint.className = "file-hint";
  hint.textContent = ticket ? `Files for ${ticket.title || "this ticket"}` : "Files for this ticket";

  const grid = document.createElement("div");
  grid.className = "file-grid";
  if (!files.length) {
    const empty = document.createElement("div");
    empty.className = "file-empty";
    empty.textContent = "Drop files here";
    grid.append(empty);
  } else {
    files.forEach((file) => {
      const link = document.createElement("a");
      link.className = "file-tile";
      link.href = file.url;
      link.target = "_blank";
      link.rel = "noreferrer";
      const icon = document.createElement("div");
      icon.className = "file-icon";
      icon.textContent = fileIcon(file);
      const name = document.createElement("div");
      name.className = "file-name";
      name.textContent = file.name;
      link.append(icon, name);
      grid.append(link);
    });
  }

  const runs = renderRunHistory(ticket);
  box.append(header, add, hint, grid, runs, picker);
  elements.fileBoxRoot.append(box);
}

function renderRunHistory(ticket) {
  const wrap = document.createElement("div");
  wrap.className = "run-history";
  const head = document.createElement("div");
  head.className = "run-history-head";
  head.textContent = "Previous Runs";
  wrap.append(head);

  const runs = ticketRunHistory(ticket);
  if (!runs.length) {
    const empty = document.createElement("div");
    empty.className = "run-history-empty";
    empty.textContent = "No runs yet";
    wrap.append(empty);
    return wrap;
  }

  runs.forEach((run) => {
    const item = document.createElement("button");
    item.className = `run-history-item${run.threadId === activeThreadIdForTicket(ticket) ? " is-active" : ""}`;
    item.type = "button";
    item.addEventListener("click", () => openTicketRun(ticket.id, run.threadId));

    const title = document.createElement("span");
    title.className = "run-history-title";
    title.textContent = run.threadId;
    const meta = document.createElement("span");
    meta.className = "run-history-meta";
    meta.textContent = `${run.status} · ${run.runAt || "no time"}`;
    item.append(title, meta);
    wrap.append(item);
  });

  return wrap;
}

function restoreWindowScroll(scrollTop, scrollLeft) {
  requestAnimationFrame(() => {
    const scrollingElement = document.scrollingElement || document.documentElement;
    scrollingElement.scrollTop = scrollTop;
    scrollingElement.scrollLeft = scrollLeft;
  });
}

function render(options = {}) {
  const scrollingElement = document.scrollingElement || document.documentElement;
  const scrollTop = scrollingElement.scrollTop;
  const scrollLeft = scrollingElement.scrollLeft;
  renderSidebar();
  elements.stageRoot.replaceChildren();
  if (state.draft) {
    elements.stageRoot.append(renderEditWidget());
    renderFileBox();
    if (options.preserveScroll) {
      restoreWindowScroll(scrollTop, scrollLeft);
    }
    return;
  }
  if (state.activeRunTicketId) {
    elements.stageRoot.append(renderRunWidget());
    renderFileBox();
    if (options.preserveScroll) {
      restoreWindowScroll(scrollTop, scrollLeft);
    }
    return;
  }
  elements.stageRoot.append(renderBoard());
  renderFileBox();
  if (options.preserveScroll) {
    restoreWindowScroll(scrollTop, scrollLeft);
  }
}

async function refreshActiveRun(options = {}) {
  const ticket = state.tickets.find((item) => item.id === state.activeRunTicketId);
  const threadId = activeThreadIdForTicket(ticket);
  if (!threadId) {
    return;
  }

  try {
    const payload = await requestJson(`/api/threads/${threadId}`);
    state.activeThread = payload.thread || null;
    if (ticket && state.activeThread?.status) {
      ticket.lastRunStatus = state.activeThread.status;
    }
    logEvent("ticket_run_refreshed", {
      id: ticket.id,
      threadId,
      status: state.activeThread?.status || "",
    });
    if (state.activeThread?.status === "idle") {
      stopRunPolling();
    }
  } catch (error) {
    logError("ticket_run_refresh_failed", error, { id: ticket.id, threadId });
  }

  if (!options.silent || state.activeRunTicketId) {
    render({ preserveScroll: Boolean(options.silent) });
  }
}

async function runTicketNow(id) {
  if (!id || state.isStartingRun) {
    return;
  }

  state.isStartingRun = true;
  state.activeId = id;
  state.draft = null;
  state.activeRunTicketId = id;
  state.activeRunThreadId = "";
  state.activeThread = null;
  render();

  try {
    const payload = await requestJson(`/api/tickets/${id}/run`, {
      method: "POST",
      body: JSON.stringify({}),
    });

    if (payload.ticket) {
      upsertTicket(payload.ticket);
    }
    state.activeRunThreadId = payload.thread?.id || payload.ticket?.lastThreadId || "";
    state.activeThread = payload.thread || null;
    logEvent("ticket_run_started", {
      id,
      threadId: payload.thread?.id || payload.ticket?.lastThreadId || "",
    });
    startRunPolling(id);
  } catch (error) {
    logError("ticket_run_start_failed", error, { id });
  } finally {
    state.isStartingRun = false;
    render();
  }
}

function openTicket(id) {
  const ticket = state.tickets.find((item) => item.id === id);
  if (!ticket) {
    logError("ticket_open_failed", new Error("Ticket not found"), { id });
    return;
  }
  state.activeId = id;
  state.draft = createDraft(ticket);
  state.activeRunTicketId = "";
  state.activeRunThreadId = "";
  state.activeThread = null;
  stopRunPolling();
  logEvent("ticket_opened", { id });
  loadTicketFiles(id).then(render);
  render();
}

async function openTicketRun(id, threadId = "") {
  const ticket = state.tickets.find((item) => item.id === id);
  if (!ticket) {
    logError("ticket_run_open_failed", new Error("Ticket not found"), { id });
    return;
  }

  state.activeId = id;
  state.draft = null;
  state.activeRunTicketId = id;
  state.activeRunThreadId = String(threadId || ticket.lastThreadId || "").trim();
  state.activeThread = null;
  startRunPolling(id);
  loadTicketFiles(id).then(render);
  render();

  if (!state.activeRunThreadId) {
    logEvent("ticket_run_empty", { id });
    return;
  }

  await refreshActiveRun();
  logEvent("ticket_run_opened", { id, threadId: state.activeRunThreadId });
}

function createTicket() {
  state.activeId = "";
  state.draft = createDraft();
  state.activeRunTicketId = "";
  state.activeRunThreadId = "";
  state.activeThread = null;
  stopRunPolling();
  logEvent("ticket_create_started");
  state.filesByTicketId[state.draft.id] = [];
  render();
  elements.stageRoot.querySelector(".title-field")?.focus();
}

function closeStageView() {
  state.activeId = "";
  state.draft = null;
  state.activeRunTicketId = "";
  state.activeRunThreadId = "";
  state.activeThread = null;
  stopRunPolling();
  logEvent("stage_closed");
  render();
}

async function saveDraftFromForm(titleInput, frequencySelect, timeInput) {
  if (!state.draft) {
    logError("ticket_save_failed", new Error("No active draft"));
    return;
  }

  const title = titleInput.value.trim() || "Untitled Ticket";
  const steps = state.draft.steps.map((step) => step.trim()).filter(Boolean);
  const nextTicket = {
    ...state.draft,
    title,
    steps: steps.length ? steps : ["No task description yet."],
    frequency: frequencySelect.value,
    time: frequencySelect.value === "hourly" ? normalizeMinute(timeInput.value) : timeInput.value,
    updatedAt: new Date().toISOString(),
  };

  const existingIndex = state.tickets.findIndex((ticket) => ticket.id === nextTicket.id);
  if (existingIndex >= 0) {
    state.tickets[existingIndex] = nextTicket;
  } else {
    state.tickets.push(nextTicket);
  }

  state.activeId = nextTicket.id;
  await saveTickets();
  logEvent("ticket_saved", { id: nextTicket.id, frequency: nextTicket.frequency });
  state.draft = null;
  render();
}

elements.createTicketButton.addEventListener("click", createTicket);

window.addEventListener("error", (event) => {
  logError("window_error", event.error || event.message);
});
window.addEventListener("unhandledrejection", (event) => {
  logError("unhandled_rejection", event.reason);
});

async function bootstrap() {
  await loadTickets();
  logEvent("app_started", { count: state.tickets.length });
  render();
}

bootstrap();
