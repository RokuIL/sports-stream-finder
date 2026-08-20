import { matchEvent } from './matcher.js';
import { waitForHlsStream } from './browser.js';

export async function scrapeMainPortal(context, sourceConfig, groups, browserConfig) {
  console.log(`[${sourceConfig.name}] Discovering downstream sites at ${sourceConfig.baseUrl}...`);
  const streams = [];
  const page = await context.newPage();

  try {
    await page.goto(sourceConfig.baseUrl, { timeout: browserConfig.pageTimeoutMs });
    
    // Abstracted discovery: grab iframes or direct links to downstream sports sites
    const downstreamLinks = await page.locator('a').all();
    const downstreamUrls = new Set();
    
    for (const link of downstreamLinks) {
      const href = await link.getAttribute('href');
      if (href && href.startsWith('http')) {
        downstreamUrls.add(href);
      }
    }

    for (const domain of downstreamUrls) {
      console.log(`[${sourceConfig.name}] Checking downstream domain: ${domain}`);
      const sitePage = await context.newPage();
      try {
        await sitePage.goto(domain, { timeout: browserConfig.pageTimeoutMs });
        
        const links = await sitePage.locator('a').all();
        for (const link of links) {
          const text = await link.textContent();
          const href = await link.getAttribute('href');
          
          if (text && href) {
            const matchedGroups = matchEvent(text.trim(), groups);
            if (matchedGroups.length > 0) {
              console.log(`[${sourceConfig.name}] Match found: ${text.trim()}`);
              const eventPage = await context.newPage();
              
              try {
                const urlToVisit = href.startsWith('http') ? href : new URL(href, domain).href;
                const streamPromise = waitForHlsStream(eventPage, browserConfig.streamWaitMs);
                await eventPage.goto(urlToVisit, { waitUntil: 'domcontentloaded' });
                
                const streamData = await streamPromise;
                if (streamData) {
                  console.log(`[${sourceConfig.name}] HLS found: ${streamData.url}`);
                  for (const group of matchedGroups) {
                    streams.push({
                      group,
                      event: text.trim(),
                      source: sourceConfig.name, // Always use base source name
                      url: streamData.url,
                      headers: streamData.headers,
                      pageUrl: urlToVisit
                    });
                  }
                }
              } finally {
                await eventPage.close();
              }
            }
          }
        }
      } catch (err) {
         // Silently ignore unreachable downstream domains to keep logs clean, or log debug
      } finally {
        await sitePage.close();
      }
    }
  } catch (err) {
    console.error(`[${sourceConfig.name}] Error scanning portal:`, err.message);
  } finally {
    await page.close();
  }

  return streams;
}