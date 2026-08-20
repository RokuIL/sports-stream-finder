import { matchEvent } from './matcher.js';
import { waitForHlsStream } from './browser.js';

export async function scrapeCrackTv(context, sourceConfig, groups, browserConfig) {
  console.log(`[${sourceConfig.name}] Scanning ${sourceConfig.baseUrl} ...`);
  const streams = [];
  const page = await context.newPage();

  try {
    await page.goto(sourceConfig.baseUrl, { 
      timeout: browserConfig.pageTimeoutMs,
      waitUntil: 'domcontentloaded' 
    });

    await page.waitForSelector('a', { timeout: 5000 }).catch(() => 
      console.log(`[${sourceConfig.name}] Warning: No links loaded fast enough.`)
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

        const matchedGroups = matchEvent(text, groups);
        if (matchedGroups.length > 0) {
          eventLinks.push({ event: text, href, matchedGroups });
        }
      }
    }

    if (eventLinks.length === 0) {
      console.log(`[${sourceConfig.name}] No matching events found on portal.`);
    }

    for (const item of eventLinks) {
      console.log(`[${sourceConfig.name}] Match found: ${item.event}`);
      const eventPage = await context.newPage();

      try {
        const urlToVisit = new URL(item.href, page.url()).href;
        
        const streamPromise = waitForHlsStream(eventPage, browserConfig.streamWaitMs);
        await eventPage.goto(urlToVisit, { waitUntil: 'domcontentloaded' });

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
              pageUrl: urlToVisit
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
