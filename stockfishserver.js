import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Pfad zur Stockfish-Exe
const stockfishPath = path.join(__dirname, "stockfish", "stockfish");

export function getBestMove(fen, depth = 10) {
    return new Promise((resolve, reject) => {
        const stockfish = spawn(stockfishPath);

        stockfish.stdin.write(`position fen ${fen}\n`);
        stockfish.stdin.write(`go depth ${depth}\n`);

        stockfish.stdout.on("data", (data) => {
            const text = data.toString();
            if (text.includes("bestmove")) {
                const move = text.split("bestmove ")[1].split(" ")[0];
                resolve(move);
                stockfish.kill();
            }
        });

        stockfish.stderr.on("data", (err) => {
            console.error("Stockfish Error:", err.toString());
            reject(err);
        });

        stockfish.on("exit", (code) => {
            if (code !== 0) reject(new Error(`Stockfish exited with code ${code}`));
        });
    });
}