const { createAtlasSession } = require("./src/atlas");

const TARGET_URL = "https://www.youtube.com/";
const SEARCH_QUERY = "бульба собаки";
const TARGET_VIDEO_INDEX = 5;

const SEARCH_SELECTORS = [
  'input[name="search_query"]',
  'input[placeholder="Search"]',
  "input#search",
];

async function resolveFirstVisible(canvas, selectors) {
  for (const selector of selectors) {
    const locator = canvas.page.locator(selector).first();
    const count = await locator.count();

    if (!count) {
      canvas.logger.event("youtube.search", "selector_missing", { selector });
      continue;
    }

    try {
      await canvas.waitForVisible(locator, { timeout: 10000 });
      canvas.logger.event("youtube.search", "selector_resolved", { selector });
      return locator;
    } catch (error) {
      canvas.logger.error("youtube.search", "selector_wait_failed", error, { selector });
    }
  }

  throw new Error("Could not find a visible YouTube search input.");
}

async function performSearch(canvas, query) {
  const input = await resolveFirstVisible(canvas, SEARCH_SELECTORS);
  await canvas.type(input, query);

  await Promise.all([
    canvas.page.waitForURL("**/results?search_query=*", { timeout: 30000 }),
    canvas.press("Enter"),
  ]);

  const typedValue = (await input.inputValue()).trim();
  canvas.logger.event("youtube.search", "submitted", { query, typedValue });
}

async function waitForResults(canvas) {
  const results = canvas.page.locator("ytd-video-renderer");
  await canvas.waitForVisible(results.first(), { timeout: 30000 });
  await canvas.waitForVisible(results.nth(TARGET_VIDEO_INDEX), { timeout: 30000 });

  const titleLocator = canvas.page.locator("#video-title").first();
  const firstTitle = ((await titleLocator.textContent()) || "").trim();
  canvas.logger.event("youtube.results", "ready", { firstTitle });
}

async function openSixthVideo(canvas) {
  const videoCards = canvas.page.locator("ytd-video-renderer");
  const targetCard = videoCards.nth(TARGET_VIDEO_INDEX);
  await canvas.waitForVisible(targetCard, { timeout: 30000 });

  const titleLink = targetCard.locator("#video-title").first();
  const title = ((await titleLink.textContent()) || "").trim();
  canvas.logger.event("youtube.results", "target_video", {
    index: TARGET_VIDEO_INDEX,
    title,
  });

  await canvas.hover(targetCard);

  await Promise.all([
    canvas.page.waitForURL("**/watch?*", { timeout: 30000 }),
    canvas.click(titleLink, { note: "open target video" }),
  ]);
}

async function main() {
  const session = await createAtlasSession({
    sessionName: "youtube-humanized-demo",
    headless: false,
  });
  const canvas = await session.newCanvas();

  try {
    await canvas.open(TARGET_URL);
    await performSearch(canvas, SEARCH_QUERY);
    await waitForResults(canvas);
    await openSixthVideo(canvas);
    await canvas.read({ loops: 1 });
    canvas.logger.event("demo", "scenario_complete", {
      logFile: session.logFile,
    });
    await canvas.page.waitForTimeout(5000);
  } catch (error) {
    session.logger.error("demo", "fatal", error, {
      logFile: session.logFile,
    });
    process.exitCode = 1;
  } finally {
    await session.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
