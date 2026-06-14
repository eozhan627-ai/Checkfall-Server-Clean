import http from "http";
import express from "express";
import { Server } from "socket.io";
import { Chess } from "chess.js";
import { spawn } from "child_process";

const app = express();
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// =============================
// STATE
// =============================
const games = new Map();        // PvP
const botGames = new Map();     // Bot
const socketToRoom = new Map();
let waitingPlayer = null;

// =============================
// GAME FACTORY (PvP)
// =============================
function createPvPGame() {
    return {
        game: new Chess(),
        whiteTime: 300000,
        blackTime: 300000,
        increment: 2000,
        activeColor: "w",
        lastTick: Date.now(),
        players: { w: null, b: null }
    };
}

// =============================
// BOT GAME FACTORY
// =============================
function createBotGame(level = 300) {
    return {
        game: new Chess(),
        level,
        botColor: "b",
        thinking: false,
        engine: null,
        engineReady: false
    };
}

// =============================
// TIMER (PvP ONLY)
// =============================
setInterval(() => {
    const now = Date.now();

    for (const [roomId, g] of games.entries()) {
        const diff = now - g.lastTick;
        g.lastTick = now;

        if (g.activeColor === "w") g.whiteTime -= diff;
        else g.blackTime -= diff;

        if (g.whiteTime <= 0 || g.blackTime <= 0) {
            const winner = g.whiteTime <= 0 ? "b" : "w";

            io.to(roomId).emit("game_over", {
                type: "timeout",
                winner
            });

            games.delete(roomId);
            continue;
        }

        io.to(roomId).emit("timer_update", {
            whiteTime: g.whiteTime,
            blackTime: g.blackTime,
            activeColor: g.activeColor
        });
    }
}, 1000);

// =============================
// STOCKFISH (BOT ENGINE)
// =============================
function getEngine(botState, roomId) {
    if (botState.engine) return botState.engine;

    const engine = spawn("/usr/games/stockfish");
    let buffer = "";

    botState.engineReady = false;

    engine.stdout.on("data", (data) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop();

        for (let line of lines) {
            line = line.trim();

            if (line === "uciok") engine.stdin.write("isready\n");

            if (line === "readyok") {
                botState.engineReady = true;
                if (botState.game.turn() === botState.botColor) {
                    startBotMove(roomId);
                }
            }

            if (line.startsWith("bestmove")) {
                const uci = line.split(" ")[1];
                if (!uci || uci === "(none)") return;

                const from = uci.slice(0, 2);
                const to = uci.slice(2, 4);
                const promotion = uci[4];

                const result = botState.game.move({ from, to, promotion });
                if (!result) return;

                io.to(roomId).emit("opponent_move", {
                    from: result.from,
                    to: result.to,
                    promotion: result.promotion
                });

                botState.thinking = false;
            }
        }
    });

    engine.stdin.write("uci\n");
    botState.engine = engine;
    return engine;
}

function startBotMove(roomId) {
    const botState = botGames.get(roomId);
    if (!botState || botState.thinking) return;

    const engine = getEngine(botState, roomId);
    if (!botState.engineReady) return;

    botState.thinking = true;

    setTimeout(() => {
        engine.stdin.write(`position fen ${botState.game.fen()}\n`);
        engine.stdin.write(`go depth 5\n`);
    }, 300);
}

// =============================
// SOCKET
// =============================
io.on("connection", (socket) => {

    console.log("Connected:", socket.id);

    // =============================
    // PvP MATCHMAKING
    // =============================
    socket.on("find_match", (data) => {
        if (!waitingPlayer) {
            waitingPlayer = { id: socket.id, ...data };
            socket.emit("waiting");
            return;
        }

        const roomId = `${waitingPlayer.id}_${socket.id}`;

        socket.join(roomId);
        io.sockets.sockets.get(waitingPlayer.id)?.join(roomId);

        const game = createPvPGame();
        game.players.w = waitingPlayer.id;
        game.players.b = socket.id;

        games.set(roomId, game);

        socketToRoom.set(waitingPlayer.id, roomId);
        socketToRoom.set(socket.id, roomId);

        io.to(roomId).emit("game_start", {
            roomId,
            white: waitingPlayer.id,
            black: socket.id,
            whiteName: waitingPlayer.name,
            blackName: data.name,

            whiteTime: game.whiteTime,
            blackTime: game.blackTime,
            increment: game.increment
        });

        waitingPlayer = null;
    });

    // =============================
    // BOT MATCH
    // =============================
    socket.on("find_bot_match", (data) => {
        const roomId = `bot_${socket.id}`;
        socket.join(roomId);

        const game = new Chess();

        const botState = createBotGame(data.level);

        botState.game = game;
        botGames.set(roomId, botState);

        socketToRoom.set(socket.id, roomId);

        const botIsWhite = Math.random() < 0.5;
        botState.botColor = botIsWhite ? "w" : "b";

        io.to(roomId).emit("game_start", {
            roomId,
            white: botIsWhite ? "bot" : socket.id,
            black: botIsWhite ? socket.id : "bot",
            whiteName: botIsWhite ? "Stockfish" : data.name,
            blackName: botIsWhite ? data.name : "Stockfish"
        });

        getEngine(botState, roomId);

        if (botIsWhite) {
            setTimeout(() => startBotMove(roomId), 500);
        }
    });

    // =============================
    // PvP MOVE
    // =============================
    socket.on("player_move", ({ roomId, move }) => {
        const g = games.get(roomId);
        if (!g) return;

        const result = g.game.move(move);
        if (!result) return;

        const now = Date.now();
        const diff = now - g.lastTick;

        if (g.activeColor === "w") {
            g.whiteTime -= diff;
            g.whiteTime += g.increment;
        } else {
            g.blackTime -= diff;
            g.blackTime += g.increment;
        }

        g.lastTick = now;
        g.activeColor = g.activeColor === "w" ? "b" : "w";

        io.to(roomId).emit("opponent_move", {
            from: result.from,
            to: result.to,
            promotion: result.promotion
        });

        io.to(roomId).emit("timer_update", {
            whiteTime: g.whiteTime,
            blackTime: g.blackTime,
            activeColor: g.activeColor
        });

        if (g.game.isGameOver()) {
            io.to(roomId).emit("game_over", {
                type: g.game.isCheckmate() ? "checkmate" : "draw"
            });

            games.delete(roomId);
        }
    });

    // =============================
    // RESIGN
    // =============================
    socket.on("resign_game", ({ roomId }) => {
        const g = games.get(roomId);
        if (g) games.delete(roomId);

        const bot = botGames.get(roomId);
        if (bot) botGames.delete(roomId);

        io.to(roomId).emit("game_over", {
            type: "resign",
            winner: "opponent"
        });
    });

    // =============================
    // DISCONNECT
    // =============================
    socket.on("disconnect", () => {
        const roomId = socketToRoom.get(socket.id);
        if (!roomId) return;

        io.to(roomId).emit("game_over", {
            type: "disconnect",
            winner: "opponent"
        });

        games.delete(roomId);
        botGames.delete(roomId);
        socketToRoom.delete(socket.id);
    });
});
// =============================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Server running on", PORT));