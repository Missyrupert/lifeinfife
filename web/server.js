"use strict";

const path = require("path");
const express = require("express");
const core = require(path.join(__dirname, "..", "core.js"));

const {
  fetchListings,
  enrichListingsWithSeen,
  buildShortlistedTopFive,
  filterListings,
  calculateScore,
  loadData,
  saveData,
  getActiveLeaderboard,
  SCORE_KEYS,
  WEIGHTS,
} = core;

const app = express();
const PORT = 3000;

app.use(express.json({ limit: "64kb" }));
app.use(express.static(path.join(__dirname, "public")));

function validateScores(scores) {
  if (!scores || typeof scores !== "object") {
    return "Scores object required";
  }
  for (const key of Object.keys(WEIGHTS)) {
    const v = scores[key];
    if (!Number.isInteger(v) || v < 0 || v > 10) {
      return `Score "${key}" must be an integer 0–10`;
    }
  }
  return null;
}

app.get("/api/properties", async (_req, res) => {
  try {
    const listings = await fetchListings();
    const enriched = enrichListingsWithSeen(listings);
    const filtered = filterListings(enriched);
    if (filtered.length === 0) {
      return res.json({ properties: [], scoreFields: SCORE_KEYS, message: "No listings match filters." });
    }
    const shortlisted = buildShortlistedTopFive(enriched);
    res.json({ properties: shortlisted, scoreFields: SCORE_KEYS });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

app.post("/api/score", (req, res) => {
  try {
    const { property, scores } = req.body || {};
    if (!property || typeof property !== "object") {
      return res.status(400).json({ error: "property object required" });
    }
    if (!property.link) {
      return res.status(400).json({ error: "property.link required" });
    }

    const scoreErr = validateScores(scores);
    if (scoreErr) {
      return res.status(400).json({ error: scoreErr });
    }

    const finalScore = calculateScore(scores);
    const existingData = loadData();
    const row = {
      ...property,
      scores,
      finalScore,
      firstSeen: property.firstSeen || new Date().toISOString(),
      scoredAt: new Date().toISOString(),
      status: "active",
      lastChecked: new Date().toISOString(),
    };
    existingData.push(row);
    saveData(existingData);

    const leaderboard = getActiveLeaderboard(existingData);
    res.json({ finalScore, leaderboard });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

app.get("/api/leaderboard", (_req, res) => {
  try {
    const leaderboard = getActiveLeaderboard();
    res.json({ leaderboard });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`Life in Fife web http://localhost:${PORT}`);
});
