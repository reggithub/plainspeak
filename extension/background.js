// Plainspeak background service worker.
//
// The only reason this file exists: NYT sets a connect-src CSP that applies to
// fetches made from a content script. Fetching here instead sidesteps it.
//
// Point FEED_URL at the raw file in your public annotations repo.

const FEED_URL =
  "https://raw.githubusercontent.com/reggithub/plainspeak/main/annotations.json";

const TTL_MS = 5 * 60 * 1000;

let cache = { at: 0, data: null };

async function getFeed() {
  const now = Date.now();
  if (cache.data && now - cache.at < TTL_MS) return cache.data;

  try {
    const res = await fetch(FEED_URL, { cache: "no-cache" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    cache = { at: now, data };
    return data;
  } catch (err) {
    // Serve stale rather than nothing; a network blip shouldn't blank the page.
    console.warn("[plainspeak] feed fetch failed:", err.message);
    return cache.data || { annotations: [] };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "plainspeak:getFeed") return;
  getFeed().then(sendResponse);
  return true; // keep the channel open for the async response
});
