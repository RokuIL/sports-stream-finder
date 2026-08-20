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

        await page.waitForSelector('a', { timeout: 5000 }).catch(() => {});

        const links = await page.locator('a').all();

        for (const link of links) {
          let text = await link.textContent().catch(() => null);
          let href = await link.getAttribute('href').catch(() => null);

          if (text && href) {
            text = text.replace(/[\n\t\r]/g, ' ').replace(/\s+/g, ' ').trim();
            if (text.length < 3 || href.startsWith('javascript:')) continue;

            const matchedGroups = matchEvent(text, groups);
            if (matchedGroups.length > 0) {
              const fullUrl = new URL(href, page.url()).href;
              if (!eventLinksMap.has(fullUrl)) {
                eventLinksMap.set(fullUrl, { event: text, href: fullUrl, matchedGroups });
              }
            }
          }
        }

        if (eventLinksMap.size > 0) break; // Exit path loop if matches found
      } catch (pathErr) {
        console.log(`[${sourceConfig.name}] Schedule path ${path} unavailable:`, pathErr.message);
      }
    }

    for (const item of eventLinksMap.values()) {
      console.log(`[${sourceConfig.name}] Match found: ${item.event}`);
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
