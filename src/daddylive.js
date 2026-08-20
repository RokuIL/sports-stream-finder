import { matchEvent } from './matcher.js';
import { waitForHlsStream } from './browser.js';

// Prioritize root '/' since dlhd.pk hosts its active schedule on the main landing page
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

        // Target DaddyLive schedule cards, list items, and fallback rows
        const cards = await page.locator('.event-item, .schedule-item, .event, .row-event, tr').all();

        for (const card of cards) {
          let cardText = await card.textContent().catch(() => null);
          if (!cardText) continue;

          // Clean up formatting
          cardText = cardText.replace(/[\n\t\r]/g, ' ').replace(/\s+/g, ' ').trim();

          // Reject page-level containers and tiny header fragments
          if (cardText.length < 5 || cardText.length > 350) continue;

          const matchedGroups = matchEvent(cardText, groups);
          if (matchedGroups.length > 0) {
            // Locate player/stream links contained within this specific card
            const links = await card.locator('a[href]').all();
            for (const link of links) {
              const href = await link.getAttribute('href').catch(() => null);
              const linkText = await link.textContent().catch(() => '');

              if (href && !href.startsWith('javascript:') && !href.startsWith('#')) {
                const fullUrl = new URL(href, page.url()).href;
                if (!eventLinksMap.has(fullUrl)) {
                  eventLinksMap.set(fullUrl, { 
                    event: `${cardText} [${linkText.trim()}]`, 
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

    // Process matched event pages
    for (const item of eventLinksMap.values()) {
      console.log(`[${sourceConfig.name}] Target event match: ${item.event}`);
      const eventPage = await context.newPage();

      try {
        await eventPage.goto(item.href, { waitUntil: 'domcontentloaded' });
        await eventPage.waitForTimeout(2000);

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
              await streamPage.close();
              break; // Stop after capturing the active player stream
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
