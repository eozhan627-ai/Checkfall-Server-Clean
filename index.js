import http from "http";
import express from "express";
import { Server } from "socket.io";
import { Chess } from "chess.js";
import { spawn } from "child_process";

const app = express();
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

/* =========================
   STATE
========================= */

const games = new Map();
const botGames = new Map();
const socketToRoom = new Map();
let waitingPlayer = null;

/* =========================
   PVP GAME
========================= */

function createPvPGame() {
    return {
        game: new Chess(),
        whiteTime: 300000,
        blackTime: 300000,
        increment: 2000,
        active: "w",
        lastTick: Date.now(),
        players: { w: null, b: null },
    };
}

/* =========================
   BOT GAME
========================= */

function createBotGame(level = 300) {
    return {
        game: new Chess(),
        level,
        botColor: "b",
        engine: null,
        ready: false,
        thinking: false,
    };
}

/* =========================
   TIMER
========================= */

setInterval(() => {
    const now = Date.now();

    for (const [roomId, g] of games.entries()) {
        const diff = now - g.lastTick;
        g.lastTick = now;

        if (g.active === "w") g.whiteTime -= diff;
        else g.blackTime -= diff;

        if (g.whiteTime <= 0 || g.blackTime <= 0) {
            const winner = g.whiteTime <= 0 ? "b" : "w";

            io.to(roomId).emit("game_over", {
                type: "timeout",
                winner,
            });

            games.delete(roomId);
            continue;
        }

        io.to(roomId).emit("timer_update", {
            whiteTime: g.whiteTime,
            blackTime: g.blackTime,
            activeColor: g.active,
        });
    }
}, 1000);

/* =========================
   STOCKFISH ENGINE
========================= */

function getEngine(botState, roomId) {
    if (botState.engine) return botState.engine;

    const engine = spawn("/usr/games/stockfish");
    let buffer = "";

    engine.stdout.on("data", (data) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop();

        for (let line of lines) {
            line = line.trim();

            if (line === "uciok") engine.stdin.write("isready\n");

            if (line === "readyok") {
                botState.ready = true;
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

                const move = botState.game.move({ from, to, promotion });
                if (!move) return;

                io.to(roomId).emit("opponent_move", {
                    from: move.from,
                    to: move.to,
                    promotion: move.promotion,
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
    if (!botState.ready) return;

    botState.thinking = true;

    setTimeout(() => {
        engine.stdin.write(`position fen ${botState.game.fen()}\n`);
        engine.stdin.write(`go depth 5\n`);
    }, 300);
}

/* =========================
   SOCKET
========================= */

io.on("connection", (socket) => {

    /* ========= MATCHMAKING ========= */
    socket.on("find_match", (data) => {

        if (!waitingPlayer) {
            waitingPlayer = { id: socket.id, name: data?.name };
            socket.emit("waiting");
            return;
        }

        const roomId = `${waitingPlayer.id}_${socket.id}`;

        const game = createPvPGame();
        game.players.w = waitingPlayer.id;
        game.players.b = socket.id;

        games.set(roomId, game);

        socket.join(roomId);
        io.sockets.sockets.get(waitingPlayer.id)?.join(roomId);

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
            increment: game.increment,
        });

        waitingPlayer = null;
    });

    /* ========= BOT MATCH ========= */
    socket.on("find_bot_match", (data) => {

        const roomId = `bot_${socket.id}`;
        socket.join(roomId);

        const botState = createBotGame(data.level);

        const game = new Chess();
        botState.game = game;

        const botIsWhite = Math.random() < 0.5;
        botState.botColor = botIsWhite ? "w" : "b";

        botGames.set(roomId, botState);
        socketToRoom.set(socket.id, roomId);

        io.to(roomId).emit("game_start", {
            roomId,
            white: botIsWhite ? "bot" : socket.id,
            black: botIsWhite ? socket.id : "bot",
            whiteName: botIsWhite ? "Stockfish" : data.name,
            blackName: botIsWhite ? data.name : "Stockfish",
        });

        getEngine(botState, roomId);

        if (botIsWhite) {
            setTimeout(() => startBotMove(roomId), 500);
        }
    });

    /* ========= MOVE ========= */
    socket.on("player_move", ({ roomId, move }) => {

        /* ===== PVP ===== */
        const g = games.get(roomId);

        if (g) {

            const color =
                socket.id === g.white ? "w" :
                    socket.id === g.black ? "b" :
                        null;

            if (!color || color !== g.active) return;

            const now = Date.now();
            const diff = now - g.lastTick;
            g.lastTick = now;

            if (g.active === "w") {
                g.whiteTime += g.increment - diff;
            } else {
                g.blackTime += g.increment - diff;
            }

            let result;
            try {
                result = g.game.move(move);
            } catch {
                return;
            }

            if (!result) return;

            g.active = g.active === "w" ? "b" : "w";

            io.to(roomId).emit("opponent_move", {
                from: result.from,
                to: result.to,
                promotion: result.promotion,
            });

            io.to(roomId).emit("timer_update", {
                whiteTime: g.whiteTime,
                blackTime: g.blackTime,
                activeColor: g.active,
            });

            if (g.game.isGameOver()) {
                io.to(roomId).emit("game_over", {
                    type: g.game.isCheckmate() ? "checkmate" : "draw",
                });

                games.delete(roomId);
            }

            return;
        }

        /* ===== BOT ===== */
        const bot = botGames.get(roomId);
        if (!bot) return;

        try {
            bot.game.move(move);
        } catch {
            return;
        }

        if (bot.game.turn() === bot.botColor) {
            startBotMove(roomId);
        }
    });

    /* ========= RESIGN ========= */
    socket.on("resign_game", ({ roomId }) => {
        const g = games.get(roomId);

        if (g) {
            const winner =
                socket.id === g.white ? g.black : g.white;

            io.to(roomId).emit("game_over", {
                type: "resign",
                winner,
            });

            games.delete(roomId);
        }

        botGames.delete(roomId);
    });

    /* ========= DISCONNECT ========= */
    socket.on("disconnect", () => {

        const roomId = socketToRoom.get(socket.id);
        if (!roomId) return;

        const g = games.get(roomId);
        if (!g) return;

        const winner =
            socket.id === g.white ? g.black : g.white;

        io.to(roomId).emit("game_over", {
            type: "disconnect",
            winner,
        });

        games.delete(roomId);
        botGames.delete(roomId);
        socketToRoom.delete(socket.id);
    });
});

server.listen(3000, () => console.log("server running"));