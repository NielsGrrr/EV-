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

function isTodayOrLater(iso: string) {
  const matchDate = new Date(iso);
  const now = new Date();
  return matchDate >= now;
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
    <div className="app-container">
      <header className="app-header">
        <h1 className="app-title">EV+ Dashboard</h1>
        <p className="app-sub">Matches du jour Winamax avec cotes 1N2 et EV+ estimé.</p>
      </header>

      <div className="card">
        {isLoading ? (
          <p>Chargement des matchs...</p>
        ) : isError ? (
          <div style={{ color: "#b91c1c" }}>
            Erreur de chargement : {(error as Error).message}
          </div>
        ) : (
          <div className="table-wrap">
            <table className="minimal">
              <thead>
                <tr>
                  <th>Date/heure</th>
                  <th>Match</th>
                  <th>Market</th>
                  <th>Issue</th>
                  <th>Cote</th>
                  <th>Prob. estimée</th>
                  <th>EV+ %</th>
                </tr>
              </thead>
              <tbody>
                {data
                  ?.filter((match) => isTodayOrLater(match.startAt))
                  .flatMap((match) =>
                    match.odds.map((odd) => {
                      const highlight = (odd.evPlus ?? 0) >= evPlusThreshold;
                      return (
                        <tr key={odd.id} className={highlight ? 'ev-high' : ''}>
                          <td>{formatDate(match.startAt)}</td>
                          <td>{`${match.homeTeam} vs ${match.awayTeam}`}</td>
                          <td>{odd.market}</td>
                          <td>{odd.outcome}</td>
                          <td className="price">{odd.price.toFixed(2)}</td>
                          <td className="prob">{odd.probability ? `${(odd.probability * 100).toFixed(1)} %` : "-"}</td>
                          <td className="evval">{odd.evPlus !== null ? `${odd.evPlus.toFixed(1)} %` : "-"}</td>
                        </tr>
                      );
                    })
                  )}
              </tbody>
            </table>
          </div>
        )}
      </div>
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
