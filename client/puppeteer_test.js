import puppeteer from 'puppeteer';

(async () => {
  try {
    const browser = await puppeteer.launch({
      headless: "new"
    });
    const page = await browser.newPage();
    
    // Set Mobile UA
    await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1');
    await page.setViewport({ width: 375, height: 812, isMobile: true });

    // Catch all console logs and errors
    page.on('console', msg => {
      console.log(`[Browser Console ${msg.type().toUpperCase()}] ${msg.text()}`);
    });
    page.on('pageerror', error => {
      console.log(`[Browser PageError] ${error.message}`);
    });

    try {
      await page.goto('http://127.0.0.1:5173', { waitUntil: 'networkidle2', timeout: 10000 });
      console.log("Page loaded successfully.");
    } catch (e) {
      console.log("Navigation error:", e.message);
    }
    
    // Check if body is empty or has React root
    const rootHtml = await page.evaluate(() => document.getElementById('root')?.innerHTML || '');
    console.log("Root length:", rootHtml.length);
    if (rootHtml.length < 50) {
      console.log("Root HTML is very short, likely crashed:", rootHtml);
    }

    await browser.close();
  } catch (e) {
    console.error("Puppeteer Failed:", e);
  }
})();
