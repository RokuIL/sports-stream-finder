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

  // 1. Discover matches from mirror homepages
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

  // 2. Extract streams from watch pages
  try {
    for (const item of eventLinksMap.values()) {
      console.log(`[${sourceConfig.name}] Match found: ${item.event}`);
      const eventPage = await context.newPage();

      try {
        // Start listening for HLS network requests immediately
        const streamPromise = waitForHlsStream(eventPage, browserConfig.streamWaitMs + 5000);
        
        await eventPage.goto(item.href, { waitUntil: 'domcontentloaded' });
        await eventPage.waitForTimeout(2000);

        // Click stream source buttons/tabs on page if present
        const streamButtons = await eventPage.locator('button, .btn, [class*="stream"], [id*="stream"], a[href*="stream"]').all().catch(() => []);
        for (const btn of streamButtons.slice(0, 5)) {
          const isVisible = await btn.isVisible().catch(() => false);
          if (isVisible) {
            await btn.click().catch(() => {});
            await eventPage.waitForTimeout(1000);
          }
        }

        // Trigger play actions on any HTML5 video tags in main page or frames
        await eventPage.evaluate(() => {
          document.querySelectorAll('video').forEach(v => v.play().catch(() => {}));
        }).catch(() => {});

        let streamData = await streamPromise;

        // Fallback: If no stream captured directly, scan and navigate all embed frames
        if (!streamData) {
          console.log(`[${sourceConfig.name}] Directly capturing network requests from iframe targets...`);
          const frames = eventPage.frames();
          
          for (const frame of frames) {
            const frameUrl = frame.url();
            if (frameUrl && frameUrl !== 'about:blank' && !frameUrl.includes('google') && !frameUrl.includes('ads')) {
              const framePage = await context.newPage();
              try {
                console.log(`[${sourceConfig.name}] Inspecting embed frame: ${frameUrl}`);
                const frameStreamPromise = waitForHlsStream(framePage, browserConfig.streamWaitMs);
                
                await framePage.goto(frameUrl, { waitUntil: 'domcontentloaded', referrer: item.href });
                
                // Click play overlay if present inside embed frame
                const playBtn = framePage.locator('.play, #play, .vjs-big-play-button, button').first();
                if (await playBtn.isVisible().catch(() => false)) {
                  await playBtn.click().catch(() => {});
                }

                await framePage.evaluate(() => {
                  document.querySelectorAll('video').forEach(v => v.play().catch(() => {}));
                }).catch(() => {});

                streamData = await frameStreamPromise;
                await framePage.close();

                if (streamData) break;
              } catch (e) {
                await framePage.close().catch(() => {});
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
