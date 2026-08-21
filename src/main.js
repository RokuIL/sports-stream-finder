import fs from 'node:fs/promises';
import { chromium } from 'playwright';

import { scrapeLiveTv } from './livetv.js';
import { scrapeStreamedSu } from './streamedsu.js';
import { scrapeDaddyLive } from './daddylive.js';
import { scrapeVipLeague } from './vipleague.js';

import { generateM3u8Output } from './playlist.js';

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

  const scraperPromises = activeSources.map(async (sourceConfig) => {
    const scraperFn = SCRAPER_MAP[sourceConfig.type];
    if (!scraperFn) {
      console.warn(`[${sourceConfig.name}] No scraper implementation found for type: ${sourceConfig.type}`);
      return [];
    }

    const context = await browser.newContext();
    try {
      console.log(`[${sourceConfig.name}] Initializing parallel worker...`);
      return await scraperFn(context, sourceConfig, config.groups, config.browser);
    } catch (err) {
      console.error(`[${sourceConfig.name}] Worker failed:`, err.message);
      return [];
    } finally {
      await context.close().catch(() => {});
    }
  });

  const resultsBySource = await Promise.allSettled(scraperPromises);

  const allStreams = [];
  for (const result of resultsBySource) {
    if (result.status === 'fulfilled' && Array.isArray(result.value)) {
      allStreams.push(...result.value);
    }
  }

  await browser.close();

  console.log(`\nAll scrapers finished. Total combined streams found: ${allStreams.length}`);

  const outputPath = new URL(`../${config.output.file}`, import.meta.url);
  await generateM3u8Output(allStreams, outputPath);
  console.log(`Successfully generated ${config.output.file}`);
}

main().catch(console.error);
