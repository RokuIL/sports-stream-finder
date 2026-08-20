import { matchEvent } from './matcher.js';
import { waitForHlsStream } from './browser.js';

export async function scrapeMainPortal(sourceConfig, groups, browserConfig, context) {
  // Support both context-first or parameter-ordered calls
  const browserCtx = context || sourceConfig;
  const config = context ? sourceConfig : groups;
  const groupRules = context ? groups : browserConfig;
  const settings = context ? browserConfig : arguments[3];

  console.log(`[${config.name}] Scanning ${config.baseUrl} ...`);
  const streams = [];
  const page = await browserCtx.newPage();

  try {
    await page.goto(config.baseUrl, { 
      timeout: settings.pageTimeoutMs,
      waitUntil: 'domcontentloaded' 
    });

    await page.waitForSelector('a', { timeout: 5000 }).catch(() => 
      console.log(`[${config.name}] Warning: No links loaded fast enough.`)
    );

    const links = await page.locator('a').all();
    const eventLinks = [];

    for (const link of links) {
      let text = await link.textContent();
      let href = await link.getAttribute('href');

      if (text && href) {
        text = text.replace(/[\n\t\r]/g, ' ')
                   .replace(/\s+/g, ' ')
                   .replace(/[–—]/g, '-')
                   .trim();

        if (text.length < 3 || href.startsWith('javascript:')) continue;

        const matchedGroups = matchEvent(text, groupRules);
        if (matchedGroups.length > 0) {
          eventLinks.push({ event: text, href, matchedGroups });
        }
      }
    }

    if (eventLinks.length === 0) {
      console.log(`[${config.name}] No matching events found on portal.`);
    }

    for (const item of eventLinks) {
      console.log(`[${config.name}] Match found: ${item.event}`);
      const eventPage = await browserCtx.newPage();

      try {
        const urlToVisit = new URL(item.href, page.url()).href;
        
        // Start network capture before navigating to event page
        const streamPromise = waitForHlsStream(eventPage, settings.streamWaitMs);
        await eventPage.goto(urlToVisit, { waitUntil: 'domcontentloaded' });

        let streamData = await streamPromise;

        // If no stream captured on main page, search for nested player iframes
        if (!streamData) {
          const iframes = await eventPage.locator('iframe').all();
          for (const iframe of iframes) {
            const src = await iframe.getAttribute('src');
            if (src && !src.startsWith('about:')) {
              const frameUrl = new URL(src, eventPage.url()).href;
              console.log(`[${config.name}] Inspecting embedded frame: ${frameUrl}`);
              
              const framePage = await browserCtx.newPage();
              try {
                const frameStreamPromise = waitForHlsStream(framePage, settings.streamWaitMs);
                await framePage.goto(frameUrl, { waitUntil: 'domcontentloaded' });
                streamData = await frameStreamPromise;
                if (streamData) break;
              } catch (fErr) {
                // Ignore iframe navigation timeouts
              } finally {
                await framePage.close();
              }
            }
          }
        }

        if (streamData) {
          console.log(`[${config.name}] HLS stream found: ${streamData.url}`);
          for (const group of item.matchedGroups) {
            streams.push({
              group,
              event: item.event,
              source: config.name,
              url: streamData.url,
              headers: streamData.headers,
              pageUrl: urlToVisit
            });
          }
        } else {
          console.log(`[${config.name}] No .m3u8 detected for: ${item.event}`);
        }
      } catch (err) {
        console.error(`[${config.name}] Error processing event ${item.event}:`, err.message);
      } finally {
        await eventPage.close();
      }
    }
  } catch (err) {
    console.error(`[${config.name}] Error scanning site:`, err.message);
  } finally {
    await page.close();
  }

  return streams;
}
