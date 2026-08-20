import { matchEvent } from './matcher.js';
import { waitForHlsStream } from './browser.js';

export async function scrapeLiveTv(context, sourceConfig, groups, browserConfig) {
  console.log(`[${sourceConfig.name}] Scanning ${sourceConfig.baseUrl} ...`);
  const streams = [];
  const page = await context.newPage();

  try {
    // CHANGE 1: Use 'networkidle' to ensure we survive LiveTV's language redirects (e.g. to /enx/)
    await page.goto(sourceConfig.baseUrl, { 
      timeout: browserConfig.pageTimeoutMs,
      waitUntil: 'networkidle' 
    });
    
    // Fallback: Ensure <a> tags actually exist before we start iterating
    await page.waitForSelector('a', { timeout: 5000 }).catch(() => console.log(`[${sourceConfig.name}] Warning: No links loaded fast enough.`));
    
    const links = await page.locator('a').all();
    const eventLinks = [];

    for (const link of links) {
      let text = await link.textContent();
      let href = await link.getAttribute('href');
      
      if (text && href) {
        // CHANGE 2: Normalize the text. LiveTV uses heavy whitespace, newlines, and weird dashes.
        text = text.replace(/[\n\t\r]/g, ' ')      // Remove line breaks and tabs
                   .replace(/\s+/g, ' ')           // Collapse multiple spaces into one
                   .replace(/[–—]/g, '-')          // Convert em/en-dashes to standard hyphens
                   .trim();
        
        // Skip obvious navigation links to speed up processing
        if (text.length < 5 || href.startsWith('javascript:')) continue;

        const matchedGroups = matchEvent(text, groups);
        if (matchedGroups.length > 0) {
          eventLinks.push({ event: text, href, matchedGroups });
        }
        // DEBUGGING TIP: If it still misses the game, uncomment the line below to see exactly how LiveTV is spelling the team names:
        // else if (text.toLowerCase().includes('your_team_name')) { console.log(`[DEBUG] Found text but matcher failed: "${text}"`); }
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
        // CHANGE 3: Handle LiveTV's highly relative URLs cleanly
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
