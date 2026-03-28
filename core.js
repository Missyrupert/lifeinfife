"use strict";

const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");

const DATA_PATH = path.join(__dirname, "data.json");
const SEEN_PATH = path.join(__dirname, "seen.json");

const DEFAULT_RIGHTMOVE_URL =
  "https://www.rightmove.co.uk/property-for-sale/find.html?locationIdentifier=REGION%5E61347&maxPrice=230000&sortType=6&index=0";

const MAX_PRICE = 230_000;
const FIFE_SUBSTRING = "fife";

const WEIGHTS = {
  garden: 0.3,
  workSetup: 0.25,
  transport: 0.15,
  dogLife: 0.1,
  kitchen: 0.08,
  area: 0.06,
  parking: 0.06,
};

const SCORE_KEYS = [
  ["garden", "Garden"],
  ["workSetup", "Work Setup"],
  ["transport", "Transport"],
  ["dogLife", "Dog Life"],
  ["kitchen", "Kitchen"],
  ["area", "Area"],
  ["parking", "Parking"],
];

const axiosDefaults = {
  timeout: 45_000,
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-GB,en;q=0.9",
  },
  validateStatus: (s) => s >= 200 && s < 500,
};

function parsePriceFromText(text) {
  if (!text) return null;
  const m = String(text).match(/£\s*([0-9][0-9,]*)/);
  if (!m) return null;
  const n = parseInt(m[1].replace(/,/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}

function absoluteRightmoveUrl(pathOrUrl) {
  if (!pathOrUrl) return "";
  const s = String(pathOrUrl).trim();
  if (/^https?:\/\//i.test(s)) return s;
  return `https://www.rightmove.co.uk${s.startsWith("/") ? s : `/${s}`}`;
}

function loadData() {
  try {
    if (!fs.existsSync(DATA_PATH)) return [];
    const raw = fs.readFileSync(DATA_PATH);
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function saveData(data) {
  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2));
}

function loadSeen() {
  try {
    if (!fs.existsSync(SEEN_PATH)) return [];
    const raw = fs.readFileSync(SEEN_PATH);
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveSeen(data) {
  fs.writeFileSync(SEEN_PATH, JSON.stringify(data, null, 2));
}

function isAlreadyScored(existing, property) {
  return existing.some((p) => p.link === property.link);
}

async function checkPropertyStatus(url) {
  try {
    const res = await axios.get(url, { timeout: 5000 });
    const html = String(res.data).toLowerCase();
    if (html.includes("sold") || html.includes("sstc") || html.includes("under offer")) {
      return "unavailable";
    }
    return "active";
  } catch {
    return "unknown";
  }
}

async function fetchListings() {
  const rssUrl = process.env.LIFE_IN_FIFE_RSS?.trim();
  const htmlUrl = process.env.LIFE_IN_FIFE_URL?.trim() || DEFAULT_RIGHTMOVE_URL;

  if (rssUrl) {
    return fetchListingsFromRss(rssUrl);
  }
  return fetchListingsFromRightmove(htmlUrl);
}

async function fetchListingsFromRightmove(url) {
  let res;
  try {
    res = await axios.get(url, axiosDefaults);
  } catch (err) {
    const msg = err.response ? `HTTP ${err.response.status}` : err.message;
    throw new Error(`Failed to fetch Rightmove page: ${msg}`);
  }

  if (res.status >= 400) {
    throw new Error(`Rightmove request failed with HTTP ${res.status}`);
  }

  const html = typeof res.data === "string" ? res.data : String(res.data);
  const $ = cheerio.load(html);
  const raw = $("#__NEXT_DATA__").html();
  if (!raw) {
    throw new Error(
      "Could not find __NEXT_DATA__ on the page. Set LIFE_IN_FIFE_URL to a valid Rightmove search results URL, or use LIFE_IN_FIFE_RSS."
    );
  }

  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error("Failed to parse __NEXT_DATA__ JSON from Rightmove.");
  }

  const props = json?.props?.pageProps?.searchResults?.properties;
  const regionName = json?.props?.pageProps?.searchResults?.location?.displayName || "";

  if (!Array.isArray(props)) {
    throw new Error("Rightmove page had no searchResults.properties array.");
  }

  const listings = [];
  for (const p of props) {
    const amount = p?.price?.amount;
    const price = typeof amount === "number" && Number.isFinite(amount) ? amount : null;
    const displayAddress = (p?.displayAddress || "").trim();
    const typeDesc = (p?.propertyTypeFullDescription || "").trim();
    const title =
      typeDesc && displayAddress
        ? `${typeDesc}, ${displayAddress}`
        : typeDesc || displayAddress || `Property ${p?.id ?? ""}`.trim();

    const regionPart = regionName ? `, ${regionName}` : "";
    const location = `${displayAddress}${regionPart}`.trim() || regionName || "Unknown";

    const link = absoluteRightmoveUrl(p?.propertyUrl);

    if (title && price != null && location && link) {
      listings.push({ title, price, location, link });
    }
  }

  return listings;
}

async function fetchListingsFromRss(url) {
  let res;
  try {
    res = await axios.get(url, {
      ...axiosDefaults,
      headers: { ...axiosDefaults.headers, Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*" },
    });
  } catch (err) {
    const msg = err.response ? `HTTP ${err.response.status}` : err.message;
    throw new Error(`Failed to fetch RSS: ${msg}`);
  }

  if (res.status >= 400) {
    throw new Error(`RSS request failed with HTTP ${res.status}`);
  }

  const xml = typeof res.data === "string" ? res.data : String(res.data);
  const $ = cheerio.load(xml, { xmlMode: true });
  const listings = [];

  $("item, entry").each((_, el) => {
    const $el = $(el);
    const title = ($el.find("title").first().text() || "").trim();
    let link = ($el.find("link").first().text() || "").trim();
    if (!link) {
      link = $el.find("link").first().attr("href") || "";
    }
    const desc = ($el.find("description, summary, content").first().text() || "").trim();
    const blob = `${title} ${desc}`;
    const price = parsePriceFromText(blob);
    const location = title || desc.slice(0, 120) || "Unknown";

    if (title && link && price != null) {
      listings.push({ title, price, location, link });
    }
  });

  return listings;
}

function filterListings(listings) {
  return listings.filter((l) => {
    const locOk = l.location.toLowerCase().includes(FIFE_SUBSTRING);
    const priceOk = typeof l.price === "number" && l.price <= MAX_PRICE;
    return locOk && priceOk;
  });
}

function quickScore(property) {
  let score = 0;
  if (property.title.toLowerCase().includes("3 bed")) score += 2;
  if (property.title.toLowerCase().includes("4 bed")) score += 3;
  if (property.title.toLowerCase().includes("detached")) score += 3;
  if (property.title.toLowerCase().includes("semi-detached")) score += 2;
  if (property.price > 180000) score += 2;
  if (property.price > 200000) score += 2;
  return score;
}

/**
 * Tracks first-seen timestamps in seen.json (same behaviour as CLI).
 */
function enrichListingsWithSeen(listings) {
  const seenData = loadSeen();
  const seenMap = new Map(seenData.map((p) => [p.link, p]));

  const enrichedListings = listings.map((p) => {
    const seen = seenMap.get(p.link);
    return {
      ...p,
      firstSeen: seen?.firstSeen || new Date().toISOString(),
    };
  });

  enrichedListings.forEach((p) => {
    if (!seenMap.has(p.link)) {
      const row = { link: p.link, firstSeen: p.firstSeen, title: p.title };
      seenData.push(row);
      seenMap.set(p.link, row);
    }
  });

  saveSeen(seenData);
  return enrichedListings;
}

function buildShortlistedTopFive(enrichedListings) {
  const filtered = filterListings(enrichedListings);
  return filtered
    .map((p) => ({ ...p, quickScore: quickScore(p) }))
    .sort((a, b) => b.quickScore - a.quickScore)
    .slice(0, 5);
}

function calculateScore(scores) {
  let total = 0;
  for (const [key, w] of Object.entries(WEIGHTS)) {
    const v = scores[key];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new Error(`Missing or invalid numeric score for: ${key}`);
    }
    total += v * w;
  }
  return total;
}

function getActiveLeaderboard(data) {
  const rows = Array.isArray(data) ? data : loadData();
  return rows
    .filter((p) => p.status === "active")
    .sort((a, b) => b.finalScore - a.finalScore);
}

module.exports = {
  DATA_PATH,
  SEEN_PATH,
  DEFAULT_RIGHTMOVE_URL,
  MAX_PRICE,
  WEIGHTS,
  SCORE_KEYS,
  loadData,
  saveData,
  loadSeen,
  saveSeen,
  isAlreadyScored,
  checkPropertyStatus,
  fetchListings,
  filterListings,
  quickScore,
  enrichListingsWithSeen,
  buildShortlistedTopFive,
  calculateScore,
  getActiveLeaderboard,
};
