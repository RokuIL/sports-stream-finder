import fs from 'node:fs/promises';

/**
 * Checks if a stream URL returns HTTP 200 and a valid M3U8 manifest.
 */
async function verifyStreamUrl(stream, timeoutMs = 5000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers = { ...stream.headers };

    // Set fallback User-Agent if none exists
    if (!headers['user-agent'] && !headers['User-Agent']) {
      headers['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
    }

    const response = await fetch(stream.url, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      console.warn(`[StreamValidator] FAILED (${response.status} ${response.statusText}): ${stream.url}`);
      return false;
    }

    // Read initial body content to ensure it's HLS data, not HTML/error page
    const textSample = await response.text();
    if (textSample.trim().startsWith('#EXTM3U')) {
      return true;
    }

    console.warn(`[StreamValidator] FAILED (Response was not a valid M3U8 manifest): ${stream.url}`);
    return false;
  } catch (err) {
    clearTimeout(timeoutId);
    console.warn(`[StreamValidator] FAILED (${err.name === 'AbortError' ? 'Timeout' : err.message}): ${stream.url}`);
    return false;
  }
}

/**
 * Validates candidate streams and writes valid ones to the playlist output file.
 */
export async function generateM3u8Output(streams, filePath) {
  console.log(`\n[StreamValidator] Validating ${streams.length} candidate streams for Roku compatibility...`);

  // Test all streams in parallel
  const validationResults = await Promise.all(
    streams.map(async (stream) => {
      const isValid = await verifyStreamUrl(stream);
      return isValid ? stream : null;
    })
  );

  const validStreams = validationResults.filter(Boolean);
  console.log(`[StreamValidator] ${validStreams.length}/${streams.length} streams passed validation.\n`);

  let content = '#EXTM3U\n';

  for (const stream of validStreams) {
    const groupName = stream.group?.name || 'Live Sports';
    const logo = stream.group?.logo || '';

    content += `#EXTINF:-1 tvg-logo="${logo}" group-title="${groupName}",${stream.event} (${stream.source})\n`;

    if (stream.headers && Object.keys(stream.headers).length > 0) {
      if (stream.headers['user-agent'] || stream.headers['User-Agent']) {
        content += `#EXTVLCOPT:http-user-agent=${stream.headers['user-agent'] || stream.headers['User-Agent']}\n`;
      }
      if (stream.headers['referrer'] || stream.headers['referer']) {
        content += `#EXTVLCOPT:http-referrer=${stream.headers['referrer'] || stream.headers['referer']}\n`;
      }
    }

    content += `${stream.url}\n`;
  }

  await fs.writeFile(filePath, content, 'utf-8');
}
