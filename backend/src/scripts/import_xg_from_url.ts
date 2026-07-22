import axios from "axios";
import xgService from "../xgService";

function parseCsv(text: string) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return [];
  const headers = lines[0].split(",").map(h => h.trim().toLowerCase());
  const rows = lines.slice(1).map(l => {
    const parts = l.split(",").map(p => p.trim());
    const obj: any = {};
    for (let i = 0; i < headers.length; i++) obj[headers[i]] = parts[i] ?? "";
    return obj;
  });
  return rows;
}

async function importFromUrl(url: string) {
  try {
    console.log("Fetching", url);
    const res = await axios.get(url, { responseType: 'text', timeout: 30000 });
    const content = res.data as string;

    let rows: any[] = [];
    try {
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) rows = parsed;
      else if (parsed?.data && Array.isArray(parsed.data)) rows = parsed.data;
    } catch (e) {
      // not JSON, try CSV
      rows = parseCsv(content);
    }

    if (!rows || rows.length === 0) {
      console.error("No rows parsed from source");
      return false;
    }

    // Aggregate per-team xG for home/away
    const stats: Record<string, { home_sum: number; home_n: number; away_sum: number; away_n: number }> = {};

    for (const r of rows) {
      // support several common column names
      const home = r.home_team ?? r.hometeam ?? r.home ?? r['team_home'] ?? r['team'];
      const away = r.away_team ?? r.awayteam ?? r.away ?? r['opponent'] ?? r['opponent_team'];
      const home_xg = Number(r.home_xg ?? r.h_xg ?? r.xg_home ?? r.home_xg_value ?? r.home_xg_est) || null;
      const away_xg = Number(r.away_xg ?? r.a_xg ?? r.xg_away ?? r.away_xg_value ?? r.away_xg_est) || null;

      if (home && away && (home_xg !== null || away_xg !== null)) {
        const h = home.trim().toLowerCase();
        const a = away.trim().toLowerCase();
        if (!stats[h]) stats[h] = { home_sum: 0, home_n: 0, away_sum: 0, away_n: 0 };
        if (!stats[a]) stats[a] = { home_sum: 0, home_n: 0, away_sum: 0, away_n: 0 };
        if (home_xg !== null) { stats[h].home_sum += home_xg; stats[h].home_n += 1; }
        if (away_xg !== null) { stats[a].away_sum += away_xg; stats[a].away_n += 1; }
      }
    }

    const out: Record<string, { home_xg: number; away_xg: number }> = {};
    for (const t of Object.keys(stats)) {
      const s = stats[t];
      const home_xg = s.home_n > 0 ? s.home_sum / s.home_n : Number(process.env.XG_LEAGUE_HOME_AVG ?? 1.55);
      const away_xg = s.away_n > 0 ? s.away_sum / s.away_n : Number(process.env.XG_LEAGUE_AWAY_AVG ?? 1.15);
      out[t] = { home_xg: Number(home_xg.toFixed(3)), away_xg: Number(away_xg.toFixed(3)) };
    }

    // Upsert into local stats (replace entire file)
    const ok = xgService.replaceStats(out);
    console.log("Import result:", ok ? "ok" : "failed", "teams:", Object.keys(out).length);
    return ok;
  } catch (err) {
    console.error("ImportFromUrl failed:", err instanceof Error ? err.message : err);
    return false;
  }
}

// If invoked directly, take URL from argv
if (require.main === module) {
  const url = process.argv[2] || process.env.XG_SOURCE_URL;
  if (!url) {
    console.error("Usage: node import_xg_from_url.js <url>");
    process.exit(1);
  }
  importFromUrl(url).then(ok => process.exit(ok ? 0 : 2));
}

export default { importFromUrl };
