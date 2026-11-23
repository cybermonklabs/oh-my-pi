// chrome.ts <tree> <cacheDir>: install the Chrome for Testing build that the tree's puppeteer-core pins
// (PUPPETEER_REVISIONS.chrome), the way the tree's own launch.ts installs it on a host with no system
// Chrome (ensureManagedChromium), and print its executable path. The browser tests then run against the
// Chrome the tree targets, not the runner's preinstalled google-chrome.
const [tree, cacheDir] = process.argv.slice(2);
if (!tree || !cacheDir) throw new Error("usage: chrome.ts <tree> <cacheDir>");
const from = `${tree}/packages/coding-agent`;
// Runtime imports: the modules are the tree's own, found from the tree path given at run time.
const browsers = await import(Bun.resolveSync("@oh-my-pi/pi-utils/browsers", from));
const { PUPPETEER_REVISIONS } = await import(Bun.resolveSync("puppeteer-core/internal/revisions.js", from));
const platform = browsers.detectBrowserPlatform();
if (!platform) throw new Error("the browser platform of this host is unknown");
const buildId: string = PUPPETEER_REVISIONS.chrome;
await browsers.install({ buildId, cacheDir, platform });
console.error(`Chrome for Testing ${buildId} (${platform}) in ${cacheDir}`);
console.log(browsers.computeExecutablePath({ buildId, cacheDir, platform }));
