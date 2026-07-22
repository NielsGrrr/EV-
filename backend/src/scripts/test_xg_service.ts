import xgService from "../xgService";

const samples = [
  { home: "Paris SG", away: "Marseille" },
  { home: "PSG", away: "Marseille" },
  { home: "Man. Utd", away: "Liverpool" },
  { home: "Manchester City", away: "Man. Utd" }
];

for (const s of samples) {
  const est = xgService.estimateXgForMatch(s.home, s.away);
  console.log(`${s.home} vs ${s.away} ->`, est);
}
