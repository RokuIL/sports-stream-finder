import { chromium } from 'playwright';

export async function createBrowser(config) {
  const browser = await chromium.launch({
    headless: process.env.HEADLESS === 'false' ? false : config.headless
  });
  
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
  });

  return { browser, context };
}

/**
 * Attaches a network listener to a page to intercept .m3u8 requests.
 * Resolves the promise when an m3u8 is found.
 */
export function waitForHlsStream(page, timeoutMs) {
  return new Promise((resolve) => {
    let timeoutId;
    
    const handler = (request) => {
      const url = request.url();
      if (url.includes('.m3u8')) {
        const headers = request.headers();
        // Playwright normalizes headers to lowercase
        const referer = headers['referer'] || null;
        const origin = headers['origin'] || null;

        clearTimeout(timeoutId);
        page.removeListener('request', handler);
        resolve({ url, headers: { referer, origin } });
      }
    };

    page.on('request', handler);

    timeoutId = setTimeout(() => {
      page.removeListener('request', handler);
      resolve(null); // Return null if timeout is reached without finding stream
    }, timeoutMs);
  });
}