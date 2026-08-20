import { matchEvent } from './matcher.js';
import { waitForHlsStream } from './browser.js';

const SCHEDULE_PATHS = [
  '/',
  '/schedule/',
  '/schedule/schedule-stream.php'
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

        const events = await page.locator('.schedule__event').all();

        for (const eventCard of events) {
          const header = eventCard.locator('.schedule__eventHeader');
          let eventText = await header.getAttribute('data-title').catch(() => null);

          if (!eventText) {
            eventText = await eventCard.locator('.schedule__eventTitle').textContent().catch(() => null);
          }

          if (!eventText) continue;
          eventText = eventText.replace(/[\n\t\r]/g, ' ').replace(/\s+/g, ' ').trim();

          const matchedGroups = matchEvent(eventText, groups);
          if (matchedGroups.length > 0) {
            const links = await eventCard.locator('.schedule__channels a[href], a[href]').all();

            for (const link of links) {
              const href = await link.getAttribute('href').catch(() => null);
              const linkText = await link.textContent().catch(() => '');

              if (href && !href.startsWith('javascript:') && !href.startsWith('#')) {
                const fullUrl = new URL(href, page.url()).href;
                if (!eventLinksMap.has(fullUrl)) {
                  eventLinksMap.set(fullUrl, { 
                    event: `${eventText} [${linkText.trim()}]`, 
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
        console.log(`[${sourceConfig.name}] Path ${path} error:`, pathErr.message);
      }
    }

    // Process matched channel pages and click all player buttons
    for (const item of eventLinksMap.values()) {
      console.log(`[${sourceConfig.name}] Target event match: ${item.event}`);
      const eventPage = await context.newPage();

      try {
        await eventPage.goto(item.href, { waitUntil: 'domcontentloaded' });
        await eventPage.waitForTimeout(2000);

        // Find server/player switch buttons on the page (e.g. "Server 1", "Server 2")
        const serverButtons = await eventPage.locator('button[class*="server"], .btn-server, a[href*="stream"], .player-servers button, .servers div').all().catch(() => []);

        // Build list of target frames/pages to inspect
        const targetsToScan = new Set([item.href]);

        const mainIframes = await eventPage.locator('iframe').all().catch(() => []);
        for (const frame of mainIframes) {
          const src = await frame.getAttribute('src').catch(() => null);
          if (src && !src.startsWith('about:') && !src.startsWith('javascript:')) {
            targetsToScan.add(new URL(src, eventPage.url()).href);
          }
        }

        // If server buttons exist, click each to register new dynamic iframes/streams
        if (serverButtons.length > 0) {
          console.log(`[${sourceConfig.name}] Found ${serverButtons.length} player server buttons. Clicking...`);
          for (const btn of serverButtons) {
            await btn.click().catch(() => {});
            await eventPage.waitForTimeout(1500);

            const dynamicIframes = await eventPage.locator('iframe').all().catch(() => []);
            for (const frame of dynamicIframes) {
              const src = await frame.getAttribute('src').catch(() => null);
              if (src && !src.startsWith('about:') && !src.startsWith('javascript:')) {
                targetsToScan.add(new URL(src, eventPage.url()).href);
              }
            }
          }
        }

        // Scan all target players without breaking early
        for (const targetUrl of targetsToScan) {
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
            console.log(`[${sourceConfig.name}] No stream detected on target: ${targetUrl}`);
          } finally {
            await streamPage.close().catch(() => {});
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
