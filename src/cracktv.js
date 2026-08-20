import { matchEvent } from './matcher.js';
import { waitForHlsStream } from './browser.js';

const CATEGORY_PATHS = [
  '/categories/soccer',
  '/categories/football',
  '/categories/basketball',
  '/categories/baseball',
  '/categories/other-events'
];

export async function scrapeCrackTv(context, sourceConfig, groups, browserConfig) {
  console.log(`[${sourceConfig.name}] Starting scan across category sub-pages on ${sourceConfig.baseUrl} ...`);
  const streams = [];
  const page = await context.newPage();
  const eventLinksMap = new Map(); // Store unique matches by absolute URL

  try {
    // 1. Loop through all category sub-pages to extract match links
    for (const catPath of CATEGORY_PATHS) {
      const categoryUrl = new URL(catPath, sourceConfig.baseUrl).href;
      console.log(`[${sourceConfig.name}] Scanning category page: ${categoryUrl}`);

      try {
        await page.goto(categoryUrl, { 
          timeout: browserConfig.pageTimeoutMs,
          waitUntil: 'domcontentloaded' 
        });

        await page.waitForSelector('a', { timeout: 5000 }).catch(() => 
          console.log(`[${sourceConfig.name}] Warning: No links loaded fast enough on ${catPath}.`)
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

            if (text.length < 3 || href.startsWith('javascript:')) continue;

            const matchedGroups = matchEvent(text, groups);
            if (matchedGroups.length > 0) {
              const absoluteUrl = new URL(href, page.url()).href;
              if (!eventLinksMap.has(absoluteUrl)) {
                eventLinksMap.set(absoluteUrl, { event: text, href: absoluteUrl, matchedGroups });
              }
            }
          }
        }
      } catch (catErr) {
        console.error(`[${sourceConfig.name}] Error scanning category ${catPath}:`, catErr.message);
      }
    }

    const eventLinks = Array.from(eventLinksMap.values());

    if (eventLinks.length === 0) {
      console.log(`[${sourceConfig.name}] No matching events found across all categories.`);
    }

    // 2. Process all unique matched event pages
    for (const item of eventLinks) {
      console.log(`[${sourceConfig.name}] Match found: ${item.event}`);
      const eventPage = await context.newPage();

      try {
        const streamPromise = waitForHlsStream(eventPage, browserConfig.streamWaitMs);
        await eventPage.goto(item.href, { waitUntil: 'domcontentloaded' });

        let streamData = await streamPromise;

        // Fallback: check embedded player frames if no stream is caught on main link
        if (!streamData) {
          const iframes = await eventPage.locator('iframe').all();
          for (const iframe of iframes) {
            const src = await iframe.getAttribute('src');
            if (src && !src.startsWith('about:')) {
              const frameUrl = new URL(src, eventPage.url()).href;
              console.log(`[${sourceConfig.name}] Inspecting embedded frame: ${frameUrl}`);
              
              const framePage = await context.newPage();
              try {
                const frameStreamPromise = waitForHlsStream(framePage, browserConfig.streamWaitMs);
                await framePage.goto(frameUrl, { waitUntil: 'domcontentloaded' });
                streamData = await frameStreamPromise;
                if (streamData) break;
              } catch (fErr) {
                // Ignore iframe timeouts
              } finally {
                await framePage.close();
              }
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
        } else {
          console.log(`[${sourceConfig.name}] No .m3u8 detected for: ${item.event}`);
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
