import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const stockfishPath = path.join(__dirname, "stockfish", "stockfish");

export function getBestMove(fen, depth = 10) {
    return new Promise((resolve, reject) => {

        const engine = spawn(stockfishPath);

        engine.stdin.write(`position fen ${fen}\n`);
        engine.stdin.write(`go depth ${depth}\n`);

        engine.stdout.on("data", (data) => {
            const text = data.toString();

            if (text.includes("bestmove")) {
                const move = text.split("bestmove ")[1].split(" ")[0];
                resolve(move);
                engine.kill();
            }
        });

        engine.stderr.on("data", reject);

        engine.on("exit", (code) => {
            if (code !== 0) reject(new Error("Stockfish crashed"));
        });
    });
}