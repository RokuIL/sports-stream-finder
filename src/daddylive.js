import { matchEvent } from './matcher.js';
import { waitForHlsStream } from './browser.js';

const SCHEDULE_PATHS = [
  '/',
  '/schedule/',
  '/schedule/schedule-stream.php'
];

/**
 * Validates whether a target URL is a legitimate player page or frame,
 * excluding chat embeds, ad banners, and non-player domains.
 */
function isValidPlayerUrl(urlStr) {
  try {
    const parsed = new URL(urlStr);
    const href = parsed.href.toLowerCase();
    const pathname = parsed.pathname.toLowerCase();

    // 1. Blacklist known non-player domains and files
    if (
      parsed.hostname.includes('chatango.com') ||
      href.includes('adbanner') ||
      href.includes('banner') ||
      href.includes('chat') ||
      href.includes('pop') ||
      href.endsWith('.png') ||
      href.endsWith('.jpg') ||
      href.endsWith('.gif')
    ) {
      return false;
    }

    // 2. Allow valid stream/player path structures or query params
    const isValidPath =
      pathname.includes('/stream/') ||
      pathname.includes('/cast/') ||
      pathname.includes('/watch/') ||
      pathname.includes('/plus/') ||
      pathname.includes('/casting/') ||
      pathname.includes('/player/') ||
      pathname.includes('/hub/') ||
      pathname.includes('watch.php') ||
      pathname.includes('stream.php') ||
      pathname.includes('player.php') ||
      pathname.includes('embed.php') ||
      parsed.searchParams.has('id');

    return isValidPath;
  } catch {
    return false;
  }
}

export async function scrapeDaddyLive(context, sourceConfig, groups, browserConfig) {
  console.log(`[${sourceConfig.name}] Scanning schedule on ${sourceConfig.baseUrl} ...`);
  const streams = [];
  const page = await context.newPage();
  const eventLinksMap = new Map();

  try {
    for (const path of SCHEDULE_PATHS) {
      const scheduleUrl = new URL(path, sourceConfig.baseUrl).href;
      console.log(`[${sourceConfig.name}] Checking ${scheduleUrl} ...`);

      try {
        await page.goto(scheduleUrl, { 
          timeout: browserConfig.pageTimeoutMs,
          waitUntil: 'domcontentloaded' 
        });

        await page.waitForTimeout(3000);

        const events = await page.locator('.schedule__event').all();

        for (const eventCard of events) {
          const header = eventCard.locator('.schedule__eventHeader');
          let eventText = await header.getAttribute('data-title').catch(() => null);

          if (!eventText) {
            eventText = await eventCard.locator('.schedule__eventTitle').textContent().catch(() => null);
          }

          if (!eventText) continue;
          eventText = eventText.replace(/[\n\t\r]/g, ' ').replace(/\s+/g, ' ').trim();

          const matchedGroups = matchEvent(eventText, groups);
          if (matchedGroups.length > 0) {
            const links = await eventCard.locator('.schedule__channels a[href], a[href]').all();

            for (const link of links) {
              const href = await link.getAttribute('href').catch(() => null);
              const linkText = await link.textContent().catch(() => '');

              if (href && !href.startsWith('javascript:') && !href.startsWith('#')) {
                const fullUrl = new URL(href, page.url()).href;
                if (!eventLinksMap.has(fullUrl)) {
                  eventLinksMap.set(fullUrl, { 
                    event: `${eventText} [${linkText.trim()}]`, 
                    href: fullUrl, 
                    matchedGroups 
                  });
                }
              }
            }
          }
        }

        if (eventLinksMap.size > 0) break;
      } catch (pathErr) {
        console.log(`[${sourceConfig.name}] Path ${path} error:`, pathErr.message);
      }
    }

    // Process matched channel pages and extract valid player URLs
    for (const item of eventLinksMap.values()) {
      console.log(`[${sourceConfig.name}] Target event match: ${item.event}`);
      const eventPage = await context.newPage();

      try {
        await eventPage.goto(item.href, { waitUntil: 'domcontentloaded' });
        await eventPage.waitForTimeout(2000);

        const rawTargets = new Set();

        // Include landing channel URL if it qualifies
        if (isValidPlayerUrl(item.href)) {
          rawTargets.add(item.href);
        }

        // 1. Extract player links from button data-url attributes
        const playerButtons = await eventPage.locator('button.player-btn, button[data-url]').all().catch(() => []);
        for (const btn of playerButtons) {
          const dataUrl = await btn.getAttribute('data-url').catch(() => null);
          if (dataUrl && !dataUrl.startsWith('javascript:')) {
            rawTargets.add(new URL(dataUrl, eventPage.url()).href);
          }
        }

        // 2. Extract fallback iframe URLs
        const mainIframes = await eventPage.locator('iframe').all().catch(() => []);
        for (const frame of mainIframes) {
          const src = await frame.getAttribute('src').catch(() => null);
          if (src && !src.startsWith('about:') && !src.startsWith('javascript:')) {
            rawTargets.add(new URL(src, eventPage.url()).href);
          }
        }

        // Filter extracted targets using isValidPlayerUrl
        const targetsToScan = Array.from(rawTargets).filter(isValidPlayerUrl);

        console.log(`[${sourceConfig.name}] Found ${targetsToScan.length} valid player targets for ${item.event}`);

        // 3. Scan each valid player target page
        for (const targetUrl of targetsToScan) {
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
            console.log(`[${sourceConfig.name}] No stream detected on target: ${targetUrl}`);
          } finally {
            await streamPage.close().catch(() => {});
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
