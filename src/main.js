import fs from 'node:fs/promises';
import { chromium } from 'playwright';

// Import individual scrapers
import { scrapeLiveTv } from './scrapers/livetv.js';
import { scrapeStreamedSu } from './scrapers/streamedsu.js';
import { scrapeDaddyLive } from './scrapers/daddylive.js';
import { scrapeVipLeague } from './scrapers/vipleague.js';

// Map config "type" to scraper function handlers
const SCRAPER_MAP = {
  livetv: scrapeLiveTv,
  streamedsu: scrapeStreamedSu,
  daddylive: scrapeDaddyLive,
  vipleague: scrapeVipLeague,
};

async function main() {
  const config = JSON.parse(await fs.readFile('./config.json', 'utf-8'));
  const browser = await chromium.launch({ headless: config.browser.headless });
  
  // Isolate each scraper in its own BrowserContext to prevent cookie/session leakage
  const activeSources = config.sources.filter(s => s.enabled);

  console.log(`Starting ${activeSources.length} scrapers in parallel...`);

  // Launch all scrapers concurrently
  const scraperPromises = activeSources.map(async (sourceConfig) => {
    const scraperFn = SCRAPER_MAP[sourceConfig.type];
    if (!scraperFn) {
      console.warn(`[${sourceConfig.name}] No scraper implementation found for type: ${sourceConfig.type}`);
      return [];
    }

    const context = await browser.newContext();
    try {
      console.log(`[${sourceConfig.name}] Initializing parallel worker...`);
      const results = await scraperFn(context, sourceConfig, config.groups, config.browser);
      return results;
    } catch (err) {
      console.error(`[${sourceConfig.name}] Worker failed:`, err.message);
      return [];
    } finally {
      await context.close().catch(() => {});
    }
  });

  // Wait for all scrapers to complete
  const resultsBySource = await Promise.allSettled(scraperPromises);

  // Combine streams from all successful source promises
  const allStreams = [];
  for (const result of resultsBySource) {
    if (result.status === 'fulfilled' && Array.isArray(result.value)) {
      allStreams.push(...result.value);
    }
  }

  await browser.close();

  console.log(`\nAll scrapers finished. Total combined streams found: ${allStreams.length}`);

  // Generate output file (e.g. live.m3u8)
  await generateM3u8Output(allStreams, config.output.file);
  console.log(`Successfully generated ${config.output.file}`);
}

async function generateM3u8Output(streams, filePath) {
  let content = '#EXTM3U\n';

  for (const stream of streams) {
    const groupName = stream.group?.name || 'Live Sports';
    const logo = stream.group?.logo || '';
    
    content += `#EXTINF:-1 tvg-logo="${logo}" group-title="${groupName}",${stream.event} (${stream.source})\n`;
    
    // Add custom HTTP headers if present (e.g., Referer or User-Agent required by video player)
    if (stream.headers && Object.keys(stream.headers).length > 0) {
      const headerString = Object.entries(stream.headers)
        .map(([k, v]) => `${k}=${v}`)
        .join('&');
      content += `#EXTVLCOPT:http-user-agent=${stream.headers['user-agent'] || ''}\n`;
    }
    
    content += `${stream.url}\n`;
  }

  await fs.writeFile(filePath, content, 'utf-8');
}

main().catch(console.error);
