import { spawn } from "child_process";

const STOCKFISH_PATH = "/usr/games/stockfish"; // gleicher Pfad wie im Bot-Code

export function createAnalysisEngine() {
    return new Promise((resolve, reject) => {
        const engine = spawn(STOCKFISH_PATH);
        let buffer = "";
        let ready = false;

        engine.on("error", (err) => {
            reject(err);
        });

        engine.stdout.on("data", (data) => {
            buffer += data.toString();
            const lines = buffer.split("\n");
            buffer = lines.pop();

            for (const line of lines) {
                if (line.trim() === "uciok" && !ready) {
                    ready = true;
                    resolve(engine);
                }
            }
        });

        engine.stdin.write("uci\n");

        setTimeout(() => {
            if (!ready) reject(new Error("STOCKFISH_INIT_TIMEOUT"));
        }, 5000);
    });
}

export function evaluatePosition(engine, fen, depth) {
    return new Promise((resolve) => {
        let lastScore = null;
        let bestMove = null;
        let buffer = "";

        const onData = (data) => {
            buffer += data.toString();
            const lines = buffer.split("\n");
            buffer = lines.pop();

            for (const line of lines) {
                const scoreMatch = line.match(/score (cp|mate) (-?\d+)/);
                if (scoreMatch) {
                    const [, type, value] = scoreMatch;
                    lastScore =
                        type === "mate"
                            ? Number(value) > 0 ? 10000 : -10000
                            : Number(value);
                }

                if (line.startsWith("bestmove")) {
                    bestMove = line.split(" ")[1];
                    engine.stdout.off("data", onData);
                    resolve({ evalCp: lastScore, bestMove });
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