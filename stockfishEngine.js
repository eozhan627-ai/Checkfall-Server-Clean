import { spawn } from "child_process";

// Path of the Stockfish binary. The Docker image installs it to
// /usr/games/stockfish; override with STOCKFISH_PATH for local testing.
const STOCKFISH_PATH = process.env.STOCKFISH_PATH || "/usr/games/stockfish";

// Threads/Hash deliberately LOW by default. Too high values (e.g. Threads=2
// per engine with several engines in parallel) overload small hosting plans
// during start-up. Tune via env variables for the plan actually in use.
const ENGINE_THREADS = Number(process.env.STOCKFISH_THREADS) || 1;
const ENGINE_HASH_MB = Number(process.env.STOCKFISH_HASH_MB) || 32;
const ENGINE_INIT_TIMEOUT_MS = Number(process.env.STOCKFISH_INIT_TIMEOUT_MS) || 15000;

// Number of engines working on one analysis at the same time.
const DEFAULT_POOL_SIZE = Number(process.env.STOCKFISH_POOL_SIZE) || 2;

export function getPoolSize() {
    return DEFAULT_POOL_SIZE;
}

export function createAnalysisEngine() {
    return new Promise((resolve, reject) => {
        const engine = spawn(STOCKFISH_PATH);
        let buffer = "";
        let uciReady = false;
        let settled = false;

        const timeout = setTimeout(() => {
            if (!settled) {
                settled = true;
                engine.kill(); // do not leave a hanging process behind
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

        const onData = (data) => {
            buffer += data.toString();
            const lines = buffer.split("\n");
            buffer = lines.pop();

            for (const line of lines) {
                const trimmed = line.trim();

                if (trimmed === "uciok" && !uciReady) {
                    uciReady = true;
                    // Two lines: the second one tells us whether the best
                    // move was the ONLY good move ("great move").
                    engine.stdin.write("setoption name MultiPV value 2\n");
                    engine.stdin.write(`setoption name Threads value ${ENGINE_THREADS}\n`);
                    engine.stdin.write(`setoption name Hash value ${ENGINE_HASH_MB}\n`);
                    engine.stdin.write("isready\n");
                }

                if (trimmed === "readyok" && !settled) {
                    settled = true;
                    clearTimeout(timeout);
                    engine.stdout.off("data", onData);
                    resolve(engine);
                }
            }
        };

        engine.stdout.on("data", onData);
        engine.stdin.write("uci\n");
    });
}

function parseScore(type, value) {
    const number = Number(value);
    return type === "mate" ? { cp: null, mate: number } : { cp: number, mate: null };
}

/**
 * Evaluates one position.
 *
 * @param {import("child_process").ChildProcess} engine
 * @param {string} fen
 * @param {{ depth: number, movetime: number }} limits the search stops at
 *        whichever limit is reached first
 * @returns {Promise<{cp:number|null, mate:number|null, second:{cp:number|null,mate:number|null}|null, bestMove:string|null, pv:string[], depth:number}>}
 *          scores are from the point of view of the side to move
 */
export function evaluatePosition(engine, fen, limits) {
    return new Promise((resolve) => {
        const lines = {}; // multipv index -> { score, pv, depth }
        let buffer = "";
        let finished = false;

        const finish = (bestMove) => {
            if (finished) return;
            finished = true;

            clearTimeout(safety);
            engine.stdout.off("data", onData);

            const first = lines[1] ?? null;
            const second = lines[2] ?? null;

            resolve({
                cp: first?.score.cp ?? null,
                mate: first?.score.mate ?? null,
                second: second ? second.score : null,
                bestMove: bestMove && bestMove !== "(none)" ? bestMove : first?.pv[0] ?? null,
                pv: first?.pv ?? [],
                depth: first?.depth ?? 0,
            });
        };

        // Output that still belongs to an earlier search (e.g. one that was
        // cut off) is ignored until the engine confirms it is ready.
        let synced = false;

        const onData = (data) => {
            buffer += data.toString();
            const chunks = buffer.split("\n");
            buffer = chunks.pop();

            for (const raw of chunks) {
                const line = raw.trim();

                if (!synced) {
                    if (line === "readyok") {
                        synced = true;
                        engine.stdin.write(`go depth ${limits.depth} movetime ${limits.movetime}\n`);
                    }
                    continue;
                }

                if (line.startsWith("info") && line.includes(" pv ")) {
                    // Bound-only updates are not a real evaluation yet.
                    if (line.includes("lowerbound") || line.includes("upperbound")) continue;

                    const mpv = line.match(/ multipv (\d+)/);
                    const score = line.match(/ score (cp|mate) (-?\d+)/);
                    const depth = line.match(/ depth (\d+)/);
                    const pv = line.match(/ pv (.+)$/);

                    if (score && pv) {
                        const index = mpv ? parseInt(mpv[1], 10) : 1;

                        lines[index] = {
                            score: parseScore(score[1], score[2]),
                            pv: pv[1].trim().split(/\s+/),
                            depth: depth ? parseInt(depth[1], 10) : 0,
                        };
                    }
                    continue;
                }

                if (line.startsWith("bestmove")) {
                    finish(line.split(" ")[1]);
                    return;
                }
            }
        };

        // If the engine never answers (crashed, killed), do not hang the
        // whole analysis - continue with whatever was reported so far.
        const safety = setTimeout(() => {
            try {
                engine.stdin.write("stop\n");
            } catch {
                // engine is gone - nothing to stop
            }
            finish(null);
        }, limits.movetime + 8000);

        engine.stdout.on("data", onData);

        engine.stdin.write(`position fen ${fen}\n`);
        engine.stdin.write("isready\n");
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

export async function createEnginePool(size) {
    const poolSize = size || DEFAULT_POOL_SIZE;

    // Start engines slightly staggered instead of all in the same tick -
    // that flattens the CPU peak of the uci handshake on small instances.
    const settled = [];
    for (let i = 0; i < poolSize; i++) {
        settled.push(
            createAnalysisEngine()
                .then((engine) => ({ status: "fulfilled", value: engine }))
                .catch((error) => ({ status: "rejected", reason: error }))
        );
        if (i < poolSize - 1) await new Promise((r) => setTimeout(r, 150));
    }
    const results = await Promise.all(settled);

    const engines = results.filter((r) => r.status === "fulfilled").map((r) => r.value);
    const failures = results.filter((r) => r.status === "rejected");

    if (failures.length > 0) {
        console.log(`ENGINE POOL: ${failures.length}/${poolSize} engine(s) failed to start`);
    }

    // One engine failing is no reason to give up - work with the rest.
    if (engines.length === 0) {
        throw new Error("STOCKFISH_POOL_INIT_FAILED");
    }

    return engines;
}

export function closeEnginePool(engines) {
    for (const engine of engines) closeEngine(engine);
}

/**
 * Evaluates many positions on a pool of engines.
 *
 * Each engine gets one CONTIGUOUS part of the game and walks through it in
 * order. Consecutive positions share most of their search tree, so the
 * engine's hash table from the previous position speeds up the next one -
 * noticeably faster than handing positions out round-robin.
 *
 * @param {Array} engines
 * @param {Array<{ fen: string, depth: number, movetime: number, skip?: object }>} tasks
 *        a task with `skip` is not sent to the engine; `skip` is its result
 * @param {{ onStart?: (index:number, engineIndex:number)=>void, onResult?: (index:number, result:object, done:number, total:number)=>void }} hooks
 */
export async function evaluatePositionsInParallel(engines, tasks, hooks = {}) {
    const results = new Array(tasks.length);
    let completed = 0;

    const chunkSize = Math.ceil(tasks.length / engines.length);

    async function worker(engine, engineIndex) {
        const start = engineIndex * chunkSize;
        const end = Math.min(tasks.length, start + chunkSize);

        for (let index = start; index < end; index++) {
            const task = tasks[index];
            let result;

            if (task.skip) {
                result = task.skip;
            } else {
                hooks.onStart?.(index, engineIndex);
                result = await evaluatePosition(engine, task.fen, {
                    depth: task.depth,
                    movetime: task.movetime,
                });
            }

            results[index] = result;
            completed += 1;
            hooks.onResult?.(index, result, completed, tasks.length);
        }
    }

    await Promise.all(engines.map((engine, engineIndex) => worker(engine, engineIndex)));
    return results;
}
