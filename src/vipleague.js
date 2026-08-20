import { matchEvent } from './matcher.js';
import { waitForHlsStream } from './browser.js';

export async function scrapeVipLeague(context, sourceConfig, groups, browserConfig) {
  console.log(`[${sourceConfig.name}] Starting VIPLeague scraper...`);
  const streams = [];
  const page = await context.newPage();
  const eventLinksMap = new Map();

  try {
    const searchTerms = new Set();
    for (const group of groups) {
      if (group.keywords) {
        for (const kw of group.keywords) {
          if (kw.length > 3) searchTerms.add(kw.toLowerCase().trim());
        }
      }
    }

    // First visit base URL to capture actual domain (e.g. vipleague.vg after redirect)
    await page.goto(sourceConfig.baseUrl, { 
      timeout: browserConfig.pageTimeoutMs, 
      waitUntil: 'domcontentloaded' 
    }).catch(() => {});

    const actualBaseUrl = page.url();
    const urlsToScan = new Set([actualBaseUrl]);

    for (const term of searchTerms) {
      const slug = term.replace(/\s+/g, '-');
      urlsToScan.add(new URL(`/finding-${slug}-stream`, actualBaseUrl).href);
    }

    for (const targetUrl of urlsToScan) {
      console.log(`[${sourceConfig.name}] Checking route: ${targetUrl}`);
      try {
        await page.goto(targetUrl, { 
          timeout: browserConfig.pageTimeoutMs, 
          waitUntil: 'domcontentloaded' 
        });

        await page.waitForTimeout(2000);

        // Find all match anchors
        const matchAnchors = await page.locator('a[data-bs-toggle="collapse"], a[title]').all();

        for (const anchor of matchAnchors) {
          let text = await anchor.getAttribute('title').catch(() => null);
          if (!text) {
            text = await anchor.textContent().catch(() => null);
          }
          if (!text) continue;

          text = text.replace(/[\n\t\r]/g, ' ').replace(/\s+/g, ' ').trim();
          if (text.length < 5 || text.length > 300) continue;

          const matchedGroups = matchEvent(text, groups);
          if (matchedGroups.length > 0) {
            console.log(`[${sourceConfig.name}] Match found: ${text}. Expanding accordion...`);

            // Click the anchor to expand the Bootstrap collapse block
            await anchor.click().catch(() => {});
            await page.waitForTimeout(1000);

            // Extract stream buttons anywhere on the page with data-openuri
            const streamButtons = await page.locator('button[data-openuri]').all().catch(() => []);
            const targetUrls = new Set();

            for (const btn of streamButtons) {
              const uri = await btn.getAttribute('data-openuri').catch(() => null);
              if (uri && uri.includes('-streaming-link-')) {
                targetUrls.add(new URL(uri, page.url()).href);
              }
            }

            // Fallback to primary href attribute if accordion failed to expand
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

    // Process player targets
    for (const item of eventLinksMap.values()) {
      console.log(`[${sourceConfig.name}] Checking player page: ${item.href}`);
      const playerPage = await context.newPage();

      try {
        const streamPromise = waitForHlsStream(playerPage, browserConfig.streamWaitMs);
        await playerPage.goto(item.href, { waitUntil: 'domcontentloaded' });

        const iframes = await playerPage.locator('iframe').all().catch(() => []);
        const iframeTargets = new Set();

        for (const frame of iframes) {
          const src = await frame.getAttribute('src').catch(() => null);
          if (src && !src.startsWith('about:') && !src.startsWith('javascript:')) {
            iframeTargets.add(new URL(src, playerPage.url()).href);
          }
        }

        let streamData = await streamPromise;

        if (!streamData && iframeTargets.size > 0) {
          for (const iframeUrl of iframeTargets) {
            const framePage = await context.newPage();
            try {
              console.log(`[${sourceConfig.name}] Checking nested iframe: ${iframeUrl}`);
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
