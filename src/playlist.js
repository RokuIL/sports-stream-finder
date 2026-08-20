import fs from 'fs';

export function generatePlaylist(streams, outputPath) {
  let content = '#EXTM3U\n';

  for (const stream of streams) {
    // 1. Strip leading time prefixes (e.g., "18:10 ")
    const cleanEventName = (stream.event || 'Live Event')
      .replace(/^\d{1,2}:\d{2}\s*/, '')
      .trim();

    // 2. Append source name (e.g., "Milwaukee Brewers vs Seattle Mariners (CrackTV)")
    const sourceName = stream.source ? stream.source.trim() : '';
    const displayName = sourceName ? `${cleanEventName} (${sourceName})` : cleanEventName;

    // 3. Extract string group title (handles both object and string configs)
    let groupTitle = 'Sports';
    if (typeof stream.group === 'string') {
      groupTitle = stream.group;
    } else if (stream.group && typeof stream.group === 'object') {
      groupTitle = stream.group.name || stream.group.title || stream.group.id || 'Sports';
    }

    content += `#EXTINF:-1 tvg-id="${displayName}" tvg-name="${displayName}" tvg-provider="Text" group-title="${groupTitle}", ${displayName}\n`;

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
