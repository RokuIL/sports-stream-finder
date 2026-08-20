import { matchEvent } from './matcher.js';
import { waitForHlsStream } from './browser.js';

export async function scrapeLiveTv(context, sourceConfig, groups, browserConfig) {
  // Force the URL to use the English directory
  const baseUrlObj = new URL(sourceConfig.baseUrl);
  if (!baseUrlObj.pathname.includes('/enx/')) {
    baseUrlObj.pathname = '/enx/';
  }
  const targetUrl = baseUrlObj.href;

  console.log(`[${sourceConfig.name}] Scanning ${targetUrl} ...`);
  const streams = [];
  const page = await context.newPage();

  try {
    await page.goto(targetUrl, { 
      timeout: browserConfig.pageTimeoutMs,
      waitUntil: 'networkidle' 
    });
    
    // Ensure links actually exist before iterating
    await page.waitForSelector('a', { timeout: 5000 }).catch(() => console.log(`[${sourceConfig.name}] Warning: No links loaded fast enough.`));
    
    const links = await page.locator('a').all();
    const eventLinks = [];

    for (const link of links) {
      let text = await link.textContent();
      let href = await link.getAttribute('href');
      
      if (text && href) {
        // Normalize the text (LiveTV uses heavy whitespace and special dashes)
        text = text.replace(/[\n\t\r]/g, ' ')
                   .replace(/\s+/g, ' ')
                   .replace(/[–—]/g, '-')
                   .trim();
        
        // Skip obvious navigation links to speed up processing
        if (text.length < 5 || href.startsWith('javascript:')) continue;

        const matchedGroups = matchEvent(text, groups);
        if (matchedGroups.length > 0) {
          eventLinks.push({ event: text, href, matchedGroups });
        }
      }
    }

    if (eventLinks.length === 0) {
      console.log(`[${sourceConfig.name}] No matching events found on the page.`);
    }

    // Process matched events
    for (const item of eventLinks) {
      console.log(`[${sourceConfig.name}] Match found: ${item.event}`);
      const eventPage = await context.newPage();
      
      try {
        // Handle LiveTV's highly relative URLs cleanly
        const urlToVisit = new URL(item.href, page.url()).href; 
        
        // Start listening before navigating
        const streamPromise = waitForHlsStream(eventPage, browserConfig.streamWaitMs);
        await eventPage.goto(urlToVisit, { waitUntil: 'domcontentloaded' });
        
        const streamData = await streamPromise;
        if (streamData) {
          console.log(`[${sourceConfig.name}] HLS found: ${streamData.url}`);
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
