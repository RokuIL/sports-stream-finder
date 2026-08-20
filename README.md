# Sports Stream Finder

Automated tool to discover live sports streams from authorized sources using Playwright and Chromium. It searches matching events, captures dynamically loaded `.m3u8` payloads from network requests, and generates a formatted `live.m3u8` playlist.

## GitHub Repository Setup

1. Create a new repository on GitHub.
2. Copy all files from this template into your local repository.
3. Commit and push the files to the `main` branch.
4. GitHub Actions will automatically recognize `.github/workflows/find-streams.yml`.

## Local Testing & Development

Ensure you have Node.js LTS installed.

1. **Install dependencies:**
   ```bash
   npm ci
   ```
2. **Install Chromium for Playwright:**
   ```bash
   npx playwright install chromium
   ```
3. **Run the script:**
   ```bash
   npm start
   ```

**Debugging Mode:**
To run the browser in headed mode (so you can see what it's doing):
```bash
# Windows (PowerShell)
$env:HEADLESS="false"; npm start

# Mac/Linux
HEADLESS="false" npm start
```

## Configuration (`config/streams.json`)

Define your search strings in the `groups` array. Matching is case-insensitive and checks if the configured string appears anywhere in the event name.

**Single Group Example:**
```json
"groups": [
  {
    "name": "Seattle",
    "matches": ["Seattle", "SEA"],
    "logo": "https://example.com/seattle.png"
  }
]
```

**Multiple Groups Example:**
```json
"groups": [
  {
    "name": "Seattle",
    "matches": ["Seattle"],
    "logo": ""
  },
  {
    "name": "New York",
    "matches": ["New York", "NY"],
    "logo": ""
  }
]
```

## GitHub Execution

The script is fully integrated with GitHub Actions.

1. Navigate to the **Actions** tab in your repository.
2. Select **Find Sports Streams** from the left sidebar.
3. Click **Run workflow** (you can optionally pass an extra search string).
4. Once the job finishes, scroll to the **Artifacts** section at the bottom of the run summary to download your generated `live.m3u8` file.

### Schedule
By default, the workflow runs automatically every 15 minutes using the cron expression `*/15 * * * *` defined in `.github/workflows/find-streams.yml`. You can change this to match your desired schedule.

## Troubleshooting

*   **No events found:** Check if your `matches` arrays are too specific. Use broad, case-insensitive substrings.
*   **Event found but no .m3u8:** The stream wait timeout might be too short for the player to load, or the site is requiring a CAPTCHA. You can increase `streamWaitMs` in `config/streams.json`.
*   **Browser timeout:** Increase `pageTimeoutMs` in the config file.
*   **Site changed its HTML:** The adapter logic in `src/livetv.js` and `src/mainportal.js` relies on standard `<a>` tag text extraction. If sites adopt heavy obfuscation, the CSS selectors (`page.locator('a')`) will need to be updated.
*   **Downstream MainPortal66 domain changed:** The script dynamically scrapes the portal page for current URLs, meaning it is largely resilient to downstream domain rotation. 
*   **Stream URL works in browser but not in external player:** Ensure your media player supports the HTTP header appendages (`|Referer="..."&Origin="..."`).
*   **Referer/Origin requirements:** The script automatically pulls `Referer` and `Origin` from the actual browser network request, ensuring accurate headers are added to the `.m3u8` playlist entry.
