import { defineConfig, devices } from "@playwright/test";

const chromium = { browserName: "chromium" as const };
const smallAndroid = { ...chromium, viewport: { width: 360, height: 640 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: devices["Pixel 7"].userAgent };

/** The game is phone-only, so every browser test runs at phone sizes. Desktop only checks the "open on your phone" card. */
export default defineConfig({
  testDir: "tests",
  timeout: 60_000,
  fullyParallel: true,
  reporter: "list",
  outputDir: "test-results",
  use: { baseURL: "http://localhost:4174", trace: "off" },
  webServer: {
    command: "npm run build && npm run preview",
    url: "http://localhost:4174",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [
    { name: "unit", testMatch: /.*\.unit\.spec\.ts/ },
    { name: "iphone", testMatch: /.*\.(e2e|layout)\.spec\.ts/, use: { ...devices["iPhone 13"], ...chromium } },
    { name: "small-android", testMatch: /.*\.(e2e|layout)\.spec\.ts/, use: smallAndroid },
    { name: "iphone-se", testMatch: /.*\.layout\.spec\.ts/, use: { ...devices["iPhone SE"], ...chromium } },
    { name: "pixel", testMatch: /.*\.layout\.spec\.ts/, use: { ...devices["Pixel 7"], ...chromium } },
    { name: "desktop", testMatch: /.*\.desktop\.spec\.ts/, use: { ...chromium, viewport: { width: 1280, height: 800 } } },
  ],
});
