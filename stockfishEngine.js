import { spawn } from "child_process";
import os from "os";

const STOCKFISH_PATH = "/usr/games/stockfish";

// GEÄNDERT: Threads/Hash konfigurierbar, Defaults bewusst NIEDRIG gewählt.
// Ohne diese Optionen läuft Stockfish mit 1 Thread und 16MB Hash - das
// macht jede einzelne Suche langsam. Aber: zu hohe Werte (z.B. Threads=2
// pro Engine bei 6 parallelen Engines = 12 angeforderte Threads) überlasten
// auf kleinen Hosting-Plänen (Render etc.) die CPU beim gleichzeitigen
// Start, was zu STOCKFISH_INIT_TIMEOUT führt. Lieber konservativ starten
// und über die Env-Variablen gezielt an den tatsächlichen Plan anpassen.
const ENGINE_THREADS = Number(process.env.STOCKFISH_THREADS) || 1;
const ENGINE_HASH_MB = Number(process.env.STOCKFISH_HASH_MB) || 32;
// NEU: Timeout großzügiger, weil unter CPU-Last (z.B. mehrere Engines
// starten gleichzeitig) der uciok/readyok-Handshake einfach länger dauern
// kann, ohne dass etwas kaputt ist.
const ENGINE_INIT_TIMEOUT_MS = Number(process.env.STOCKFISH_INIT_TIMEOUT_MS) || 15000;

export function createAnalysisEngine() {
    return new Promise((resolve, reject) => {
        const engine = spawn(STOCKFISH_PATH);
        let buffer = "";
        let uciReady = false;
        let settled = false;

        const timeout = setTimeout(() => {
            if (!settled) {
                settled = true;
                engine.kill(); // NEU: hängenden Prozess nicht als Zombie zurücklassen
                reject(new Error("STOCKFISH_INIT_TIMEOUT"));
            }
        }, ENGINE_INIT_TIMEOUT_MS);

        engine.on("error", (err) => {
            if (!settled) {
                settled = true;
                clearTimeout(timeout);
                reject(err);
            }
        });

        engine.stdout.on("data", (data) => {
            buffer += data.toString();
            const lines = buffer.split("\n");
            buffer = lines.pop();

            for (const line of lines) {
                const trimmed = line.trim();

                if (trimmed === "uciok" && !uciReady) {
                    uciReady = true;
                    engine.stdin.write(`setoption name MultiPV value 2\n`);
                    // NEU: Threads/Hash - der größte Hebel für die Geschwindigkeit
                    // einer EINZELNEN Suche.
                    engine.stdin.write(`setoption name Threads value ${ENGINE_THREADS}\n`);
                    engine.stdin.write(`setoption name Hash value ${ENGINE_HASH_MB}\n`);
                    engine.stdin.write("isready\n");
                }

                if (trimmed === "readyok" && !settled) {
                    settled = true;
                    clearTimeout(timeout);
                    resolve(engine);
                }
            }
        });

        engine.stdin.write("uci\n");
    });
}

export function evaluatePosition(engine, fen, depth) {
    return new Promise((resolve) => {
        const scores = {};
        let bestMove = null;
        let buffer = "";

        const onData = (data) => {
            buffer += data.toString();
            const lines = buffer.split("\n");
            buffer = lines.pop();

            for (const line of lines) {
                const mpvMatch = line.match(/multipv (\d+)/);
                const scoreMatch = line.match(/score (cp|mate) (-?\d+)/);

                if (mpvMatch && scoreMatch) {
                    const idx = parseInt(mpvMatch[1], 10);
                    const [, type, value] = scoreMatch;
                    scores[idx] =
                        type === "mate"
                            ? Number(value) > 0 ? 10000 : -10000
                            : Number(value);
                }

                if (line.startsWith("bestmove")) {
                    bestMove = line.split(" ")[1];
                    engine.stdout.off("data", onData);
                    resolve({
                        evalCp: scores[1] ?? null,
                        secondEvalCp: scores[2] ?? null,
                        bestMove,
                    });
                    return;
                }
            }
        };

        engine.stdout.on("data", onData);

        engine.stdin.write(`position fen ${fen}\n`);
        engine.stdin.write(`go depth ${depth}\n`);
    });
}

export function closeEngine(engine) {
    try {
        engine.stdin.write("quit\n");
        engine.kill();
    } catch (error) {
        console.log("ENGINE CLOSE ERROR:", error);
    }
}

// GEÄNDERT: Poolgröße NICHT mehr von os.cpus() ableiten. Auf Render/in
// Containern liefert os.cpus() oft die Kernzahl der Host-Maschine, nicht
// das tatsächliche CPU-Kontingent des Containers - das führte dazu, dass
// der Pool viel zu groß gewählt wurde (z.B. 6 Engines à 2 Threads auf
// einem 0.5-vCPU-Plan) und die Engines sich beim Start gegenseitig die
// CPU wegnahmen -> STOCKFISH_INIT_TIMEOUT. Fester, konfigurierbarer
// Default stattdessen - an den tatsächlichen Hosting-Plan anpassen.
const DEFAULT_POOL_SIZE = Number(process.env.STOCKFISH_POOL_SIZE) || 2;

export async function createEnginePool(size) {
    const poolSize = size || DEFAULT_POOL_SIZE;

    // NEU: Engines leicht gestaffelt starten statt alle im selben Tick.
    // Das entzerrt die CPU-Spitze beim uci-Handshake, die auf kleinen
    // Instanzen sonst mehrere Engines gleichzeitig ausbremst.
    const settled = [];
    for (let i = 0; i < poolSize; i++) {
        settled.push(
            createAnalysisEngine()
                .then((engine) => ({ status: "fulfilled", value: engine }))
                .catch((error) => ({ status: "rejected", reason: error }))
        );
        if (i < poolSize - 1) await new Promise((r) => setTimeout(r, 250));
    }
    const results = await Promise.all(settled);

    const engines = results.filter((r) => r.status === "fulfilled").map((r) => r.value);
    const failures = results.filter((r) => r.status === "rejected");

    if (failures.length > 0) {
        console.log(`ENGINE POOL: ${failures.length}/${poolSize} Engine(s) beim Start fehlgeschlagen`);
    }

    // NEU: Nicht alles abbrechen, nur weil EINE Engine nicht rechtzeitig
    // hochkam - mit den übrigen weiterarbeiten. Nur wenn wirklich keine
    // einzige Engine bereit ist, ist die Analyse tatsächlich unmöglich.
    if (engines.length === 0) {
        throw new Error("STOCKFISH_POOL_INIT_FAILED");
    }

    return engines;
}

export function closeEnginePool(engines) {
    for (const engine of engines) closeEngine(engine);
}

// NEU: Verteilt eine Liste von Aufgaben (hier: FEN + Tiefe) auf einen
// Engine-Pool. Jede Engine arbeitet ihre eigene Warteschlange ab, sodass
// alle parallel rechnen statt eine nach der anderen. Ergebnisse werden
// an der ursprünglichen Position im Array abgelegt, die Reihenfolge bleibt
// also erhalten, obwohl die Fertigstellung unsortiert reinkommt.
export async function evaluatePositionsInParallel(engines, tasks, onEach) {
    const results = new Array(tasks.length);
    let nextIndex = 0;
    let completed = 0;

    async function worker(engine) {
        while (true) {
            const index = nextIndex++;
            if (index >= tasks.length) return;
            const { fen, depth } = tasks[index];
            const result = await evaluatePosition(engine, fen, depth);
            results[index] = result;
            completed += 1;
            if (onEach) onEach(completed, tasks.length);
        }
    }

    await Promise.all(engines.map((engine) => worker(engine)));
    return results;
}