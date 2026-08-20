import { matchEvent } from './matcher.js';
import { waitForHlsStream } from './browser.js';

export async function scrapeLiveTv(context, sourceConfig, groups, browserConfig) {
  console.log(`[${sourceConfig.name}] Scanning ${sourceConfig.baseUrl} ...`);
  const streams = [];
  const page = await context.newPage();

  try {
    await page.goto(sourceConfig.baseUrl, { timeout: browserConfig.pageTimeoutMs });
    
    // Note: Selectors may need adjustment based on live DOM structure
    const links = await page.locator('a').all();
    const eventLinks = [];

    for (const link of links) {
      const text = await link.textContent();
      const href = await link.getAttribute('href');
      if (text && href) {
        const matchedGroups = matchEvent(text.trim(), groups);
        if (matchedGroups.length > 0) {
          eventLinks.push({ event: text.trim(), href, matchedGroups });
        }
      }
    }

    // Process matched events
    for (const item of eventLinks) {
      console.log(`[${sourceConfig.name}] Match found: ${item.event}`);
      const eventPage = await context.newPage();
      
      try {
        const urlToVisit = item.href.startsWith('http') ? item.href : new URL(item.href, sourceConfig.baseUrl).href;
        
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
