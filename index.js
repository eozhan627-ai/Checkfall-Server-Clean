import http from "http";
import express from "express";
import { Server } from "socket.io";
import { Chess } from "chess.js";
import { spawn } from "child_process";
import multer from "multer";
import { v2 as cloudinary } from "cloudinary";

const app = express();
app.use(express.json());
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 5 * 1024 * 1024,
    },
});

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});

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
            const winnerSocket =
                g.whiteTime <= 0
                    ? g.players.b
                    : g.players.w;

            io.to(roomId).emit("game_over", {
                type: "timeout",
                winner: winnerSocket,
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
                botState.pending = false;
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

    if (botState.pending) return;

    const engine = getEngine(botState, roomId);
    if (!botState.engineReady) return;

    botState.pending = true;
    botState.thinking = true;

    setTimeout(() => {
        engine.stdin.write(`position fen ${botState.game.fen()}\n`);
        engine.stdin.write(`go depth 5\n`);
    }, 300);
}
app.post("/upload-avatar", upload.single("avatar"), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({
                error: "No avatar uploaded",
            });
        }

        if (!req.body.userId) {
            return res.status(400).json({
                error: "Missing userId",
            });
        }

        const result = await new Promise((resolve, reject) => {
            const stream = cloudinary.uploader.upload_stream(
                {
                    folder: "checkfall/avatars",
                    public_id: req.body.userId,
                    overwrite: true,
                    resource_type: "image",
                },
                (error, result) => {
                    if (error) reject(error);
                    else resolve(result);
                }
            );

            stream.end(req.file.buffer);
        });

        console.log("AVATAR UPLOADED:", result.secure_url);

        res.json({
            success: true,
            url: result.secure_url,
        });

    } catch (error) {
        console.error("AVATAR UPLOAD ERROR:", error);

        res.status(500).json({
            error: "Avatar upload failed",
        });
    }
});
// =============================
// SOCKET
// =============================
io.on("connection", (socket) => {

    console.log("Connected:", socket.id);

    // =============================
    // PvP MATCHMAKING
    // =============================
    socket.on("find_match", (data) => {

        if (waitingPlayer?.id === socket.id) {
            console.log("Already waiting:", socket.id);
            return;
        }

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

            whiteAvatar: waitingPlayer.avatar || "",
            blackAvatar: data.avatar || "",

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

        // ===== BOT =====

        const bot = botGames.get(roomId);

        if (bot) {

            const result = bot.game.move(move);

            if (!result) return;

            socket.to(roomId).emit("opponent_move", {

                from: result.from,

                to: result.to,

                promotion: result.promotion

            });

            if (!bot.game.isGameOver()) {

                startBotMove(roomId);

            }

            return;

        }
        const g = games.get(roomId);
        if (!g) return;

        // Prüfen, ob der Spieler überhaupt am Zug ist
        const expectedPlayer =
            g.activeColor === "w"
                ? g.players.w
                : g.players.b;

        if (socket.id !== expectedPlayer) {
            console.log("Move rejected: not player's turn", {
                socket: socket.id,
                expectedPlayer,
                activeColor: g.activeColor
            });
            return;
        }

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

        // NUR der Gegner bekommt den Zug
        socket.to(roomId).emit("opponent_move", {
            from: result.from,
            to: result.to,
            promotion: result.promotion
        });

        // Beide bekommen den Timer
        io.to(roomId).emit("timer_update", {
            whiteTime: g.whiteTime,
            blackTime: g.blackTime,
            activeColor: g.activeColor
        });
        if (g.game.isGameOver()) {
            if (g.game.isCheckmate()) {
                const winner =
                    g.game.turn() === "w"
                        ? g.players.b
                        : g.players.w;

                io.to(roomId).emit("game_over", {
                    type: "checkmate",
                    winner,
                });
            } else {
                io.to(roomId).emit("game_over", {
                    type: "draw",
                });
            }
            games.delete(roomId);
        }
    });
    // =============================
    // DRAW OFFER
    // =============================
    socket.on("offer_draw", ({ roomId }) => {
        const g = games.get(roomId);

        if (!g) return;

        // Nur Spieler aus dieser Partie dürfen Remis anbieten
        if (
            socket.id !== g.players.w &&
            socket.id !== g.players.b
        ) {
            return;
        }

        const opponent =
            socket.id === g.players.w
                ? g.players.b
                : g.players.w;

        console.log("DRAW OFFER:", {
            from: socket.id,
            opponent,
            roomId,
        });

        io.to(opponent).emit("draw_offer");
    });


    // =============================
    // DRAW ANSWER
    // =============================
    socket.on("answer_draw", ({ roomId, accept }) => {
        const g = games.get(roomId);

        if (!g) return;

        // Nur Spieler aus dieser Partie dürfen antworten
        if (
            socket.id !== g.players.w &&
            socket.id !== g.players.b
        ) {
            return;
        }

        if (accept) {
            console.log("DRAW ACCEPTED:", roomId);

            io.to(roomId).emit("game_over", {
                type: "draw",
            });

            games.delete(roomId);
        } else {
            console.log("DRAW DECLINED:", roomId);

            const opponent =
                socket.id === g.players.w
                    ? g.players.b
                    : g.players.w;

            io.to(opponent).emit("draw_declined");
        }
    });
    // =============================
    // RESIGN
    // =============================
    socket.on("resign_game", ({ roomId }) => {
        const g = games.get(roomId);

        if (!g) return;

        const winner =
            socket.id === g.players.w
                ? g.players.b
                : g.players.w;

        io.to(roomId).emit("game_over", {
            type: "resign",
            winner,
        });

        games.delete(roomId);
    });
    // =============================
    // DISCONNECT
    // =============================
    socket.on("disconnect", () => {
        console.log("Disconnected:", socket.id);

        // Spieler aus der Matchmaking-Warteschlange entfernen
        if (waitingPlayer?.id === socket.id) {
            waitingPlayer = null;
            console.log("Removed disconnected player from waiting queue");
        }

        const roomId = socketToRoom.get(socket.id);

        if (!roomId) {
            return;
        }

        const g = games.get(roomId);

        if (g) {
            const winner =
                socket.id === g.players.w
                    ? g.players.b
                    : g.players.w;

            io.to(roomId).emit("game_over", {
                type: "disconnect",
                winner,
            });

            games.delete(roomId);
        }

        botGames.delete(roomId);
        socketToRoom.delete(socket.id);
    });
});
// =============================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Server running on", PORT));