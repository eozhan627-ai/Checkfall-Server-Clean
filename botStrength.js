// Bot strength: how a target rating is turned into engine settings.
// Used by the practice bot ("Play vs Bot") and by the computer opponents in
// matchmaking (houseEngine.js).

// Der Slider im Client geht 0 (bzw. 100) bis 3200. Ab 3200 spielt die Engine
// mit voller Stärke (kein UCI_LimitStrength).
export const ELO_MIN = 0;
export const ELO_MAX = 3200;

// Native Grenzen, in denen Stockfish selbst über UCI_Elo kalibriert - hängt
// von der Engine-Version ab! Beim Start wird geloggt, was deine Binary
// tatsächlich als min/max für UCI_Elo meldet (siehe "option name UCI_Elo"
// im Log) - diese beiden Werte ggf. daran anpassen.
export const ENGINE_ELO_MIN = 1320;
export const ENGINE_ELO_MAX = 3190;

// Wie viele Kandidatenzüge wir uns von der Engine geben lassen, um daraus
// im "weak mode" (Ziel-Elo unter ENGINE_ELO_MIN) einen auszuwählen. Hoch
// genug, dass auch richtig schlechte Züge dabei sind (eine Figur einstellen,
// ein Schlagen übersehen) - mit nur 8 Kandidaten waren alle noch ordentlich
// und der Bot hat selbst bei 350 Elo kaum gepatzt.
export const WEAK_MODE_MULTIPV = 30;

export function computeEloProfile(rawElo) {
    const n = Number(rawElo);
    const targetElo = Number.isFinite(n)
        ? Math.min(ELO_MAX, Math.max(ELO_MIN, Math.round(n)))
        : 300;

    const fullStrength = targetElo >= ELO_MAX;
    const engineElo = Math.min(ENGINE_ELO_MAX, Math.max(ENGINE_ELO_MIN, targetElo));

    // 0 = an der nativen Engine-Untergrenze, 1 = ganz unten (Elo 0).
    // Steuert, wie stark wir zusätzlich zu UCI_Elo künstlich "Patzer"
    // einstreuen (die Engine selbst spielt unterhalb ihrer eigenen
    // UCI_Elo-Untergrenze i.d.R. nicht mehr spürbar schwächer).
    const belowFloorRatio =
        targetElo >= ENGINE_ELO_MIN
            ? 0
            : (ENGINE_ELO_MIN - targetElo) / ENGINE_ELO_MIN;

    return {
        targetElo,
        fullStrength,
        engineElo,
        belowFloorRatio,
        weakMode: belowFloorRatio > 0,
    };
}

// Wie viel ein Zug mindestens kostet (in Centipawn), damit er als echter
// Patzer zählt - z.B. eine Figur hängen lassen.
const BLUNDER_LOSS = 150;

/** Chance pro Zug auf einen gezielten Patzer: ~18% bei 350, ~11% bei 800, ~5% bei 1200. */
export function blunderChance(belowFloorRatio) {
    if (belowFloorRatio <= 0) return 0;
    return 0.03 + belowFloorRatio * 0.2;
}

// Wählt aus den (bereits nach cp absteigend sortierten) Kandidatenzügen
// einen aus - so, wie ein Mensch dieser Stärke spielt:
// - mit blunderChance() ein echter Patzer: ein Zug, der mindestens
//   BLUNDER_LOSS kostet (zufällig unter diesen, nicht immer der schlimmste);
// - sonst gewichtet nach Bewertung, mit einer "Temperatur", die nach unten
//   stark wächst: bei 350 Elo werden auch Züge, die 2-3 Bauern kosten,
//   regelmäßig gespielt, bei 1200 fast nur noch gute.
export function chooseWeightedMove(candidates, belowFloorRatio, random = Math.random) {
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0].uci;

    const best = candidates[0].cp;

    if (random() < blunderChance(belowFloorRatio)) {
        const blunders = candidates.filter((c) => best - c.cp >= BLUNDER_LOSS);
        const pool = blunders.length > 0 ? blunders : candidates.slice(Math.ceil(candidates.length / 2));
        return pool[Math.floor(random() * pool.length)].uci;
    }

    // Temperatur in "Centipawn": klein = fast immer bester Zug,
    // groß = auch deutlich schwächere Kandidaten werden regelmäßig gespielt.
    const temperature = 40 + belowFloorRatio * 360;

    const weights = candidates.map((c) => Math.exp(-Math.min(5000, best - c.cp) / temperature));
    const total = weights.reduce((a, b) => a + b, 0);

    let r = random() * total;
    for (let i = 0; i < candidates.length; i++) {
        r -= weights[i];
        if (r <= 0) return candidates[i].uci;
    }

    return candidates[candidates.length - 1].uci;
}
