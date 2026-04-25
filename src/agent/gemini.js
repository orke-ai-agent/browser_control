const fs = require("fs");

function createGeminiHttpError({ task, model, status, payload }) {
  const error = new Error(`Gemini request failed with status ${status}.`);
  error.name = "GeminiHttpError";
  error.task = task;
  error.model = model;
  error.status = Number(status || 0);
  error.payload = payload;
  return error;
}

function extractTextFromResponse(payload) {
  const candidate = payload && payload.candidates && payload.candidates[0];
  const part = candidate && candidate.content && candidate.content.parts && candidate.content.parts[0];
  return part && part.text ? part.text : "";
}

function extractJson(text) {
  const trimmed = text.trim();

  if (!trimmed) {
    throw new Error("Gemini returned an empty response.");
  }

  try {
    return JSON.parse(trimmed);
  } catch (error) {
    const startIndex = trimmed.indexOf("{");
    const endIndex = trimmed.lastIndexOf("}");

    if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
      return JSON.parse(trimmed.slice(startIndex, endIndex + 1));
    }

    throw error;
  }
}

function extractUsage(payload) {
  const usage = payload && payload.usageMetadata ? payload.usageMetadata : {};
  return {
    promptTokens: Number(usage.promptTokenCount || 0),
    candidateTokens: Number(usage.candidatesTokenCount || 0),
    totalTokens: Number(usage.totalTokenCount || 0),
    thoughtsTokens: Number(usage.thoughtsTokenCount || 0),
  };
}

function createGeminiClient({ apiKey, model, logger }) {
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is missing.");
  }

  const resolvedModel = model || "gemini-3-flash-preview";

  async function requestJson({ task, systemInstruction, prompt, imagePath, modelOverride }) {
    const activeModel = modelOverride || resolvedModel;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${activeModel}:generateContent`;
    const parts = [{ text: prompt }];

    if (imagePath) {
      parts.push({
        inline_data: {
          mime_type: "image/png",
          data: fs.readFileSync(imagePath).toString("base64"),
        },
      });
    }

    logger.event("agent.gemini", "request", {
      task,
      model: activeModel,
      hasImage: Boolean(imagePath),
    });

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: systemInstruction }],
        },
        contents: [
          {
            role: "user",
            parts,
          },
        ],
        generationConfig: {
          temperature: 0.35,
          responseMimeType: "application/json",
        },
      }),
    });

    const payload = await response.json();

    if (!response.ok) {
      logger.warn("agent.gemini", "request_failed", {
        task,
        status: response.status,
        payload,
      });
      throw createGeminiHttpError({
        task,
        model: activeModel,
        status: response.status,
        payload,
      });
    }

    const text = extractTextFromResponse(payload);
    const usage = extractUsage(payload);
    logger.event("agent.gemini", "response", {
      task,
      preview: text.slice(0, 240),
      usage,
    });
    return {
      data: extractJson(text),
      usage,
      text,
      model: activeModel,
    };
  }

  return {
    model: resolvedModel,
    requestJson,
  };
}

module.exports = {
  createGeminiClient,
};
