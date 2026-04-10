const { chromium } = require('playwright');
const fs = require('fs');

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const context = await browser.newContext({
    viewport: { width: 800, height: 480 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });

  const page = await context.newPage();
  page.setDefaultTimeout(90000);

  try {
    const url = process.env.SCREENSHOT_URL || 'https://example.com';
    const outputFile = process.env.OUTPUT_FILE || 'screenshot.png';
    const rawFile = outputFile.replace(/\.png$/, '-raw.png');
    console.log(`Taking screenshot of: ${url}`);

    await page.goto(url, {
      waitUntil: 'networkidle',
      timeout: 90000
    });

    // Wait for fonts to load completely
    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all(Array.from(document.fonts).map(async (font) => {
        try { await font.loaded; } catch (e) {}
      }));
      for (const fontFamily of ['Inter', 'Roboto', 'Arial', 'sans-serif']) {
        try { await document.fonts.load(`16px "${fontFamily}"`); } catch (e) {}
      }
      return new Promise((resolve) => {
        if (document.fonts.status === 'loaded') { resolve(); }
        else {
          document.fonts.addEventListener('loadingdone', () => resolve());
          setTimeout(() => resolve(), 15000);
        }
      });
    });

    await page.waitForTimeout(3000);

    const screenshot = await page.screenshot({
      type: 'png',
      fullPage: false,
      clip: { x: 0, y: 0, width: 800, height: 480 }
    });

    // Write raw PNG for ImageMagick processing
    fs.writeFileSync(rawFile, screenshot);
    console.log(`Raw screenshot saved as ${rawFile}`);

  } catch (error) {
    console.error('Error taking screenshot:', error);
    process.exit(1);
  } finally {
    await context.close();
    await browser.close();
  }
})();
