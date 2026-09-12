import { spawn } from "child_process";

const STOCKFISH_PATH = "/usr/games/stockfish";

export function createAnalysisEngine() {
    return new Promise((resolve, reject) => {
        const engine = spawn(STOCKFISH_PATH);
        let buffer = "";
        let uciReady = false;

        engine.on("error", (err) => reject(err));

        engine.stdout.on("data", (data) => {
            buffer += data.toString();
            const lines = buffer.split("\n");
            buffer = lines.pop();

            for (const line of lines) {
                const trimmed = line.trim();

                if (trimmed === "uciok" && !uciReady) {
                    uciReady = true;
                    engine.stdin.write("setoption name MultiPV value 2\n");
                    engine.stdin.write("isready\n");
                }

                if (trimmed === "readyok") {
                    resolve(engine);
                }
            }
        });

        engine.stdin.write("uci\n");

        setTimeout(() => {
            if (!uciReady) reject(new Error("STOCKFISH_INIT_TIMEOUT"));
        }, 5000);
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