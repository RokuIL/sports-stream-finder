import { matchEvent } from './matcher.js';
import { waitForHlsStream } from './browser.js';

const CONCURRENCY_LIMIT = 3;

/**
 * Executes tasks in batches to keep memory usage low while running in parallel.
 */
async function asyncPool(poolLimit, array, iteratorFn) {
  const ret = [];
  const executing = [];
  for (const item of array) {
    const p = Promise.resolve().then(() => iteratorFn(item, array));
    ret.push(p);

    if (poolLimit <= array.length) {
      const e = p.then(() => executing.splice(executing.indexOf(e), 1));
      executing.push(e);
      if (executing.length >= poolLimit) {
        await Promise.race(executing);
      }
    }
  }
  return Promise.all(ret);
}

/**
 * Blocks heavy non-essential media (images, fonts, video binary files)
 * while letting JavaScript and CSS run normally so video players work.
 */
async function configureFastPage(page) {
  await page.route('**/*', (route) => {
    const req = route.request();
    const resourceType = req.resourceType();
    const url = req.url().toLowerCase();

    // Block only images, fonts, media binaries, and clear ad network trackers
    if (
      resourceType === 'image' ||
      resourceType === 'font' ||
      resourceType === 'media' ||
      url.includes('google-analytics') ||
      url.includes('doubleclick') ||
      url.includes('chatango') ||
      url.includes('popunder')
    ) {
      return route.abort();
    }
    return route.continue();
  });
}

export async function scrapeStreamedSu(context, sourceConfig, groups, browserConfig) {
  console.log(`[${sourceConfig.name}] Fetching schedule from ${sourceConfig.baseUrl}...`);
  const streams = [];

  const mainPage = await context.newPage();
  await configureFastPage(mainPage);

  const matchedItemsMap = new Map();

  try {
    // 1. Fetch main schedule
    await mainPage.goto(sourceConfig.baseUrl, {
      waitUntil: 'domcontentloaded',
      timeout: browserConfig.pageTimeoutMs,
    });

    await mainPage.waitForTimeout(1000);

    const eventElements = await mainPage.locator('a[href*="/watch/"]').all();

    for (const el of eventElements) {
      const href = await el.getAttribute('href').catch(() => null);
      let title = await el.textContent().catch(() => '');

      if (!href || !title) continue;

      title = title.replace(/[\n\t\r]/g, ' ').replace(/\s+/g, ' ').trim();
      const matchedGroups = matchEvent(title, groups);

      if (matchedGroups.length > 0) {
        const fullUrl = new URL(href, sourceConfig.baseUrl).href;
        if (!matchedItemsMap.has(fullUrl)) {
          matchedItemsMap.set(fullUrl, {
            event: title,
            href: fullUrl,
            matchedGroups,
          });
        }
      }
    }

    const matchedItems = Array.from(matchedItemsMap.values());
    console.log(`[${sourceConfig.name}] Found ${matchedItems.length} matching unique events. Processing in parallel...`);

    // 2. Process matched events concurrently
    await asyncPool(CONCURRENCY_LIMIT, matchedItems, async (item) => {
      const eventPage = await context.newPage();
      await configureFastPage(eventPage);

      try {
        console.log(`[${sourceConfig.name}] Processing event: ${item.event}`);

        await eventPage.goto(item.href, { 
          waitUntil: 'domcontentloaded', 
          timeout: browserConfig.pageTimeoutMs 
        });

        await eventPage.waitForTimeout(1500);

        // Extract sub-stream links on the event page
        const streamButtons = await eventPage.locator('a[href*="/watch/"], button[data-url], .stream-btn').all().catch(() => []);
        const targetsToScan = new Set([item.href]);

        for (const btn of streamButtons) {
          const streamHref = await btn.getAttribute('href').catch(() => null);
          const dataUrl = await btn.getAttribute('data-url').catch(() => null);

          if (streamHref && streamHref.includes('/watch/')) {
            targetsToScan.add(new URL(streamHref, item.href).href);
          }
          if (dataUrl && !dataUrl.startsWith('javascript:')) {
            targetsToScan.add(new URL(dataUrl, item.href).href);
          }
        }

        // Process streams within this event concurrently
        await Promise.all(
          Array.from(targetsToScan).map(async (targetUrl) => {
            const streamPage = await context.newPage();
            await configureFastPage(streamPage);

            try {
              console.log(`[${sourceConfig.name}] Navigating to stream route: ${targetUrl}`);

              // Start HLS request listener before loading the URL
              const streamPromise = waitForHlsStream(streamPage, browserConfig.streamWaitMs);

              await streamPage.goto(targetUrl, { 
                waitUntil: 'domcontentloaded', 
                timeout: browserConfig.pageTimeoutMs 
              });

              const streamData = await streamPromise;

              if (streamData) {
                console.log(`[${sourceConfig.name}] HLS stream found: ${streamData.url}`);
                for (const group of item.matchedGroups) {
                  streams.push({
                    group,
                    event: item.event,
                    source: sourceConfig.name,
                    url: streamData.url,
                    headers: streamData.headers,
                    pageUrl: targetUrl,
                  });
                }
              }
            } catch (err) {
              console.log(`[${sourceConfig.name}] Stream capture timed out for: ${targetUrl}`);
            } finally {
              await streamPage.close().catch(() => {});
            }
          })
        );
      } catch (err) {
        console.error(`[${sourceConfig.name}] Error scraping ${item.event}:`, err.message);
      } finally {
        await eventPage.close().catch(() => {});
      }
    });
  } catch (err) {
    console.error(`[${sourceConfig.name}] Error processing schedule:`, err.message);
  } finally {
    await mainPage.close().catch(() => {});
  }

  return streams;
}
