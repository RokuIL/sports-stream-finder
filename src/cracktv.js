import { matchEvent } from './matcher.js';
import { waitForHlsStream } from './browser.js';

const CATEGORY_PATHS = [
  // '/categories/soccer',
  // '/categories/football',
  // '/categories/basketball',
  '/categories/baseball',
  // '/categories/other-events',
  '/categories/cricket'
];

export async function scrapeCrackTv(context, sourceConfig, groups, browserConfig) {
  console.log(`[${sourceConfig.name}] Starting scan across category sub-pages on ${sourceConfig.baseUrl} ...`);
  const streams = [];
  const page = await context.newPage();
  const eventLinksMap = new Map();

  try {
    // 1. Loop through category sub-pages to collect event links
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

    // 2. Process each event page and extract ALL stream options
    for (const item of eventLinks) {
      console.log(`[${sourceConfig.name}] Match found: ${item.event}`);
      const eventPage = await context.newPage();

      try {
        await eventPage.goto(item.href, { waitUntil: 'domcontentloaded' });

        const streamSources = new Set();

        // Extract custom data-uri attributes from stream buttons
        const dataUriElements = await eventPage.locator('[data-uri]').all().catch(() => []);
        for (const el of dataUriElements) {
          const uri = await el.getAttribute('data-uri').catch(() => null);
          if (uri && !uri.startsWith('javascript:')) {
            try {
              const fullUrl = new URL(uri, eventPage.url()).href;
              streamSources.add(fullUrl);
            } catch (e) {}
          }
        }

        // Extract standard anchor/link elements
        const streamSelectors = [
          'a[href*="stream"]',
          'a[href*="server"]',
          'a[href*="player"]',
          'a[href*="embed"]',
          'a[href*="event"]',
          'a[href*="live"]'
        ];

        for (const selector of streamSelectors) {
          const streamElements = await eventPage.locator(selector).all().catch(() => []);
          for (const el of streamElements) {
            const href = await el.getAttribute('href').catch(() => null);
            if (href && !href.startsWith('javascript:') && !href.startsWith('#')) {
              try {
                const fullUrl = new URL(href, eventPage.url()).href;
                streamSources.add(fullUrl);
              } catch (e) {}
            }
          }
        }

        // Check embedded player iframes
        const iframes = await eventPage.locator('iframe').all().catch(() => []);
        for (const iframe of iframes) {
          const src = await iframe.getAttribute('src').catch(() => null);
          if (src && !src.startsWith('about:') && !src.startsWith('javascript:')) {
            try {
              const frameUrl = new URL(src, eventPage.url()).href;
              streamSources.add(frameUrl);
            } catch (e) {}
          }
        }

        if (streamSources.size === 0) {
          streamSources.add(item.href);
        }

        console.log(`[${sourceConfig.name}] Found ${streamSources.size} potential stream sources for ${item.event}.`);

        // 3. Visit and extract HLS streams from every detected player source
        for (const sourceUrl of streamSources) {
          const streamPage = await context.newPage();

          try {
            console.log(`[${sourceConfig.name}] Checking player: ${sourceUrl}`);
            const streamPromise = waitForHlsStream(streamPage, browserConfig.streamWaitMs);
            await streamPage.goto(sourceUrl, { waitUntil: 'domcontentloaded' });

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
                  pageUrl: sourceUrl
                });
              }
            }
          } catch (sErr) {
            console.log(`[${sourceConfig.name}] No stream on player source ${sourceUrl}`);
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
