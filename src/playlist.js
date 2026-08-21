import fs from 'node:fs/promises';

/**
 * Validates whether an HLS stream URL is active and prints detailed debug metadata.
 */
async function verifyStreamUrl(stream, timeoutMs = 5000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  // Normalize header names for consistency
  const rawHeaders = stream.headers || {};
  const requestHeaders = {
    'User-Agent': rawHeaders['user-agent'] || rawHeaders['User-Agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  };

  const referer = rawHeaders['referer'] || rawHeaders['Referer'] || rawHeaders['referrer'];
  const origin = rawHeaders['origin'] || rawHeaders['Origin'];

  if (referer) requestHeaders['Referer'] = referer;
  if (origin) requestHeaders['Origin'] = origin;

  console.log(`\n--------------------------------------------------`);
  console.log(`[Validator] Testing Stream: ${stream.event} (${stream.source})`);
  console.log(`[Validator] Target URL: ${stream.url}`);
  console.log(`[Validator] Request Headers:`, JSON.stringify(requestHeaders, null, 2));

  try {
    const response = await fetch(stream.url, {
      method: 'GET',
      headers: requestHeaders,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    console.log(`[Validator] Response Status: ${response.status} ${response.statusText}`);
    console.log(`[Validator] Response Content-Type: ${response.headers.get('content-type')}`);

    if (!response.ok) {
      console.warn(`[Validator] RESULT: FAILED (HTTP Status ${response.status})`);
      console.log(`--------------------------------------------------`);
      return false;
    }

    const textSample = await response.text();
    const cleanSample = textSample.trim();

    if (cleanSample.startsWith('#EXTM3U')) {
      console.log(`[Validator] RESULT: SUCCESS (Valid HLS Manifest)`);
      console.log(`--------------------------------------------------`);
      return true;
    }

    console.warn(`[Validator] RESULT: FAILED (Non-HLS Body Received)`);
    console.log(`[Validator] Body Sample (First 150 chars):\n${cleanSample.substring(0, 150)}`);
    console.log(`--------------------------------------------------`);
    return false;

  } catch (err) {
    clearTimeout(timeoutId);
    const errorMsg = err.name === 'AbortError' ? `Timeout after ${timeoutMs}ms` : err.message;
    console.warn(`[Validator] RESULT: FAILED (${errorMsg})`);
    console.log(`--------------------------------------------------`);
    return false;
  }
}

/**
 * Formats valid streams using pipe (|) query syntax and outputs the playlist.
 */
export async function generateM3u8Output(streams, filePath) {
  console.log(`\n==================================================`);
  console.log(`Starting validation for ${streams.length} candidate streams...`);
  console.log(`==================================================`);

  const validationResults = await Promise.all(
    streams.map(async (stream) => {
      const isValid = await verifyStreamUrl(stream);
      return isValid ? stream : null;
    })
  );

  const validStreams = validationResults.filter(Boolean);

  console.log(`\n==================================================`);
  console.log(`Validation Complete: ${validStreams.length}/${streams.length} streams playable.`);
  console.log(`==================================================\n`);

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

    // Append headers using pipe (|) syntax for Roku
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
