import React from "react";
import { useQuery } from "@tanstack/react-query";

type Odds = {
  id: string;
  provider: string;
  market: string;
  outcome: string;
  price: number;
  probability: number | null;
  evPlus: number | null;
};

type Match = {
  id: string;
  winamaxId: string;
  sport: string;
  homeTeam: string;
  awayTeam: string;
  startAt: string;
  odds: Odds[];
};

const evPlusThreshold = 3;

function formatDate(iso: string) {
  return new Date(iso).toLocaleString("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function App() {
  const { data, isLoading, isError, error } = useQuery<Match[]>({
    queryKey: ["matches"],
    queryFn: async () => {
      const res = await fetch("/api/matches");
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      return res.json();
    }
  });

  return (
    <div style={{ padding: 24, fontFamily: "Inter, ui-sans-serif, system-ui" }}>
      <header style={{ marginBottom: 24 }}>
        <h1 style={{ margin: 0, fontSize: 32 }}>EV+ Dashboard</h1>
        <p style={{ margin: "8px 0 0", color: "#555" }}>
          Matches du jour Winamax avec cotes 1N2 et EV+ estimé.
        </p>
      </header>

      {isLoading ? (
        <p>Chargement des matchs...</p>
      ) : isError ? (
        <div style={{ color: "#b91c1c" }}>
          Erreur de chargement : {(error as Error).message}
        </div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={thStyle}>Date/heure</th>
                <th style={thStyle}>Match</th>
                <th style={thStyle}>Market</th>
                <th style={thStyle}>Issue</th>
                <th style={thStyle}>Cote</th>
                <th style={thStyle}>Prob. estimée</th>
                <th style={thStyle}>EV+ %</th>
              </tr>
            </thead>
            <tbody>
              {data?.flatMap((match) =>
                match.odds.map((odd) => {
                  const highlight = (odd.evPlus ?? 0) >= evPlusThreshold;
                  return (
                    <tr
                      key={odd.id}
                      style={{
                        background: highlight ? "#dcfce7" : "transparent",
                      }}
                    >
                      <td style={tdStyle}>{formatDate(match.startAt)}</td>
                      <td style={tdStyle}>{`${match.homeTeam} vs ${match.awayTeam}`}</td>
                      <td style={tdStyle}>{odd.market}</td>
                      <td style={tdStyle}>{odd.outcome}</td>
                      <td style={tdStyle}>{odd.price.toFixed(2)}</td>
                      <td style={tdStyle}>{odd.probability ? `${(odd.probability * 100).toFixed(1)} %` : "-"}</td>
                      <td style={tdStyle}>{odd.evPlus !== null ? `${odd.evPlus.toFixed(1)} %` : "-"}</td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const thStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "12px 10px",
  borderBottom: "1px solid #e5e7eb",
  fontSize: 14,
  color: "#374151",
};

const tdStyle: React.CSSProperties = {
  padding: "10px",
  borderBottom: "1px solid #f3f4f6",
  fontSize: 13,
  color: "#111827",
};
