import { matchEvent } from './matcher.js';
import { waitForHlsStream } from './browser.js';

const TARGET_PATHS = [
  '/enx/',
  '/enx/allupcoming/'
];

export async function scrapeLiveTv(context, sourceConfig, groups, browserConfig) {
  console.log(`[${sourceConfig.name}] Starting scan across LiveTV main & upcoming pages...`);
  const streams = [];
  const page = await context.newPage();
  const eventLinksMap = new Map();

  try {
    const baseUrlObj = new URL(sourceConfig.baseUrl);

    // 1. Scan both homepage and upcoming schedule pages for matches
    for (const path of TARGET_PATHS) {
      baseUrlObj.pathname = path;
      const targetUrl = baseUrlObj.href;
      console.log(`[${sourceConfig.name}] Scanning ${targetUrl} ...`);

      try {
        await page.goto(targetUrl, { 
          timeout: browserConfig.pageTimeoutMs,
          waitUntil: 'networkidle' 
        });

        await page.waitForSelector('a', { timeout: 5000 }).catch(() => 
          console.log(`[${sourceConfig.name}] Warning: No links loaded fast enough on ${path}.`)
        );

        const links = await page.locator('a').all();

        for (const link of links) {
          let text = await link.textContent();
          let href = await link.getAttribute('href');

          if (text && href) {
            text = text.replace(/[\n\t\r]/g, ' ')
                       .replace(/\s+/g, ' ')
                       .replace(/[–—]/g, '-')
                       .trim();

            if (text.length < 5 || href.startsWith('javascript:')) continue;

            const matchedGroups = matchEvent(text, groups);
            if (matchedGroups.length > 0) {
              const absoluteUrl = new URL(href, page.url()).href;
              if (!eventLinksMap.has(absoluteUrl)) {
                eventLinksMap.set(absoluteUrl, { event: text, href: absoluteUrl, matchedGroups });
              }
            }
          }
        }
      } catch (pathErr) {
        console.error(`[${sourceConfig.name}] Error scanning ${path}:`, pathErr.message);
      }
    }

    const eventLinks = Array.from(eventLinksMap.values());

    if (eventLinks.length === 0) {
      console.log(`[${sourceConfig.name}] No matching events found across scanned pages.`);
    }

    // 2. Process all matched event pages
    for (const item of eventLinks) {
      console.log(`[${sourceConfig.name}] Match found: ${item.event}`);
      const eventPage = await context.newPage();

      try {
        await eventPage.goto(item.href, { waitUntil: 'domcontentloaded' });

        const playerLinks = await eventPage.locator('a[href*="webplayer"]').all();
        const uniquePlayerHrefs = new Set();

        for (const pLink of playerLinks) {
          const href = await pLink.getAttribute('href');
          if (href) uniquePlayerHrefs.add(href);
        }

        console.log(`[${sourceConfig.name}] Found ${uniquePlayerHrefs.size} player links for ${item.event}.`);

        for (const playerHref of uniquePlayerHrefs) {
          const playerUrl = new URL(playerHref, eventPage.url()).href;
          const streamPage = await context.newPage();

          try {
            console.log(`[${sourceConfig.name}] Checking player: ${playerUrl}`);
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
            console.log(`[${sourceConfig.name}] No stream on player ${playerUrl}`);
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
