import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createBrowser } from './browser.js';
import { scrapeLiveTv } from './livetv.js';
import { scrapeStreamedSu } from './streamedsu.js';
import { scrapeDaddyLive } from './daddylive.js';
import { scrapeVipLeague } from './vipleague.js';
import { scrapeMethStreams } from './methstreams.js';
import { generatePlaylist } from './playlist.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const configPath = path.resolve(__dirname, '../config/streams.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  
  const { browser, context } = await createBrowser(config.browser);
  let allStreams = [];

  try {
    for (const source of config.sources) {
      if (!source.enabled) continue;

      if (source.type === 'livetv') {
        const streams = await scrapeLiveTv(context, source, config.groups, config.browser);
        allStreams.push(...streams);
      } else if (source.type === 'streamedsu') {
        const streams = await scrapeStreamedSu(context, source, config.groups, config.browser);
        allStreams.push(...streams);
      } else if (source.type === 'daddylive') {
        const streams = await scrapeDaddyLive(context, source, config.groups, config.browser);
        allStreams.push(...streams);
      } else if (source.type === 'vipleague') {
        const streams = await scrapeVipLeague(context, source, config.groups, config.browser);
        allStreams.push(...streams);
      } else if (source.type === 'methstreams') {
        const streams = await scrapeMethStreams(context, source, config.groups, config.browser);
        allStreams.push(...streams);
      }
    }
  } catch (error) {
    console.error("Critical error during execution:", error);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }

  const outputPath = path.resolve(__dirname, '../', config.output.file);
  generatePlaylist(allStreams, outputPath);
}

main();
