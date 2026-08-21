import fs from 'node:fs/promises';
import { chromium } from 'playwright';

// Import individual scrapers
import { scrapeLiveTv } from './livetv.js';
import { scrapeStreamedSu } from './streamedsu.js';
import { scrapeDaddyLive } from './daddylive.js';
import { scrapeVipLeague } from './vipleague.js';

// Resolve streams.json path dynamically relative to src/main.js
const CONFIG_PATH = new URL('../config/streams.json', import.meta.url);

const SCRAPER_MAP = {
  livetv: scrapeLiveTv,
  streamedsu: scrapeStreamedSu,
  daddylive: scrapeDaddyLive,
  vipleague: scrapeVipLeague,
};

async function main() {
  const config = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf-8'));
  const browser = await chromium.launch({ headless: config.browser.headless });

  const activeSources = config.sources.filter(s => s.enabled);

  console.log(`Starting ${activeSources.length} scrapers in parallel...`);

  // Launch all active scrapers concurrently in isolated contexts
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

  // Wait for all scrapers to settle
  const resultsBySource = await Promise.allSettled(scraperPromises);

  // Combine streams from all successful workers
  const allStreams = [];
  for (const result of resultsBySource) {
    if (result.status === 'fulfilled' && Array.isArray(result.value)) {
      allStreams.push(...result.value);
    }
  }

  await browser.close();

  console.log(`\nAll scrapers finished. Total combined streams found: ${allStreams.length}`);

  // Write output file
  const outputPath = new URL(`../${config.output.file}`, import.meta.url);
  await generateM3u8Output(allStreams, outputPath);
  console.log(`Successfully generated ${config.output.file}`);
}

async function generateM3u8Output(streams, filePath) {
  let content = '#EXTM3U\n';

  for (const stream of streams) {
    const groupName = stream.group?.name || 'Live Sports';
    const logo = stream.group?.logo || '';

    content += `#EXTINF:-1 tvg-logo="${logo}" group-title="${groupName}",${stream.event} (${stream.source})\n`;

    if (stream.headers && Object.keys(stream.headers).length > 0) {
      if (stream.headers['user-agent']) {
        content += `#EXTVLCOPT:http-user-agent=${stream.headers['user-agent']}\n`;
      }
      if (stream.headers['referrer'] || stream.headers['referer']) {
        content += `#EXTVLCOPT:http-referrer=${stream.headers['referrer'] || stream.headers['referer']}\n`;
      }
    }

    content += `${stream.url}\n`;
  }

  await fs.writeFile(filePath, content, 'utf-8');
}

main().catch(console.error);
