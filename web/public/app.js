(function () {
  const fetchBtn = document.getElementById("fetchBtn");
  const fetchStatus = document.getElementById("fetchStatus");
  const picksList = document.getElementById("picksList");
  const scoreSection = document.getElementById("scoreSection");
  const scoreFormWrap = document.getElementById("scoreFormWrap");
  const leaderboardList = document.getElementById("leaderboardList");
  const leaderboardStatus = document.getElementById("leaderboardStatus");

  let scoreFields = [];

  function setStatus(el, text, isError) {
    el.textContent = text || "";
    el.classList.toggle("error", !!isError);
  }

  function renderLeaderboard(rows) {
    leaderboardList.innerHTML = "";
    if (!rows || rows.length === 0) {
      leaderboardList.innerHTML = "<p class=\"meta\">No scored active properties yet.</p>";
      return;
    }
    rows.forEach((p, i) => {
      const div = document.createElement("div");
      div.className = "card leaderboard-item";
      div.innerHTML =
        "<strong>" +
        (i + 1) +
        ". " +
        escapeHtml(p.title) +
        "</strong>" +
        ' <span class="score">' +
        Number(p.finalScore).toFixed(1) +
        "</span>" +
        (p.status ? " [" + escapeHtml(String(p.status)) + "]" : "") +
        "<p class=\"meta\"><a href=\"" +
        escapeAttr(p.link) +
        "\" target=\"_blank\" rel=\"noopener\">" +
        escapeHtml(p.link) +
        "</a></p>";
      leaderboardList.appendChild(div);
    });
  }

  function escapeHtml(s) {
    const d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }

  function escapeAttr(s) {
    return String(s).replace(/"/g, "&quot;");
  }

  async function refreshLeaderboard() {
    setStatus(leaderboardStatus, "Loading…");
    try {
      const res = await fetch("/api/leaderboard");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || res.statusText);
      renderLeaderboard(data.leaderboard || []);
      setStatus(leaderboardStatus, "");
    } catch (e) {
      setStatus(leaderboardStatus, e.message || String(e), true);
    }
  }

  function renderPicks(properties) {
    picksList.innerHTML = "";
    scoreSection.classList.add("hidden");
    scoreFormWrap.innerHTML = "";

    if (!properties.length) {
      picksList.innerHTML = "<p class=\"meta\">No properties to show.</p>";
      return;
    }

    properties.forEach((p, idx) => {
      const card = document.createElement("div");
      card.className = "card";

      const h3 = document.createElement("h3");
      h3.textContent = idx + 1 + ". " + p.title;

      const price = document.createElement("p");
      price.className = "meta";
      price.textContent =
        "£" + Number(p.price).toLocaleString("en-GB") + (p.quickScore != null ? " · Quick: " + p.quickScore : "");

      const linkP = document.createElement("p");
      linkP.className = "meta";
      const a = document.createElement("a");
      a.href = p.link;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = p.link;
      linkP.appendChild(a);

      const actions = document.createElement("div");
      actions.className = "row-actions";
      const scoreBtn = document.createElement("button");
      scoreBtn.type = "button";
      scoreBtn.className = "secondary";
      scoreBtn.textContent = "Score";
      scoreBtn.addEventListener("click", function () {
        openScoreForm(p);
      });
      actions.appendChild(scoreBtn);

      card.appendChild(h3);
      card.appendChild(price);
      card.appendChild(linkP);
      card.appendChild(actions);
      picksList.appendChild(card);
    });
  }

  function openScoreForm(property) {
    scoreSection.classList.remove("hidden");
    scoreFormWrap.innerHTML = "";

    const title = document.createElement("p");
    title.className = "meta";
    title.innerHTML = "<strong>" + escapeHtml(property.title) + "</strong>";
    scoreFormWrap.appendChild(title);

    const form = document.createElement("div");
    form.className = "score-form";

    const inputs = {};
    scoreFields.forEach(function (pair) {
      const key = pair[0];
      const labelText = pair[1];
      const label = document.createElement("label");
      label.htmlFor = "score-" + key;
      label.textContent = labelText + " (0–10)";
      const input = document.createElement("input");
      input.type = "number";
      input.id = "score-" + key;
      input.name = key;
      input.min = "0";
      input.max = "10";
      input.step = "1";
      input.value = "5";
      form.appendChild(label);
      form.appendChild(input);
      inputs[key] = input;
    });

    scoreFormWrap.appendChild(form);

    const actions = document.createElement("div");
    actions.className = "score-actions";

    const submit = document.createElement("button");
    submit.type = "button";
    submit.className = "primary";
    submit.textContent = "Submit scores";

    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";

    cancel.addEventListener("click", function () {
      scoreSection.classList.add("hidden");
      scoreFormWrap.innerHTML = "";
    });

    submit.addEventListener("click", async function () {
      const scores = {};
      try {
        for (const key of Object.keys(inputs)) {
          const v = Number(inputs[key].value);
          if (!Number.isInteger(v) || v < 0 || v > 10) {
            alert("Please enter whole numbers 0–10 for all categories.");
            return;
          }
          scores[key] = v;
        }

        submit.disabled = true;
        const res = await fetch("/api/score", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ property, scores }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || res.statusText);

        renderLeaderboard(data.leaderboard || []);
        setStatus(leaderboardStatus, "Saved. Final score: " + Number(data.finalScore).toFixed(1));
        scoreSection.classList.add("hidden");
        scoreFormWrap.innerHTML = "";
      } catch (e) {
        alert(e.message || String(e));
      } finally {
        submit.disabled = false;
      }
    });

    actions.appendChild(submit);
    actions.appendChild(cancel);
    scoreFormWrap.appendChild(actions);

    scoreSection.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  fetchBtn.addEventListener("click", async function () {
    setStatus(fetchStatus, "Fetching…");
    picksList.innerHTML = "";
    try {
      const res = await fetch("/api/properties");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || res.statusText);
      scoreFields = data.scoreFields || [];
      renderPicks(data.properties || []);
      setStatus(fetchStatus, (data.properties && data.properties.length ? "" : data.message) || "Ready.");
    } catch (e) {
      setStatus(fetchStatus, e.message || String(e), true);
    }
  });

  refreshLeaderboard();
})();
