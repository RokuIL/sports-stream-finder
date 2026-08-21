import fs from 'node:fs/promises';

/**
 * Validates whether an HLS stream URL is active from a stateless request.
 */
async function verifyStreamUrl(stream, timeoutMs = 5000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  const rawHeaders = stream.headers || {};
  
  const requestHeaders = {
    'User-Agent': rawHeaders['user-agent'] || rawHeaders['User-Agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': '*/*',
  };

  const referer = rawHeaders['referer'] || rawHeaders['Referer'] || rawHeaders['referrer'];
  const origin = rawHeaders['origin'] || rawHeaders['Origin'];

  if (referer) requestHeaders['Referer'] = referer;
  if (origin) requestHeaders['Origin'] = origin;

  try {
    const response = await fetch(stream.url, {
      method: 'GET',
      headers: requestHeaders,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      console.warn(`[Validator] FAILED (HTTP ${response.status}): ${stream.url}`);
      return false;
    }

    const textSample = await response.text();
    if (textSample.trim().startsWith('#EXTM3U')) {
      console.log(`[Validator] PASSED: ${stream.event} (${stream.source})`);
      return true;
    }

    console.warn(`[Validator] FAILED (Not an M3U8 manifest): ${stream.url}`);
    return false;
  } catch (err) {
    clearTimeout(timeoutId);
    console.warn(`[Validator] FAILED (${err.name === 'AbortError' ? 'Timeout' : err.message}): ${stream.url}`);
    return false;
  }
}

/**
 * Writes validated streams using Roku pipe (|) syntax.
 */
export async function generateM3u8Output(streams, filePath) {
  console.log(`\nStarting stream verification...`);

  const validationResults = await Promise.all(
    streams.map(async (stream) => {
      const isValid = await verifyStreamUrl(stream);
      return isValid ? stream : null;
    })
  );

  const validStreams = validationResults.filter(Boolean);
  console.log(`\nVerification Complete: ${validStreams.length}/${streams.length} streams passed.\n`);

  let content = '#EXTM3U\n';

  for (const stream of validStreams) {
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

    const logo = stream.group?.logo || '';

    content += `#EXTINF:-1 tvg-id="${displayName}" tvg-name="${displayName}" tvg-logo="${logo}" group-title="${groupTitle}", ${displayName}\n`;

    let finalUrl = stream.url;

    if (stream.headers) {
      const referer = stream.headers['referer'] || stream.headers['Referer'] || stream.headers['referrer'];
      const userAgent = stream.headers['user-agent'] || stream.headers['User-Agent'];
      const origin = stream.headers['origin'] || stream.headers['Origin'];

      const headerParams = [];
      if (referer) headerParams.push(`Referer=${encodeURIComponent(referer)}`);
      if (userAgent) headerParams.push(`User-Agent=${encodeURIComponent(userAgent)}`);
      if (origin) headerParams.push(`Origin=${encodeURIComponent(origin)}`);

      if (headerParams.length > 0) {
        finalUrl += `|${headerParams.join('&')}`;
      }
    }

    content += `${finalUrl}\n`;
  }

  await fs.writeFile(filePath, content, 'utf-8');
}
