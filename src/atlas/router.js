const { createHumanizationWorker } = require("./worker");

function createAtlasRouter({ page, logger, profile, platform }) {
  const worker = createHumanizationWorker({
    page,
    logger,
    profile,
    platform,
  });

  return {
    page,
    logger,

    locator(target) {
      return typeof target === "string" ? page.locator(target) : target;
    },

    async open(url, options) {
      return worker.open(url, options);
    },

    async read(options) {
      return worker.read(options);
    },

    async waitForVisible(target, options) {
      return worker.waitForVisible(target, options);
    },

    async hover(target, options) {
      return worker.hover(target, options);
    },

    async click(target, options) {
      return worker.click(target, options);
    },

    async type(target, text, options) {
      return worker.type(target, text, options);
    },

    async insert(target, text, options) {
      return worker.type(target, text, options);
    },

    async paste(target, text, options) {
      return worker.paste(target, text, options);
    },

    async press(key, options) {
      return worker.press(key, options);
    },

    async shortcut(name, options) {
      return worker.shortcut(name, options);
    },

    async scroll(options) {
      return worker.scroll(options);
    },

    async drag(source, target, options) {
      return worker.drag(source, target, options);
    },

    async settle(options) {
      return worker.waitForPageSettled(options);
    },
  };
}

module.exports = {
  createAtlasRouter,
};
