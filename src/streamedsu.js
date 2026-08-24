import { matchEvent } from './matcher.js';
import { waitForHlsStream } from './browser.js';

// Process N events concurrently (adjust as needed; 3-5 is ideal for GitHub Actions)
const CONCURRENCY_LIMIT = 3;

/**
 * Helper to execute asynchronous tasks in batches to control resource usage.
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
 * Blocks bloat resources (images, fonts, stylesheets, ads) to speed up page loads.
 */
async function configureFastPage(page) {
  await page.route('**/*', (route) => {
    const req = route.request();
    const resourceType = req.resourceType();
    const url = req.url().toLowerCase();

    // Block ads, analytics, images, CSS, and web fonts
    if (
      resourceType === 'image' ||
      resourceType === 'stylesheet' ||
      resourceType === 'font' ||
      url.includes('google-analytics') ||
      url.includes('doubleclick') ||
      url.includes('chatango') ||
      url.includes('popunder') ||
      url.includes('adbanner')
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

  const matchedItems = [];

  try {
    // 1. Fetch main schedule
    await mainPage.goto(sourceConfig.baseUrl, {
      waitUntil: 'domcontentloaded',
      timeout: browserConfig.pageTimeoutMs,
    });

    const eventElements = await mainPage.locator('a[href*="/watch/"]').all();

    for (const el of eventElements) {
      const href = await el.getAttribute('href').catch(() => null);
      let title = await el.textContent().catch(() => '');

      if (!href || !title) continue;

      title = title.replace(/[\n\t\r]/g, ' ').replace(/\s+/g, ' ').trim();
      const matchedGroups = matchEvent(title, groups);

      if (matchedGroups.length > 0) {
        const fullUrl = new URL(href, sourceConfig.baseUrl).href;
        matchedItems.push({
          event: title,
          href: fullUrl,
          matchedGroups,
        });
      }
    }

    console.log(`[${sourceConfig.name}] Found ${matchedItems.length} matching events. Processing in parallel...`);

    // 2. Process events concurrently
    await asyncPool(CONCURRENCY_LIMIT, matchedItems, async (item) => {
      const eventPage = await context.newPage();
      await configureFastPage(eventPage);

      try {
        console.log(`[${sourceConfig.name}] Processing event: ${item.event}`);
        
        // Fast navigate without waiting for external ads to complete loading
        await eventPage.goto(item.href, { 
          waitUntil: 'domcontentloaded', 
          timeout: browserConfig.pageTimeoutMs 
        });

        // Collect all stream stream buttons/links on the event page
        const streamButtons = await eventPage.locator('a[href*="/watch/"], button[data-url]').all();
        const targetsToScan = new Set([item.href]);

        for (const btn of streamButtons) {
          const streamHref = await btn.getAttribute('href').catch(() => null);
          const dataUrl = await btn.getAttribute('data-url').catch(() => null);

          if (streamHref && streamHref.includes('/watch/')) {
            targetsToScan.add(new URL(streamHref, item.href).href);
          }
          if (dataUrl) {
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

              // Start listening for HLS network request immediately
              const streamPromise = waitForHlsStream(streamPage, browserConfig.streamWaitMs);

              // Commit level navigation - proceeds as soon as initial HTML is received
              await streamPage.goto(targetUrl, { 
                waitUntil: 'commit', 
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
