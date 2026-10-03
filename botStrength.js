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
// im "weak mode" (Ziel-Elo unter ENGINE_ELO_MIN) gewichtet einen auszuwählen
// statt immer stur den Top-Zug zu spielen.
export const WEAK_MODE_MULTIPV = 8;

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

// Wählt aus den (bereits nach cp absteigend sortierten) Kandidatenzügen
// gewichtet einen aus. Je höher belowFloorRatio, desto "flacher" die
// Gewichtung (mehr Ungenauigkeiten) und desto größer die Chance auf einen
// echten Patzer (schwächster der Kandidaten wird gespielt - z.B. eine
// Figur, die dabei hängen bleibt).
export function chooseWeightedMove(candidates, belowFloorRatio) {
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0].uci;

    const best = candidates[0].cp;

    // Temperatur in "Centipawn": klein = fast immer bester Zug,
    // groß = auch deutlich schwächere Kandidaten werden regelmäßig gespielt.
    const temperature = 35 + belowFloorRatio * 220;

    const blunderChance = belowFloorRatio * 0.16; // bis zu ~16% bei Elo 0
    if (Math.random() < blunderChance) {
        return candidates[candidates.length - 1].uci;
    }

    const weights = candidates.map((c) => Math.exp(-(best - c.cp) / temperature));
    const total = weights.reduce((a, b) => a + b, 0);

    let r = Math.random() * total;
    for (let i = 0; i < candidates.length; i++) {
        r -= weights[i];
        if (r <= 0) return candidates[i].uci;
    }

    return candidates[candidates.length - 1].uci;
}
