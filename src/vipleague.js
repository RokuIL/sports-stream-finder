import { matchEvent } from './matcher.js';
import { waitForHlsStream } from './browser.js';

export async function scrapeVipLeague(context, sourceConfig, groups, browserConfig) {
  console.log(`[${sourceConfig.name}] Starting VIPLeague scraper...`);
  const streams = [];
  const page = await context.newPage();
  const eventLinksMap = new Map();

  try {
    // Collect search keywords from groups
    const searchTerms = new Set();
    for (const group of groups) {
      if (group.keywords) {
        for (const kw of group.keywords) {
          if (kw.length > 3) searchTerms.add(kw.toLowerCase().trim());
        }
      }
    }

    const urlsToScan = new Set([sourceConfig.baseUrl]);

    // Construct direct VIPLeague search paths
    for (const term of searchTerms) {
      const slug = term.replace(/\s+/g, '-');
      urlsToScan.add(new URL(`/finding-${slug}-stream`, sourceConfig.baseUrl).href);
    }

    for (const targetUrl of urlsToScan) {
      console.log(`[${sourceConfig.name}] Checking route: ${targetUrl}`);
      try {
        await page.goto(targetUrl, { 
          timeout: browserConfig.pageTimeoutMs, 
          waitUntil: 'domcontentloaded' 
        });

        await page.waitForTimeout(2000);

        // Select collapsible match links
        const matchAnchors = await page.locator('a[data-bs-toggle="collapse"], a[href*="-streaming"]').all();

        for (const anchor of matchAnchors) {
          let text = await anchor.textContent().catch(() => null);
          if (!text) continue;

          text = text.replace(/[\n\t\r]/g, ' ').replace(/\s+/g, ' ').trim();
          if (text.length < 5 || text.length > 300) continue;

          const matchedGroups = matchEvent(text, groups);
          if (matchedGroups.length > 0) {
            // Find accordion container target or sibling collapse element
            const targetId = await anchor.getAttribute('data-bs-target').catch(() => null);
            let container = null;

            if (targetId) {
              container = page.locator(targetId);
            } else {
              // Fallback to parent container if data-bs-target isn't present
              container = anchor.locator('..');
            }

            // Extract all data-openuri stream endpoints inside accordion
            const streamButtons = await container.locator('button[data-openuri], a[data-openuri]').all().catch(() => []);
            const targetUrls = new Set();

            for (const btn of streamButtons) {
              const uri = await btn.getAttribute('data-openuri').catch(() => null);
              // Ignore external ads (like hai8g.com) and only keep internal relative stream links
              if (uri && !uri.startsWith('http://') && !uri.startsWith('https://') && uri.includes('-streaming-link-')) {
                targetUrls.add(new URL(uri, page.url()).href);
              }
            }

            // Fallback: If no inline accordion buttons are found, fallback to main anchor href
            if (targetUrls.size === 0) {
              const mainHref = await anchor.getAttribute('href').catch(() => null);
              if (mainHref && !mainHref.startsWith('javascript:')) {
                targetUrls.add(new URL(mainHref, page.url()).href);
              }
            }

            for (const playerUrl of targetUrls) {
              if (!eventLinksMap.has(playerUrl)) {
                eventLinksMap.set(playerUrl, {
                  event: text,
                  href: playerUrl,
                  matchedGroups
                });
              }
            }
          }
        }
      } catch (err) {
        console.log(`[${sourceConfig.name}] Error reading route ${targetUrl}:`, err.message);
      }
    }

    console.log(`[${sourceConfig.name}] Found ${eventLinksMap.size} total player endpoints to inspect.`);

    // Process player targets and sniff HLS manifest URLs
    for (const item of eventLinksMap.values()) {
      console.log(`[${sourceConfig.name}] Checking player page: ${item.href}`);
      const playerPage = await context.newPage();

      try {
        const streamPromise = waitForHlsStream(playerPage, browserConfig.streamWaitMs);
        await playerPage.goto(item.href, { waitUntil: 'domcontentloaded' });

        // If player loads an iframe, inspect internal iframe sources
        const iframes = await playerPage.locator('iframe').all().catch(() => []);
        const iframeTargets = new Set();

        for (const frame of iframes) {
          const src = await frame.getAttribute('src').catch(() => null);
          if (src && !src.startsWith('about:') && !src.startsWith('javascript:')) {
            iframeTargets.add(new URL(src, playerPage.url()).href);
          }
        }

        let streamData = await streamPromise;

        // If no stream was caught on the parent page, try loading nested iframe targets directly
        if (!streamData && iframeTargets.size > 0) {
          for (const iframeUrl of iframeTargets) {
            const framePage = await context.newPage();
            try {
              console.log(`[${sourceConfig.name}] Checking nested iframe target: ${iframeUrl}`);
              const frameStreamPromise = waitForHlsStream(framePage, browserConfig.streamWaitMs);
              await framePage.goto(iframeUrl, { waitUntil: 'domcontentloaded' });

              streamData = await frameStreamPromise;
              if (streamData) {
                await framePage.close();
                break;
              }
            } catch (frameErr) {
              console.log(`[${sourceConfig.name}] Frame inspect failed on ${iframeUrl}`);
            } finally {
              await framePage.close().catch(() => {});
            }
          }
        }

        if (streamData) {
          console.log(`[${sourceConfig.name}] HLS stream found: ${streamData.url}`);
          for (const group of item.matchedGroups) {
            streams.push({
              group,
              event: item.event,
              source: sourceConfig.name,
              url: streamData.url,
              headers: streamData.headers,
              pageUrl: item.href
            });
          }
        }
      } catch (err) {
        console.error(`[${sourceConfig.name}] Error processing player ${item.href}:`, err.message);
      } finally {
        await playerPage.close().catch(() => {});
      }
    }
  } catch (err) {
    console.error(`[${sourceConfig.name}] Error in main scraper loop:`, err.message);
  } finally {
    await page.close();
  }

  return streams;
}
