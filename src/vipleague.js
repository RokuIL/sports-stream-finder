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
      if (Array.isArray(group.keywords)) {
        for (const kw of group.keywords) {
          if (kw && kw.trim().length > 1) searchTerms.add(kw.toLowerCase().trim());
        }
      } else if (typeof group.keywords === 'string') {
        searchTerms.add(group.keywords.toLowerCase().trim());
      }
      if (group.name) searchTerms.add(group.name.toLowerCase().trim());
      if (group.query) searchTerms.add(group.query.toLowerCase().trim());
      if (group.team) searchTerms.add(group.team.toLowerCase().trim());
    }

    console.log(`[${sourceConfig.name}] Derived search terms:`, Array.from(searchTerms));

    await page.goto(sourceConfig.baseUrl, { 
      timeout: browserConfig.pageTimeoutMs, 
      waitUntil: 'domcontentloaded' 
    }).catch(() => {});

    const actualBaseUrl = page.url();
    const urlsToScan = new Set();

    for (const term of searchTerms) {
      const words = term.split(/\s+/).filter(w => w.length > 2);
      for (const word of words) {
        urlsToScan.add(new URL(`/finding-${word}-stream`, actualBaseUrl).href);
      }
      const fullSlug = term.replace(/\s+/g, '-');
      urlsToScan.add(new URL(`/finding-${fullSlug}-stream`, actualBaseUrl).href);
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

        const matchAnchors = await page.locator('a[data-bs-target], a[title], a[href*="/baseball/"]').all();

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
            console.log(`[${sourceConfig.name}] Match found: "${text}". Triggering accordion...`);

            const targetId = await anchor.getAttribute('data-bs-target').catch(() => null);

            // Trigger JS click directly on element
            await anchor.evaluate(el => el.click()).catch(() => {});
            await page.waitForTimeout(1500);

            let streamButtons = [];

            // If we have a specific target ID (e.g. #675301905), query inside that container
            if (targetId) {
              const container = page.locator(targetId);
              await container.waitFor({ state: 'attached', timeout: 3000 }).catch(() => {});
              streamButtons = await container.locator('button[data-openuri]').all().catch(() => []);
            }

            // Fallback query if targetId isn't present or container yielded 0 buttons
            if (streamButtons.length === 0) {
              streamButtons = await page.locator('button[data-openuri]').all().catch(() => []);
            }

            console.log(`[${sourceConfig.name}] Found ${streamButtons.length} stream buttons for "${text}".`);

            const targetUrls = new Set();
            for (const btn of streamButtons) {
              const uri = await btn.getAttribute('data-openuri').catch(() => null);
              if (uri && uri.includes('-streaming-link-')) {
                targetUrls.add(new URL(uri, page.url()).href);
              }
            }

            // Fallback to primary href if data-openuri buttons are missing
            if (targetUrls.size === 0) {
              const mainHref = await anchor.getAttribute('href').catch(() => null);
              if (mainHref && !mainHref.startsWith('javascript:') && !mainHref.startsWith('#')) {
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

        if (eventLinksMap.size > 0) break;
      } catch (err) {
        console.log(`[${sourceConfig.name}] Scan error on ${targetUrl}:`, err.message);
      }
    }

    console.log(`[${sourceConfig.name}] Total player endpoints collected to inspect: ${eventLinksMap.size}`);

    // Inspect collected player endpoints
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
