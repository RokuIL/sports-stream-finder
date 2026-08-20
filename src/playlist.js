import fs from 'fs';

export function generatePlaylist(streams, outputPath) {
  let content = '#EXTM3U\n';

  for (const stream of streams) {
    const eventName = stream.event;
    const groupTitle = stream.group || 'Sports';

    // Set tvg-id to stream name and tvg-provider to "Text"
    content += `#EXTINF:-1 tvg-id="${eventName}" tvg-name="${eventName}" tvg-provider="Text" group-title="${groupTitle}", ${eventName}\n`;

    // Append network headers if available
    if (stream.headers) {
      const referer = stream.headers['referer'] || stream.headers['Referer'];
      const origin = stream.headers['origin'] || stream.headers['Origin'];
      const userAgent = stream.headers['user-agent'] || stream.headers['User-Agent'];

      if (referer) {
        content += `#EXTVLCOPT:http-referrer=${referer}\n`;
      }
      if (origin) {
        content += `#EXTVLCOPT:http-origin=${origin}\n`;
      }
      if (userAgent) {
        content += `#EXTVLCOPT:http-user-agent=${userAgent}\n`;
      }
    }

    content += `${stream.url}\n`;
  }

  fs.writeFileSync(outputPath, content, 'utf-8');
  console.log(`Playlist successfully generated at ${outputPath}`);
}
