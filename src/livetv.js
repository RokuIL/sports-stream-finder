import { matchEvent } from './matcher.js';
import { waitForHlsStream } from './browser.js';

export async function scrapeLiveTv(context, sourceConfig, groups, browserConfig) {
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
    
    await page.waitForSelector('a', { timeout: 5000 }).catch(() => console.log(`[${sourceConfig.name}] Warning: No links loaded fast enough.`));
    
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
        const urlToVisit = new URL(item.href, page.url()).href; 
        await eventPage.goto(urlToVisit, { waitUntil: 'domcontentloaded' });
        
        const playerLinks = await eventPage.locator('a[href*="webplayer"]').all();
        const uniquePlayerHrefs = new Set();
        
        for (const pLink of playerLinks) {
          const href = await pLink.getAttribute('href');
          if (href) uniquePlayerHrefs.add(href);
        }

        console.log(`[${sourceConfig.name}] Found ${uniquePlayerHrefs.size} player links for ${item.event}.`);

        // Process ALL player links to collect every valid stream
        for (const playerHref of uniquePlayerHrefs) {
          const playerUrl = new URL(playerHref, eventPage.url()).href;
          const streamPage = await context.newPage();
          
          try {
            console.log(`[${sourceConfig.name}] Checking player: ${playerUrl}`);
            const streamPromise = waitForHlsStream(streamPage, browserConfig.streamWaitMs);
            await streamPage.goto(playerUrl, { waitUntil: 'domcontentloaded' });
            
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
                  pageUrl: playerUrl
                });
              }
            }
          } catch (err) {
            console.log(`[${sourceConfig.name}] No stream on player ${playerUrl}`);
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
