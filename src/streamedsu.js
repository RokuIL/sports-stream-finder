import { matchEvent } from './matcher.js';
import { waitForHlsStream } from './browser.js';

const MIRRORS = [
  'https://streamed.pk/',
  'https://streamed.st/',
  'https://streamed.su/'
];

export async function scrapeStreamedSu(context, sourceConfig, groups, browserConfig) {
  const streams = [];
  const page = await context.newPage();
  const eventLinksMap = new Map();

  const mirrorsToTry = [sourceConfig.baseUrl, ...MIRRORS.filter(m => m !== sourceConfig.baseUrl)];

  // 1. Discover match events on the main page/schedule
  for (const baseUrl of mirrorsToTry) {
    console.log(`[${sourceConfig.name}] Trying mirror ${baseUrl} ...`);
    try {
      await page.goto(baseUrl, { 
        timeout: 12000,
        waitUntil: 'domcontentloaded' 
      });

      await page.waitForSelector('a', { timeout: 4000 }).catch(() => {});
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

      if (eventLinksMap.size > 0) break;
    } catch (err) {
      console.log(`[${sourceConfig.name}] Mirror ${baseUrl} failed:`, err.message);
    }
  }

  // 2. Extract individual stream sub-routes and capture player network requests
  try {
    for (const item of eventLinksMap.values()) {
      console.log(`[${sourceConfig.name}] Match found: ${item.event}`);
      const eventPage = await context.newPage();

      try {
        await eventPage.goto(item.href, { waitUntil: 'domcontentloaded' });
        await eventPage.waitForTimeout(2000);

        // Parse individual stream links (e.g. /watch/slug/admin/1)
        const subStreamLinks = [];
        const links = await eventPage.locator('a[href*="/watch/"]').all().catch(() => []);

        for (const link of links) {
          const href = await link.getAttribute('href').catch(() => null);
          if (href) {
            const fullUrl = new URL(href, eventPage.url()).href;
            // Target extended sub-routes (longer than main event URL)
            if (fullUrl !== item.href && fullUrl.length > item.href.length) {
              if (!subStreamLinks.includes(fullUrl)) {
                subStreamLinks.push(fullUrl);
              }
            }
          }
        }

        console.log(`[${sourceConfig.name}] Found ${subStreamLinks.length} sub-stream routes for ${item.event}`);

        const targetsToProcess = subStreamLinks.length > 0 ? subStreamLinks : [item.href];
        let streamData = null;

        for (const targetUrl of targetsToProcess.slice(0, 4)) {
          console.log(`[${sourceConfig.name}] Navigating to stream route: ${targetUrl}`);
          const streamPage = await context.newPage();

          try {
            const streamPromise = waitForHlsStream(streamPage, browserConfig.streamWaitMs);
            await streamPage.goto(targetUrl, { waitUntil: 'domcontentloaded' });

            await streamPage.waitForTimeout(3000);

            // Trigger play actions on video elements
            await streamPage.evaluate(() => {
              document.querySelectorAll('video').forEach(v => v.play().catch(() => {}));
            }).catch(() => {});

            streamData = await streamPromise;

            // Check inside embedded player iframe if not captured directly
            if (!streamData) {
              const iframes = await streamPage.locator('iframe').all().catch(() => []);
              for (const frame of iframes) {
                const src = await frame.getAttribute('src').catch(() => null);
                if (src && !src.startsWith('about:') && !src.startsWith('javascript:')) {
                  const frameUrl = new URL(src, streamPage.url()).href;
                  const framePage = await context.newPage();
                  try {
                    console.log(`[${sourceConfig.name}] Checking embed player frame: ${frameUrl}`);
                    const framePromise = waitForHlsStream(framePage, browserConfig.streamWaitMs);
                    await framePage.goto(frameUrl, { waitUntil: 'domcontentloaded', referrer: targetUrl });
                    streamData = await framePromise;
                    await framePage.close();
                    if (streamData) break;
                  } catch (e) {
                    await framePage.close().catch(() => {});
                  }
                }
              }
            }

            await streamPage.close();

            if (streamData) break;
          } catch (err) {
            console.log(`[${sourceConfig.name}] Error checking route ${targetUrl}:`, err.message);
            await streamPage.close().catch(() => {});
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
          console.log(`[${sourceConfig.name}] No HLS stream detected for ${item.event}`);
        }
      } catch (err) {
        console.error(`[${sourceConfig.name}] Error processing event ${item.event}:`, err.message);
      } finally {
        await eventPage.close();
      }
    }
  } catch (err) {
    console.error(`[${sourceConfig.name}] Error processing site:`, err.message);
  } finally {
    await page.close();
  }

  return streams;
}
