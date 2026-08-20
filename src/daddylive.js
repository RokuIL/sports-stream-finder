import { matchEvent } from './matcher.js';
import { waitForHlsStream } from './browser.js';

const SCHEDULE_PATHS = [
  '/schedule/schedule-stream.php',
  '/schedule/',
  '/'
];

export async function scrapeDaddyLive(context, sourceConfig, groups, browserConfig) {
  console.log(`[${sourceConfig.name}] Scanning schedule on ${sourceConfig.baseUrl} ...`);
  const streams = [];
  const page = await context.newPage();
  const eventLinksMap = new Map();

  try {
    for (const path of SCHEDULE_PATHS) {
      const scheduleUrl = new URL(path, sourceConfig.baseUrl).href;
      console.log(`[${sourceConfig.name}] Checking ${scheduleUrl} ...`);

      try {
        await page.goto(scheduleUrl, { 
          timeout: browserConfig.pageTimeoutMs,
          waitUntil: 'domcontentloaded' 
        });

        await page.waitForTimeout(3000);

        // Strictly target individual table rows / schedule cards to avoid grabbing wrapper containers
        const rows = await page.locator('tbody tr, table tr, .schedule-item').all();

        for (const row of rows) {
          let rowText = await row.textContent().catch(() => null);
          if (!rowText) continue;

          rowText = rowText.replace(/[\n\t\r]/g, ' ').replace(/\s+/g, ' ').trim();

          // Filter out header rows, empty rows, and giant container text (> 300 chars)
          if (rowText.length < 5 || rowText.length > 300) continue;

          const matchedGroups = matchEvent(rowText, groups);
          if (matchedGroups.length > 0) {
            // Find links strictly belonging to THIS row/match entry
            const rowLinks = await row.locator('a').all();
            for (const link of rowLinks) {
              const href = await link.getAttribute('href').catch(() => null);
              const linkText = await link.textContent().catch(() => '');

              if (href && !href.startsWith('javascript:') && !href.startsWith('#')) {
                const fullUrl = new URL(href, page.url()).href;
                if (!eventLinksMap.has(fullUrl)) {
                  eventLinksMap.set(fullUrl, { 
                    event: `${rowText} [${linkText.trim()}]`, 
                    href: fullUrl, 
                    matchedGroups 
                  });
                }
              }
            }
          }
        }

        if (eventLinksMap.size > 0) break;
      } catch (pathErr) {
        console.log(`[${sourceConfig.name}] Schedule path ${path} error:`, pathErr.message);
      }
    }

    for (const item of eventLinksMap.values()) {
      console.log(`[${sourceConfig.name}] Target event match: ${item.event}`);
      const eventPage = await context.newPage();

      try {
        await eventPage.goto(item.href, { waitUntil: 'domcontentloaded' });

        const playerTargets = new Set([item.href]);
        const iframes = await eventPage.locator('iframe').all().catch(() => []);

        for (const frame of iframes) {
          const src = await frame.getAttribute('src').catch(() => null);
          if (src && !src.startsWith('about:') && !src.startsWith('javascript:')) {
            playerTargets.add(new URL(src, eventPage.url()).href);
          }
        }

        for (const targetUrl of playerTargets) {
          const streamPage = await context.newPage();
          try {
            console.log(`[${sourceConfig.name}] Checking player: ${targetUrl}`);
            const streamPromise = waitForHlsStream(streamPage, browserConfig.streamWaitMs);
            await streamPage.goto(targetUrl, { waitUntil: 'domcontentloaded' });

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
                  pageUrl: targetUrl
                });
              }
            }
          } catch (err) {
            console.log(`[${sourceConfig.name}] No stream on target ${targetUrl}`);
          } finally {
            await streamPage.close();
          }
        }
      } catch (err) {
        console.error(`[${sourceConfig.name}] Error processing event ${item.event}:`, err.message);
      } finally {
        await eventPage.close();
      }
    }
  } catch (err) {
    console.error(`[${sourceConfig.name}] Error scanning site:`, err.message);
  } finally {
    await page.close();
  }

  return streams;
}
