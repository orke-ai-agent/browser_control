const DEFAULT_PROFILE = {
  pause: {
    tiny: [20, 70],
    short: [90, 220],
    medium: [220, 700],
    long: [700, 1600],
  },
  typing: {
    keyDelay: [35, 140],
    typoChance: 0.12,
    typoBackspaceDelay: [60, 180],
    thinkingPauseChance: 0.18,
    thinkingPause: [250, 800],
  },
  mouse: {
    stepsFloor: 14,
    stepsCeiling: 42,
    jitter: 2.8,
    overshootChance: 0.34,
    overshootPixels: [8, 24],
    dwellBeforeClick: [80, 220],
    dwellAfterClick: [90, 240],
  },
  scroll: {
    settlePause: [180, 420],
    readLoops: [1, 3],
    readDistance: [180, 520],
  },
};

function randomNumber(min, max) {
  return Math.random() * (max - min) + min;
}

function randomInteger(min, max) {
  return Math.floor(randomNumber(min, max + 1));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createBounds(box) {
  return {
    left: box.x,
    top: box.y,
    right: box.x + box.width,
    bottom: box.y + box.height,
    width: box.width,
    height: box.height,
    centerX: box.x + box.width / 2,
    centerY: box.y + box.height / 2,
  };
}

function isAsciiLetter(character) {
  if (!character) {
    return false;
  }

  const code = character.toLowerCase().charCodeAt(0);
  return code >= 97 && code <= 122;
}

function typoCharacterFor(character) {
  if (!character) {
    return "a";
  }

  if (isAsciiLetter(character)) {
    const fallback = {
      a: "s",
      b: "v",
      c: "x",
      d: "s",
      e: "w",
      f: "d",
      g: "f",
      h: "g",
      i: "u",
      j: "h",
      k: "j",
      l: "k",
      m: "n",
      n: "b",
      o: "i",
      p: "o",
      q: "w",
      r: "e",
      s: "a",
      t: "r",
      u: "y",
      v: "c",
      w: "q",
      x: "z",
      y: "t",
      z: "x",
    };

    return fallback[character.toLowerCase()] || character;
  }

  return character;
}

function resolvePlatformMeta(platform = process.platform) {
  const isMac = platform === "darwin";
  return {
    isMac,
    commandKey: isMac ? "Meta" : "Control",
  };
}

async function resolveLocator(page, target) {
  if (!target) {
    throw new Error("Target is required.");
  }

  if (typeof target === "string") {
    return page.locator(target).first();
  }

  if (typeof target === "object" && typeof target.waitFor === "function") {
    return target;
  }

  throw new Error("Unsupported target. Use a selector string or a Playwright locator.");
}

function distanceBetween(from, to) {
  return Math.hypot(to.x - from.x, to.y - from.y);
}

function createPathPoints(from, to, profile) {
  const distance = distanceBetween(from, to);
  const steps = clamp(
    Math.round(distance / 18),
    profile.mouse.stepsFloor,
    profile.mouse.stepsCeiling,
  );
  const points = [];

  for (let index = 1; index <= steps; index += 1) {
    const progress = index / steps;
    const eased = 1 - Math.pow(1 - progress, 3);
    const sway = Math.sin(progress * Math.PI) * randomNumber(-8, 8);
    const x =
      from.x + (to.x - from.x) * eased + sway * 0.3 + randomNumber(-profile.mouse.jitter, profile.mouse.jitter);
    const y =
      from.y +
      (to.y - from.y) * eased +
      sway +
      randomNumber(-profile.mouse.jitter, profile.mouse.jitter);

    points.push({ x, y });
  }

  return points;
}

async function attemptClipboardWrite(page, text) {
  try {
    return await page.evaluate(async (value) => {
      if (!navigator.clipboard || typeof navigator.clipboard.writeText !== "function") {
        return false;
      }

      await navigator.clipboard.writeText(value);
      return true;
    }, text);
  } catch (error) {
    return false;
  }
}

function createHumanizationWorker({ page, logger, profile = DEFAULT_PROFILE, platform = process.platform }) {
  const workerLog = logger.child("atlas.worker");
  const platformMeta = resolvePlatformMeta(platform);
  const state = {
    cursor: { x: 240, y: 160 },
  };

  async function pause(range, reason) {
    const [min, max] = range;
    const delay = randomInteger(min, max);
    workerLog.event("pause", { reason, delay });
    await page.waitForTimeout(delay);
  }

  async function waitForVisible(target, options = {}) {
    const locator = await resolveLocator(page, target);
    await locator.waitFor({
      state: "visible",
      timeout: options.timeout || 30000,
    });
    return locator;
  }

  async function ensureComfortableViewport(locator) {
    await locator.scrollIntoViewIfNeeded();
    await pause(profile.pause.short, "post-scroll settle");

    const handle = await locator.elementHandle();
    if (!handle) {
      throw new Error("Element handle is not available.");
    }

    const box = await handle.boundingBox();
    if (!box) {
      throw new Error("Target element does not have a bounding box.");
    }

    return createBounds(box);
  }

  async function moveCursorToPoint(point, options = {}) {
    const from = { ...state.cursor };
    let target = { x: point.x, y: point.y };

    if (options.allowOvershoot && Math.random() < profile.mouse.overshootChance) {
      const overshootDistance = randomInteger(
        profile.mouse.overshootPixels[0],
        profile.mouse.overshootPixels[1],
      );
      target = {
        x: point.x + randomNumber(-overshootDistance, overshootDistance),
        y: point.y + randomNumber(-overshootDistance, overshootDistance),
      };
    }

    const pathPoints = createPathPoints(from, target, profile);
    workerLog.event("cursor_move", {
      from,
      target,
      steps: pathPoints.length,
      reason: options.reason || "unspecified",
    });

    for (const pathPoint of pathPoints) {
      await page.mouse.move(pathPoint.x, pathPoint.y, { steps: 1 });
      await wait(randomInteger(profile.pause.tiny[0], profile.pause.tiny[1]));
    }

    state.cursor = { ...target };

    if (options.allowOvershoot && (target.x !== point.x || target.y !== point.y)) {
      await moveCursorToPoint(point, {
        allowOvershoot: false,
        reason: "overshoot correction",
      });
    }
  }

  async function hover(target, options = {}) {
    const locator = await waitForVisible(target, options);
    const bounds = await ensureComfortableViewport(locator);
    const point = {
      x: bounds.centerX + randomNumber(-bounds.width * 0.14, bounds.width * 0.14),
      y: bounds.centerY + randomNumber(-bounds.height * 0.18, bounds.height * 0.18),
    };

    await moveCursorToPoint(point, {
      allowOvershoot: true,
      reason: options.reason || "hover",
    });
    await pause(profile.pause.short, "hover settle");
    return locator;
  }

  async function click(target, options = {}) {
    const locator = await hover(target, { ...options, reason: options.reason || "click target acquisition" });
    await pause(profile.mouse.dwellBeforeClick, "pre-click dwell");
    await page.mouse.down();
    await wait(randomInteger(20, 90));
    await page.mouse.up();
    await pause(profile.mouse.dwellAfterClick, "post-click dwell");
    workerLog.event("click", {
      target: typeof target === "string" ? target : "<locator>",
      note: options.note || "",
    });
    return locator;
  }

  async function clear(locator) {
    await shortcut("selectAll");
    await pause(profile.pause.short, "after select all");
    await page.keyboard.press("Backspace");
    await pause(profile.pause.short, "after clear");

    try {
      await locator.focus();
    } catch (error) {
      workerLog.warn("clear_refocus_skipped", {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function type(target, text, options = {}) {
    const locator = await click(target, {
      ...options,
      reason: options.reason || "focus for typing",
    });

    if (options.clear !== false) {
      await clear(locator);
    }

    workerLog.event("type_start", {
      target: typeof target === "string" ? target : "<locator>",
      length: text.length,
    });

    for (const character of text) {
      if (Math.random() < profile.typing.thinkingPauseChance) {
        await pause(profile.typing.thinkingPause, "thinking while typing");
      }

      if (Math.random() < profile.typing.typoChance) {
        const typo = typoCharacterFor(character);
        await page.keyboard.type(typo, {
          delay: randomInteger(profile.typing.keyDelay[0], profile.typing.keyDelay[1]),
        });
        await pause(profile.typing.typoBackspaceDelay, "typo correction");
        await page.keyboard.press("Backspace");
      }

      await page.keyboard.type(character, {
        delay: randomInteger(profile.typing.keyDelay[0], profile.typing.keyDelay[1]),
      });
    }

    await pause(profile.pause.short, "after type");
    workerLog.event("type_complete", {
      target: typeof target === "string" ? target : "<locator>",
      length: text.length,
    });
    return locator;
  }

  async function press(key, options = {}) {
    workerLog.event("press", { key, note: options.note || "" });
    await pause(profile.pause.tiny, "before key press");
    await page.keyboard.press(key);
    await pause(profile.pause.short, "after key press");
  }

  async function shortcut(name, options = {}) {
    const command = platformMeta.commandKey;
    const shortcuts = {
      copy: `${command}+KeyC`,
      cut: `${command}+KeyX`,
      paste: `${command}+KeyV`,
      redo: platformMeta.isMac ? "Shift+Meta+KeyZ" : "Control+KeyY",
      save: `${command}+KeyS`,
      selectAll: `${command}+KeyA`,
      undo: `${command}+KeyZ`,
    };

    const keyCombo = shortcuts[name] || name;
    workerLog.event("shortcut", { name, keyCombo, note: options.note || "" });
    await page.keyboard.press(keyCombo);
    await pause(profile.pause.short, "after shortcut");
  }

  async function paste(target, text, options = {}) {
    const locator = await click(target, {
      ...options,
      reason: options.reason || "focus for paste",
    });

    if (options.clear !== false) {
      await clear(locator);
    }

    const clipboardWritten = await attemptClipboardWrite(page, text);
    workerLog.event("paste_mode", {
      clipboardWritten,
      length: text.length,
    });

    if (clipboardWritten) {
      await shortcut("paste", { note: "clipboard paste" });
    } else {
      await page.keyboard.insertText(text);
      await pause(profile.pause.short, "fallback insertText after clipboard failure");
    }

    return locator;
  }

  async function scroll(options = {}) {
    const deltaY =
      options.deltaY !== undefined
        ? options.deltaY
        : randomInteger(profile.scroll.readDistance[0], profile.scroll.readDistance[1]);
    const deltaX = options.deltaX || 0;

    workerLog.event("scroll", {
      deltaX,
      deltaY,
      note: options.note || "",
    });
    await page.mouse.wheel(deltaX, deltaY);
    await pause(profile.scroll.settlePause, "scroll settle");
  }

  async function drag(source, target, options = {}) {
    const sourceLocator = await hover(source, { ...options, reason: "drag source acquisition" });
    const sourceBounds = await ensureComfortableViewport(sourceLocator);
    await page.mouse.move(sourceBounds.centerX, sourceBounds.centerY, { steps: 1 });
    state.cursor = { x: sourceBounds.centerX, y: sourceBounds.centerY };
    await pause(profile.pause.short, "before drag hold");
    await page.mouse.down();
    await pause(profile.pause.short, "after drag hold");

    const targetLocator = await waitForVisible(target, options);
    const targetBounds = await ensureComfortableViewport(targetLocator);
    await moveCursorToPoint(
      {
        x: targetBounds.centerX + randomNumber(-targetBounds.width * 0.08, targetBounds.width * 0.08),
        y: targetBounds.centerY + randomNumber(-targetBounds.height * 0.08, targetBounds.height * 0.08),
      },
      {
        allowOvershoot: true,
        reason: "drag move",
      },
    );
    await pause(profile.pause.short, "before drop");
    await page.mouse.up();
    await pause(profile.pause.medium, "after drop");
    workerLog.event("drag_complete", {
      source: typeof source === "string" ? source : "<locator>",
      target: typeof target === "string" ? target : "<locator>",
    });
  }

  async function sampleReadableContent() {
    const snippets = await page
      .locator("h1, h2, h3, button, a, p")
      .evaluateAll((nodes) =>
        nodes
          .map((node) => (node.textContent || "").trim())
          .filter(Boolean)
          .slice(0, 8),
      )
      .catch(() => []);

    workerLog.event("page_glance", { snippets });
  }

  async function read(options = {}) {
    const loops =
      options.loops !== undefined
        ? options.loops
        : randomInteger(profile.scroll.readLoops[0], profile.scroll.readLoops[1]);

    await pause(profile.pause.medium, "post-load initial reading");
    await sampleReadableContent();

    for (let index = 0; index < loops; index += 1) {
      await scroll({
        deltaY: randomInteger(profile.scroll.readDistance[0], profile.scroll.readDistance[1]),
        note: "reading down",
      });
    }

    if (Math.random() < 0.55) {
      await scroll({
        deltaY: -randomInteger(80, 220),
        note: "reading correction up",
      });
    }
  }

  async function waitForPageSettled(options = {}) {
    const timeout = options.timeout || 45000;
    workerLog.event("wait_for_page", { timeout });
    await page.waitForLoadState("domcontentloaded", { timeout });

    try {
      await page.waitForLoadState("networkidle", {
        timeout: options.networkIdleTimeout || 6000,
      });
    } catch (error) {
      workerLog.warn("networkidle_timeout", {
        timeout: options.networkIdleTimeout || 6000,
      });
    }

    await pause(profile.pause.medium, "final settle after page load");
  }

  async function open(url, options = {}) {
    workerLog.event("open", {
      url,
      waitUntil: options.waitUntil || "domcontentloaded",
    });

    await page.goto(url, {
      timeout: options.timeout || 120000,
      waitUntil: options.waitUntil || "domcontentloaded",
    });

    await waitForPageSettled(options);
    await read(options.readOptions || {});
  }

  return {
    click,
    drag,
    hover,
    open,
    paste,
    press,
    read,
    scroll,
    shortcut,
    type,
    waitForPageSettled,
    waitForVisible,
  };
}

module.exports = {
  DEFAULT_PROFILE,
  createHumanizationWorker,
  resolvePlatformMeta,
};
