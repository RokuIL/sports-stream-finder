import fs from 'fs';

export function generatePlaylist(streams, outputPath) {
  let content = '#EXTM3U\n';

  for (const stream of streams) {
    const cleanEventName = (stream.event || 'Live Event')
      .replace(/^\d{1,2}:\d{2}\s*/, '')
      .trim();

    const sourceName = stream.source ? stream.source.trim() : '';
    const displayName = sourceName ? `${cleanEventName} (${sourceName})` : cleanEventName;

    let groupTitle = 'Sports';
    if (typeof stream.group === 'string') {
      groupTitle = stream.group;
    } else if (stream.group && typeof stream.group === 'object') {
      groupTitle = stream.group.name || stream.group.title || stream.group.id || 'Sports';
    }

    content += `#EXTINF:-1 tvg-id="${displayName}" tvg-name="${displayName}" tvg-provider="Text" group-title="${groupTitle}", ${displayName}\n`;

    let finalUrl = stream.url;

    // Append headers using pipe (|) query syntax
    if (stream.headers) {
      const referer = stream.headers['referer'] || stream.headers['Referer'];
      const origin = stream.headers['origin'] || stream.headers['Origin'];

      const headerParams = [];
      if (referer) headerParams.push(`Referer=${referer}`);
      if (origin) headerParams.push(`Origin=${origin}`);

      if (headerParams.length > 0) {
        finalUrl += `|${headerParams.join('&')}`;
      }
    }

    content += `${finalUrl}\n`;
  }

  fs.writeFileSync(outputPath, content, 'utf-8');
  console.log(`Playlist successfully generated at ${outputPath}`);
}
