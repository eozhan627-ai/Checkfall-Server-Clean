import { spawn } from "child_process";
import os from "os";

const STOCKFISH_PATH = "/usr/games/stockfish";

// GEÄNDERT: Threads/Hash konfigurierbar, Default sinnvoll gewählt.
// Ohne diese Optionen läuft Stockfish mit 1 Thread und 16MB Hash -
// das macht JEDE einzelne Suche unnötig langsam, unabhängig von Parallelisierung.
const ENGINE_THREADS = Number(process.env.STOCKFISH_THREADS) || 2;
const ENGINE_HASH_MB = Number(process.env.STOCKFISH_HASH_MB) || 128;

export function createAnalysisEngine() {
    return new Promise((resolve, reject) => {
        const engine = spawn(STOCKFISH_PATH);
        let buffer = "";
        let uciReady = false;
        let settled = false;

        const timeout = setTimeout(() => {
            if (!settled) {
                settled = true;
                reject(new Error("STOCKFISH_INIT_TIMEOUT"));
            }
        }, 5000);

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

// NEU: Pool aus mehreren Engine-Prozessen für parallele Analyse.
// Größe defaultmäßig an CPU-Kerne gekoppelt (minus 1, damit der Rechner
// nicht komplett dicht ist), aber gedeckelt, weil jede Engine-Instanz
// selbst schon ENGINE_THREADS Kerne beansprucht.
export async function createEnginePool(size) {
    const poolSize = size || Math.max(1, Math.min(6, os.cpus().length - 1));
    const engines = await Promise.all(
        Array.from({ length: poolSize }, () => createAnalysisEngine())
    );
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