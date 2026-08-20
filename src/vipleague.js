import { matchEvent } from './matcher.js';
import { waitForHlsStream } from './browser.js';

export async function scrapeVipLeague(context, sourceConfig, groups, browserConfig) {
  console.log(`[${sourceConfig.name}] Scanning ${sourceConfig.baseUrl} ...`);
  const streams = [];
  const page = await context.newPage();
  const eventLinksMap = new Map();

  try {
    await page.goto(sourceConfig.baseUrl, { 
      timeout: browserConfig.pageTimeoutMs,
      waitUntil: 'domcontentloaded' 
    });

    // 1. Leverage Search Bar for Configured Keywords
    const searchInput = page.locator('input[type="search"], input[name="q"], input[id*="search"], input[placeholder*="search" i]').first();
    const isSearchVisible = await searchInput.isVisible().catch(() => false);

    if (isSearchVisible) {
      console.log(`[${sourceConfig.name}] Search bar detected. Running search queries...`);
      for (const group of groups) {
        for (const keyword of (group.keywords || [])) {
          if (!keyword || keyword.length < 3) continue;
          try {
            console.log(`[${sourceConfig.name}] Searching for: "${keyword}"`);
            await searchInput.fill('');
            await searchInput.fill(keyword);
            await searchInput.press('Enter').catch(() => {});
            await page.waitForTimeout(1500);

            const searchLinks = await page.locator('a').all();
            for (const link of searchLinks) {
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
          } catch (sErr) {
            console.log(`[${sourceConfig.name}] Search error for "${keyword}":`, sErr.message);
          }
        }
      }
    }

    // 2. Scan standard category/main page links as fallback/supplement
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

    // 3. Process matched events
    for (const item of eventLinksMap.values()) {
      console.log(`[${sourceConfig.name}] Match found: ${item.event}`);
      const eventPage = await context.newPage();

      try {
        await eventPage.goto(item.href, { waitUntil: 'domcontentloaded' });

        const playerTargets = new Set();
        const serverLinks = await eventPage.locator('a[href*="stream"], a[href*="player"], .btn').all().catch(() => []);

        for (const sLink of serverLinks) {
          const href = await sLink.getAttribute('href').catch(() => null);
          if (href && !href.startsWith('javascript:') && !href.startsWith('#')) {
            playerTargets.add(new URL(href, eventPage.url()).href);
          }
        }

        const iframes = await eventPage.locator('iframe').all().catch(() => []);
        for (const frame of iframes) {
          const src = await frame.getAttribute('src').catch(() => null);
          if (src && !src.startsWith('about:') && !src.startsWith('javascript:')) {
            playerTargets.add(new URL(src, eventPage.url()).href);
          }
        }

        if (playerTargets.size === 0) playerTargets.add(item.href);

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
