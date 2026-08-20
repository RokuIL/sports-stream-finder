import fs from 'fs';

export function generatePlaylist(streams, outputPath) {
  let m3u8 = "#EXTM3U\n\n";
  const seenUrls = new Set();
  let addedCount = 0;

  for (const stream of streams) {
    if (seenUrls.has(stream.url)) continue;
    seenUrls.add(stream.url);

    const logoAttr = stream.group.logo ? ` tvg-logo="${stream.group.logo}"` : "";
    const groupAttr = `group-title="${stream.group.name}"`;
    const displayName = `${stream.event} [${stream.source}]`;
    
    m3u8 += `#EXTINF:-1 ${groupAttr}${logoAttr},${displayName}\n`;

    // Format Referer and Origin requirements
    let urlLine = stream.url;
    const headerParams = [];
    
    if (stream.headers.referer) {
      headerParams.push(`Referer="${stream.headers.referer}"`);
    }
    if (stream.headers.origin) {
      headerParams.push(`Origin="${stream.headers.origin}"`);
    }
    
    if (headerParams.length > 0) {
      urlLine += `|${headerParams.join('&')}`;
    }

    m3u8 += `${urlLine}\n\n`;
    addedCount++;
    console.log(`[Playlist] Added ${displayName}`);
  }

  fs.writeFileSync(outputPath, m3u8, 'utf-8');
  console.log(`[Playlist] Successfully generated ${outputPath} with ${addedCount} streams.`);
}