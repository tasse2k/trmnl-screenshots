const { chromium } = require('playwright');
const fs = require('fs');

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      // Chromium antialiases text with LCD subpixel rendering by default:
      // it lights the R, G and B stripes of a colour monitor's pixel
      // separately, so every glyph edge comes out colour-fringed. Measured
      // on the dashboard, that was 23,211 fringed pixels with R-B spreads
      // up to 160 -- every antialiased pixel on the frame.
      //
      // The panel is monochrome, so none of that is signal. Worse,
      // `-colorspace Gray` weights the channels 0.299/0.587/0.114, so the
      // orange fringe on one side of a stem and the blue fringe on the
      // other resolve to DIFFERENT greys: the smear is asymmetric.
      //
      // This flag renders neutral greyscale antialiasing instead. Grey
      // pixels drop from 23,210 to 18,958 and the fringes go to zero.
      '--disable-lcd-text',
    ],
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

    // Wait for fonts to load completely.
    //
    // NOTE the filter on `status`. FontFace.loaded is only ever settled for a
    // face the page actually asks for: a declared-but-unused @font-face sits
    // at status "unloaded" with a promise that, by spec, never resolves AND
    // never rejects -- so `try/catch` around it does nothing, because there is
    // no rejection to catch. Awaiting one deadlocks, and page.evaluate() takes
    // no timeout in Playwright, so it deadlocks forever. That is precisely how
    // run #14083 wedged for hours and froze both displays behind the
    // `concurrency: screenshot` group.
    //
    // Waiting on the faces that ARE loading is the part that makes the
    // screenshot pixel-perfect, so that is kept exactly as it was.
    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all(Array.from(document.fonts)
        .filter((font) => font.status === 'loading')
        .map(async (font) => {
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

    // Extract LAST UPDATE time from the DOM
    const lastUpdate = await page.evaluate(() => {
      // Look for elements containing "UPDATE" text
      const all = document.querySelectorAll('*');
      for (const el of all) {
        const text = el.textContent || '';
        if (/update/i.test(text)) {
          const match = text.match(/(\d{1,2}:\d{2})/);
          if (match) return match[1];
        }
      }
      return null;
    });

    // Write raw PNG for ImageMagick processing
    fs.writeFileSync(rawFile, screenshot);
    console.log(`Raw screenshot saved as ${rawFile}`);

    // Write extracted timestamp for the workflow to pick up
    const metaFile = outputFile.replace(/\.png$/, '-meta.json');
    fs.writeFileSync(metaFile, JSON.stringify({ lastUpdate }));
    console.log(`Last update time: ${lastUpdate || 'not found'}`);

  } catch (error) {
    console.error('Error taking screenshot:', error);
    process.exit(1);
  } finally {
    await context.close();
    await browser.close();
  }
})();
