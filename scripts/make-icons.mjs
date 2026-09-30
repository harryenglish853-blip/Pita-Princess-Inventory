// Renders the app icon SVG to PNG sizes with the preinstalled Chromium.
import { chromium } from "@playwright/test";
const svg = (pad) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="${pad ? 0 : 112}" fill="#0f6e66"/>
<g transform="translate(${pad ? 116 : 96} ${pad ? 116 : 96}) scale(${pad ? 0.547 : 0.625})" fill="none" stroke="#fff" stroke-width="36" stroke-linecap="round" stroke-linejoin="round">
<rect x="56" y="40" width="400" height="432" rx="40"/><path d="M160 40v-8a32 32 0 0 1 32-32h128a32 32 0 0 1 32 32v8"/><path d="M144 200l48 48 96-96"/><path d="M304 232h72M144 344h232"/></g></svg>`;
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const page = await browser.newPage();
for (const [name, size, pad] of [["icon-192", 192, false], ["icon-512", 512, false], ["maskable-512", 512, true], ["apple-touch-icon", 180, true]]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0">${svg(pad).replace("<svg ", `<svg width="${size}" height="${size}" `)}</body></html>`);
  await page.screenshot({ path: `public/icons/${name}.png`, omitBackground: true });
}
await browser.close();
