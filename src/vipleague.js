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

    console.log(`[${sourceConfig.name}] Derived search terms:`, Array.from(searchTerms));

    // Resolve base URL redirect
    await page.goto(sourceConfig.baseUrl, { 
      timeout: browserConfig.pageTimeoutMs, 
      waitUntil: 'domcontentloaded' 
    }).catch(() => {});

    const actualBaseUrl = page.url();
    console.log(`[${sourceConfig.name}] Resolved base URL: ${actualBaseUrl}`);

    const urlsToScan = new Set();
    for (const term of searchTerms) {
      const slug = term.replace(/\s+/g, '-');
      urlsToScan.add(new URL(`/finding-${slug}-stream`, actualBaseUrl).href);
    }
    urlsToScan.add(actualBaseUrl);

    for (const targetUrl of urlsToScan) {
      console.log(`[${sourceConfig.name}] Navigating to: ${targetUrl}`);
      try {
        await page.goto(targetUrl, { 
          timeout: browserConfig.pageTimeoutMs, 
          waitUntil: 'domcontentloaded' 
        });

        await page.waitForTimeout(2500);

        // Debug: Log total links found on the page
        const allAnchors = await page.locator('a').all();
        console.log(`[${sourceConfig.name}] Total <a> elements on page: ${allAnchors.length}`);

        // Query potential match links
        const matchAnchors = await page.locator('a.btn[title], a[data-bs-toggle="collapse"], a[href*="/baseball/"]').all();
        console.log(`[${sourceConfig.name}] Candidate match anchors found: ${matchAnchors.length}`);

        for (const anchor of matchAnchors) {
          let text = await anchor.getAttribute('title').catch(() => null);
          if (!text) {
            text = await anchor.textContent().catch(() => null);
          }
          if (!text) continue;

          text = text.replace(/[\n\t\r]/g, ' ').replace(/\s+/g, ' ').trim();
          if (text.length < 5 || text.length > 300) continue;

          console.log(`[${sourceConfig.name}] Inspecting text: "${text}"`);

          const matchedGroups = matchEvent(text, groups);
          console.log(`[${sourceConfig.name}] Matcher result for "${text}":`, matchedGroups.length > 0 ? 'MATCH' : 'NO MATCH');

          if (matchedGroups.length > 0) {
            console.log(`[${sourceConfig.name}] Click-expanding accordion for match...`);
            await anchor.click().catch(() => {});
            await page.waitForTimeout(1200);

            const streamButtons = await page.locator('button[data-openuri]').all().catch(() => []);
            console.log(`[${sourceConfig.name}] Found ${streamButtons.length} button[data-openuri] elements post-click.`);

            const targetUrls = new Set();
            for (const btn of streamButtons) {
              const uri = await btn.getAttribute('data-openuri').catch(() => null);
              if (uri && uri.includes('-streaming-link-')) {
                targetUrls.add(new URL(uri, page.url()).href);
              }
            }

            if (targetUrls.size === 0) {
              const mainHref = await anchor.getAttribute('href').catch(() => null);
              if (mainHref && !mainHref.startsWith('javascript:')) {
                targetUrls.add(new URL(mainHref, page.url()).href);
              }
            }

            console.log(`[${sourceConfig.name}] Collected ${targetUrls.size} stream URLs for event.`);

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

        if (eventLinksMap.size > 0) break;
      } catch (err) {
        console.log(`[${sourceConfig.name}] Scan error on ${targetUrl}:`, err.message);
      }
    }

    console.log(`[${sourceConfig.name}] Final total player endpoints to inspect: ${eventLinksMap.size}`);

    // Inspect player endpoints
    for (const item of eventLinksMap.values()) {
      console.log(`[${sourceConfig.name}] Inspecting player page: ${item.href}`);
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
              console.log(`[${sourceConfig.name}] Error inspecting frame ${iframeUrl}`);
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
        console.error(`[${sourceConfig.name}] Error scanning player ${item.href}:`, err.message);
      } finally {
        await playerPage.close().catch(() => {});
      }
    }
  } catch (err) {
    console.error(`[${sourceConfig.name}] Error in scraper execution:`, err.message);
  } finally {
    await page.close();
  }

  return streams;
}
