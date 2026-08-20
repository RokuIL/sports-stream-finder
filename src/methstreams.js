import { matchEvent } from './matcher.js';
import { waitForHlsStream } from './browser.js';

const MIRRORS = [
  'https://methstreams.cx/',
  'https://methstreams.com/',
  'https://methstreams.net/',
  'https://methstreams.org/',
  'https://methstreams.app/'
];

export async function scrapeMethStreams(context, sourceConfig, groups, browserConfig) {
  const streams = [];
  const page = await context.newPage();
  const eventLinksMap = new Map();

  const mirrorsToTry = [sourceConfig.baseUrl, ...MIRRORS.filter(m => m !== sourceConfig.baseUrl)];

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

  try {
    for (const item of eventLinksMap.values()) {
      console.log(`[${sourceConfig.name}] Match found: ${item.event}`);
      const eventPage = await context.newPage();

      try {
        await eventPage.goto(item.href, { waitUntil: 'domcontentloaded' });

        const playerTargets = new Set();
        const buttons = await eventPage.locator('a[href*="stream"], a[href*="live"], .btn-stream').all().catch(() => []);

        for (const btn of buttons) {
          const href = await btn.getAttribute('href').catch(() => null);
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
    console.error(`[${sourceConfig.name}] Error processing site:`, err.message);
  } finally {
    await page.close();
  }

  return streams;
}
