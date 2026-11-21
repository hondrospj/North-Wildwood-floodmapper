"use strict";

async function loadV41Forecast() {
  const status = document.getElementById("status");
  const directory = new URL("./", location.href);
  try {
    const response = await fetch(new URL("latest.json", directory), { cache: "no-store", redirect: "error" });
    if (!response.ok) throw new Error("Missing forecast");
    const latest = await response.json();
    const issued = Date.parse(latest.issue_utc);
    if (!["ok", "passed", "ready"].includes(latest.status) ||
        !Number.isFinite(issued) || !Number.isInteger(latest.forecast_hours) || latest.forecast_hours < 1 ||
        latest.forecast_hours > 360 || !Number.isInteger(latest.weather_paths) || latest.weather_paths < 1 ||
        typeof latest.proxy_label !== "string" || !latest.proxy_label.trim() ||
        latest.chart_url !== "latest.png" || latest.csv_url !== "latest.csv") {
      throw new Error("Invalid forecast");
    }
    const chart = new URL(latest.chart_url, directory);
    const csv = new URL(latest.csv_url, directory);
    chart.searchParams.set("cycle", latest.issue_utc);
    csv.searchParams.set("cycle", latest.issue_utc);
    const age = (Date.now() - issued) / 3_600_000;
    const description = `${new Date(issued).toISOString().slice(0, 16).replace("T", " ")} UTC · ${latest.forecast_hours} forecast hours · ${latest.weather_paths} weather paths`;
    status.textContent = age >= latest.forecast_hours ? `Expired · ${description}`
      : age >= 12 ? `Previous verified run · ${description}` : description;
    document.getElementById("proxy").textContent = latest.proxy_label;
    const image = document.getElementById("chart");
    image.addEventListener("error", () => { image.hidden = true; }, { once: true });
    image.src = chart.href;
    document.getElementById("csv").href = csv.href;
    document.getElementById("forecast").hidden = false;
  } catch {
    status.textContent = "No verified V41 forecast is available yet.";
  }
}

loadV41Forecast();
