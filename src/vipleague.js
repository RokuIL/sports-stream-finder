import { matchEvent } from './matcher.js';
import { waitForHlsStream } from './browser.js';

export async function scrapeVipLeague(context, sourceConfig, groups, browserConfig) {
  console.log(`[${sourceConfig.name}] Starting VIPLeague scraper...`);
  const streams = [];
  const page = await context.newPage();
  const eventLinksMap = new Map();

  try {
    // Collect search terms from groups to construct direct search URLs
    const searchTerms = new Set();
    for (const group of groups) {
      if (group.keywords) {
        for (const kw of group.keywords) {
          if (kw.length > 3) searchTerms.add(kw.toLowerCase().trim());
        }
      }
    }

    const urlsToScan = new Set([sourceConfig.baseUrl]);

    // Construct VIPLeague direct finding routes (e.g., /finding-mariners-stream)
    for (const term of searchTerms) {
      const slug = term.replace(/\s+/g, '-');
      urlsToScan.add(new URL(`/finding-${slug}-stream`, sourceConfig.baseUrl).href);
    }

    for (const targetUrl of urlsToScan) {
      console.log(`[${sourceConfig.name}] Checking search page: ${targetUrl}`);
      try {
        await page.goto(targetUrl, { 
          timeout: browserConfig.pageTimeoutMs, 
          waitUntil: 'domcontentloaded' 
        });

        await page.waitForTimeout(2000);

        // Target VIPLeague event links/rows
        const eventElements = await page.locator('a[href*="-stream"], .schedule-item, div[class*="event"]').all();

        for (const el of eventElements) {
          let text = await el.textContent().catch(() => null);
          if (!text) continue;

          text = text.replace(/[\n\t\r]/g, ' ').replace(/\s+/g, ' ').trim();

          // Reject date banners like "Friday, 21-08-2026" or short items
          if (text.length < 6 || text.length > 250) continue;

          const matchedGroups = matchEvent(text, groups);
          if (matchedGroups.length > 0) {
            const href = await el.getAttribute('href').catch(() => null);
            if (href && !href.startsWith('javascript:') && !href.startsWith('#')) {
              const fullUrl = new URL(href, page.url()).href;
              if (!eventLinksMap.has(fullUrl)) {
                eventLinksMap.set(fullUrl, {
                  event: text,
                  href: fullUrl,
                  matchedGroups
                });
              }
            }
          }
        }
      } catch (err) {
        console.log(`[${sourceConfig.name}] Could not scan ${targetUrl}:`, err.message);
      }
    }

    // Process matched event pages to locate player streams
    for (const item of eventLinksMap.values()) {
      console.log(`[${sourceConfig.name}] Found event match: ${item.event}`);
      const eventPage = await context.newPage();

      try {
        await eventPage.goto(item.href, { waitUntil: 'domcontentloaded' });
        await eventPage.waitForTimeout(2000);

        const targetsToScan = new Set([item.href]);

        // Capture server stream buttons or data-url targets
        const playerButtons = await eventPage.locator('button[data-url], a[data-url], .btn-stream, .player-btn').all().catch(() => []);
        for (const btn of playerButtons) {
          const dataUrl = await btn.getAttribute('data-url').catch(() => null);
          if (dataUrl && !dataUrl.startsWith('javascript:')) {
            targetsToScan.add(new URL(dataUrl, eventPage.url()).href);
          }
        }

        // Capture initial iframes
        const iframes = await eventPage.locator('iframe').all().catch(() => []);
        for (const frame of iframes) {
          const src = await frame.getAttribute('src').catch(() => null);
          if (src && !src.startsWith('about:') && !src.startsWith('javascript:')) {
            targetsToScan.add(new URL(src, eventPage.url()).href);
          }
        }

        for (const playerUrl of targetsToScan) {
          const streamPage = await context.newPage();
          try {
            console.log(`[${sourceConfig.name}] Checking player target: ${playerUrl}`);
            const streamPromise = waitForHlsStream(streamPage, browserConfig.streamWaitMs);
            await streamPage.goto(playerUrl, { waitUntil: 'domcontentloaded' });

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
                  pageUrl: playerUrl
                });
              }
            }
          } catch (err) {
            console.log(`[${sourceConfig.name}] No stream on target: ${playerUrl}`);
          } finally {
            await streamPage.close().catch(() => {});
          }
        }
      } catch (err) {
        console.error(`[${sourceConfig.name}] Error scanning event ${item.event}:`, err.message);
      } finally {
        await eventPage.close();
      }
    }
  } catch (err) {
    console.error(`[${sourceConfig.name}] Error in main scraper loop:`, err.message);
  } finally {
    await page.close();
  }

  return streams;
}
