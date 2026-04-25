const path = require("path");
const { chromium, firefox, webkit } = require("playwright");
const { createLogger } = require("./logger");
const { createAtlasRouter } = require("./router");

const BROWSER_TYPES = {
  chromium,
  firefox,
  webkit,
};

function attachContextLogging(context, logger) {
  context.on("requestfailed", (request) => {
    logger.warn("browser.context", "request_failed", {
      method: request.method(),
      url: request.url(),
      failure: request.failure() ? request.failure().errorText : "unknown_failure",
    });
  });
}

function attachPageLogging(page, logger) {
  page.on("pageerror", (error) => {
    logger.error("browser.page", "page_error", error);
  });
}

async function createAtlasSession(options = {}) {
  const browserName = options.browserName || "chromium";
  const browserType = BROWSER_TYPES[browserName];

  if (!browserType) {
    throw new Error(`Unsupported browser "${browserName}".`);
  }

  const logger = options.logger
    ? options.logger
    : createLogger({
        rootDir: options.logDir || path.join(process.cwd(), "logs"),
        sessionName: options.sessionName || "atlas",
      });

  logger.event("atlas.session", "create_session", {
    browserName,
    headless: options.headless ?? false,
    userDataDir: options.userDataDir || "",
    logFile: logger.filePath,
  });

  let browser = options.browser || null;
  let context = options.context || null;
  const usePersistentContext =
    Boolean(options.userDataDir) && !options.browser && !options.context;

  if (usePersistentContext) {
    context = await browserType.launchPersistentContext(options.userDataDir, {
      headless: options.headless ?? false,
      ...options.launchOptions,
      ...options.contextOptions,
    });
    browser = context.browser();
  } else {
    browser =
      browser ||
      (await browserType.launch({
        headless: options.headless ?? false,
        ...options.launchOptions,
      }));

    context =
      context ||
      (await browser.newContext({
        ...options.contextOptions,
      }));
  }

  attachContextLogging(context, logger);

  return {
    browser,
    context,
    logger,
    logFile: logger.filePath,

    async newCanvas(pageOptions = {}) {
      const page = await context.newPage(pageOptions);
      attachPageLogging(page, logger);
      logger.event("atlas.session", "new_canvas", {
        url: page.url(),
      });
      return createAtlasRouter({
        page,
        logger,
        profile: options.profile,
        platform: options.platform,
      });
    },

    async attachToPage(page) {
      attachPageLogging(page, logger);
      return createAtlasRouter({
        page,
        logger,
        profile: options.profile,
        platform: options.platform,
      });
    },

    async close() {
      logger.event("atlas.session", "close_session", {});
      await context.close().catch((error) => logger.error("atlas.session", "context_close_error", error));

      if (!usePersistentContext && !options.browser && browser) {
        await browser.close().catch((error) => logger.error("atlas.session", "browser_close_error", error));
      }
    },
  };
}

module.exports = {
  createAtlasRouter,
  createAtlasSession,
};
