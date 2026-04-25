function compact(value) {
  return String(value || "").trim();
}

function uniqueById(items) {
  const map = new Map();
  for (const item of items || []) {
    if (item?.id) {
      map.set(item.id, item);
    }
  }
  return [...map.values()];
}

function createActionController({
  logger,
  store,
  agent,
  loadSettings,
  mediaStore,
}) {
  const actionLogger = logger.child("agent.action_api");

  function applyThreadSettings(threadId) {
    const settings = loadSettings();
    store.updateMeta(threadId, {
      selectedModel: settings.selectedModel,
      stepLimit: settings.stepLimit,
    });
    return settings;
  }

  function ensureThread({ threadId, prompt, forceNewThread = false }) {
    if (!forceNewThread && compact(threadId)) {
      const existingThread = store.getThread(threadId);
      if (existingThread) {
        applyThreadSettings(threadId);
        return existingThread;
      }
    }

    const nextThread = store.createThread({
      title: compact(prompt) || "Untitled action",
    });
    applyThreadSettings(nextThread.id);
    return store.getThread(nextThread.id);
  }

  function attachMediaToThread(threadId, mediaItems) {
    if (!mediaItems.length) {
      return [];
    }

    const thread = store.getThread(threadId);
    const existing = Array.isArray(thread?.meta?.mediaAttachments)
      ? thread.meta.mediaAttachments
      : [];
    const merged = uniqueById([...existing, ...mediaItems]);
    store.updateMeta(threadId, {
      mediaAttachments: merged,
    });
    return merged;
  }

  function ingestMedia(threadId, mediaItems, source) {
    const ingested = [];
    const threadRecords = [];

    for (const item of mediaItems || []) {
      const buffer = item.buffer;
      if (!Buffer.isBuffer(buffer) || !buffer.length) {
        continue;
      }

      const record = mediaStore.saveMedia({
        threadId,
        fileName: item.fileName,
        mimeType: item.mimeType,
        buffer,
        source,
      });
      const clientItem = mediaStore.clientRecord(record);
      ingested.push(clientItem);
      threadRecords.push({
        ...clientItem,
        filePath: record.filePath,
      });
    }

    attachMediaToThread(threadId, threadRecords);
    return ingested;
  }

  async function submit({
    threadId = "",
    prompt = "",
    media = [],
    forceNewThread = false,
    source = "api",
    userMessageKind = "chat",
    userMeta = {},
    runAgent = true,
  }) {
    const normalizedPrompt = compact(prompt);
    const thread = ensureThread({
      threadId,
      prompt: normalizedPrompt || "Media thread",
      forceNewThread,
    });

    const ingestedMedia = ingestMedia(thread.id, media, source);
    const nextMeta = {
      ...userMeta,
      attachments: ingestedMedia,
    };

    actionLogger.event("submit_received", {
      threadId: thread.id,
      source,
      forceNewThread,
      hasPrompt: Boolean(normalizedPrompt),
      mediaCount: ingestedMedia.length,
      userMessageKind,
    });

    if (normalizedPrompt) {
      await agent.submitPrompt(thread.id, normalizedPrompt, {
        userMessageKind,
        userMeta: nextMeta,
      });
    } else if (ingestedMedia.length) {
      store.appendMessage(thread.id, {
        role: "user",
        kind: userMessageKind,
        text: "Media attached",
        meta: nextMeta,
      });
    } else {
      throw new Error("Prompt or media is required.");
    }

    return {
      thread: store.getThread(thread.id),
      media: ingestedMedia,
    };
  }

  return {
    submit,
  };
}

module.exports = {
  createActionController,
};
