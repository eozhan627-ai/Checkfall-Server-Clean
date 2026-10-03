// Stockfish process for one computer opponent in matchmaking (housePlayer.js).
// Strength is set the same way as for the practice bot (botStrength.js).

import { spawn } from "child_process";
import { chooseWeightedMove, computeEloProfile, WEAK_MODE_MULTIPV } from "./botStrength.js";

const STOCKFISH_PATH = process.env.STOCKFISH_PATH || "/usr/games/stockfish";
const READY_TIMEOUT_MS = 8000;
// Small on purpose: several of these may run next to the analysis engines.
const HASH_MB = Number(process.env.HOUSE_HASH_MB) || 16;

// Resolves with { search(fen, movetimeMs), quit() } once the engine is ready.
// search() resolves with { uci, scoreCp } or null (engine gone / no move);
// scoreCp is from the point of view of the side to move.
export function createHouseEngine(rating) {
    const profile = computeEloProfile(rating);

    return new Promise((resolve, reject) => {
        let engine;

        try {
            engine = spawn(STOCKFISH_PATH);
        } catch (error) {
            reject(error);
            return;
        }

        let buffer = "";
        let ready = false;
        let dead = false;
        let pending = null; // { resolve, timer }
        let candidates = new Map(); // multipv index -> { cp, uci }

        const write = (text) => {
            if (dead) return;
            try {
                engine.stdin.write(text);
            } catch (error) {
                // Engine already gone; handled by the exit event.
            }
        };

        const settle = (value) => {
            if (!pending) return;
            const { resolve: done, timer } = pending;
            pending = null;
            clearTimeout(timer);
            done(value);
        };

        const shutdown = (error) => {
            if (dead) return;
            dead = true;
            clearTimeout(readyTimer);
            settle(null);

            try {
                engine.kill();
            } catch (killError) {
                // nothing left to stop
            }

            if (!ready) reject(error ?? new Error("HOUSE_ENGINE_STOPPED"));
        };

        const readyTimer = setTimeout(() => shutdown(new Error("HOUSE_ENGINE_TIMEOUT")), READY_TIMEOUT_MS);

        engine.on("error", (error) => shutdown(error));
        engine.on("exit", () => shutdown(new Error("HOUSE_ENGINE_EXITED")));
        engine.stdin.on("error", () => {});

        const api = {
            search(fen, movetimeMs) {
                if (dead || pending) return Promise.resolve(null);

                return new Promise((done) => {
                    candidates = new Map();

                    const time = Math.max(50, Math.round(movetimeMs));

                    pending = {
                        resolve: done,
                        // The engine must never keep a game waiting.
                        timer: setTimeout(() => settle(null), time + 5000),
                    };

                    write(`position fen ${fen}\n`);
                    write(`go movetime ${time}\n`);
                });
            },

            quit() {
                if (dead) return;
                write("quit\n");
                ready = true; // a stop on purpose is not a start-up failure
                shutdown();
            },
        };

        engine.stdout.on("data", (data) => {
            buffer += data.toString();

            const lines = buffer.split("\n");
            buffer = lines.pop();

            for (let line of lines) {
                line = line.trim();

                if (line === "uciok") {
                    write("setoption name Threads value 1\n");
                    write(`setoption name Hash value ${HASH_MB}\n`);

                    if (profile.fullStrength) {
                        write("setoption name UCI_LimitStrength value false\n");
                        write("setoption name MultiPV value 1\n");
                    } else {
                        write("setoption name UCI_LimitStrength value true\n");
                        write(`setoption name UCI_Elo value ${profile.engineElo}\n`);
                        write(`setoption name MultiPV value ${profile.weakMode ? WEAK_MODE_MULTIPV : 1}\n`);
                    }

                    write("isready\n");
                    continue;
                }

                if (line === "readyok" && !ready) {
                    ready = true;
                    clearTimeout(readyTimer);
                    resolve(api);
                    continue;
                }

                if (line.startsWith("info") && line.includes(" pv ")) {
                    const score = line.match(/score (cp|mate) (-?\d+)/);
                    const pv = line.match(/ pv (\S+)/);
                    if (!score || !pv) continue;

                    const index = Number(line.match(/multipv (\d+)/)?.[1] ?? 1);
                    let cp = Number(score[2]);

                    if (score[1] === "mate") {
                        cp = cp > 0 ? 100000 - cp : -100000 - cp;
                    }

                    candidates.set(index, { cp, uci: pv[1] });
                    continue;
                }

                if (line.startsWith("bestmove")) {
                    const engineMove = line.split(" ")[1];
                    const best = candidates.get(1);
                    let uci = engineMove;

                    // Below the engine's own lowest rating: do not always
                    // play the top move, like a human beginner.
                    if (profile.weakMode && candidates.size > 0) {
                        const sorted = Array.from(candidates.values())
                            .filter((candidate) => candidate.uci && candidate.uci !== "(none)")
                            .sort((a, b) => b.cp - a.cp);

                        uci = chooseWeightedMove(sorted, profile.belowFloorRatio) || engineMove;
                    }

                    if (!uci || uci === "(none)") {
                        settle(null);
                    } else {
                        settle({ uci, scoreCp: best ? best.cp : null });
                    }
                }
            }
        });

        write("uci\n");
    });
}
