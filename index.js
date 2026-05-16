import http from "http";
import express from "express";
import path from "path";
import multer from "multer";
import { Server } from "socket.io";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import { Chess } from "chess.js";
import fs from "fs";


console.log("Docker check started");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const avatarDir = path.join(__dirname, "avatars");

// Ordner sicher erstellen (falls nicht vorhanden)
fs.mkdirSync(avatarDir, { recursive: true });

const app = express();
app.use(express.json());

const botRooms = new Map();

// =============================
// AVATAR UPLOAD
// =============================
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, avatarDir),
    filename: (req, file, cb) => {
        console.log("BODY:", req.body); // DEBUG

        const userId = req.body.userId || "unknown";
        const ext = path.extname(file.originalname).toLowerCase();
        cb(null, `avatar_${userId}${ext}`);
    },
});

const upload = multer({ storage });
app.post("/upload-avatar", upload.single("avatar"), (req, res) => {
    if (!req.file) return res.status(400).json({ error: "Keine Datei" });
    const url = `https://${req.get("host")}/avatars/${req.file.filename}`;
    res.json({ url });
});
app.use("/avatars", express.static(path.join(avatarDir)));

// =============================
// SOCKET SERVER
// =============================
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
const socketToRoom = new Map();
function getOpponent(roomId, socketId) {
    const room = io.sockets.adapter.rooms.get(roomId);
    if (!room) return null;

    for (const id of room) {
        if (id !== socketId) return id;
    }
    return null;
}

function getEngine(botState) {
    if (botState.engine) {
        return botState.engine;
    }

    const engine = spawn("/usr/games/stockfish");
    let buffer = "";

    botState.engineReady = false;

    engine.stdout.on("data", (data) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop();

        for (let line of lines) {
            line = line.trim();

            if (line === "uciok") {
                engine.stdin.write("isready\n");
            }

            if (line === "readyok") {
                botState.engineReady = true;
                console.log("✅ Stockfish ready");

                if (
                    botState.game.turn() === botState.botColor &&
                    !botState.thinking
                ) {
                    startBotMove(botState.roomId);
                }
            }
            if (line.startsWith("bestmove")) {
                const move = line.split(" ")[1];
                const game = botState.game;

                const result = game.move({
                    from: move.slice(0, 2),
                    to: move.slice(2, 4),
                    promotion: move.length > 4 ? move[4] : undefined
                });

                if (!result) {
                    console.log("❌ STOCKFISH INVALID MOVE:", move);
                    botState.thinking = false;
                    return;
                }

                io.to(botState.roomId).emit("opponent_move", move);

                botState.thinking = false;
            }
        }
    });

    engine.stdin.write("uci\n");

    botState.engine = engine;
    return engine;
}
function eloToSkill(level) {
    switch (level) {
        case 100:
            return 0;

        case 300:
            return 3;

        case 500:
            return 6;

        case 1000:
            return 10;

        default:
            return 3;
    }
}
function eloToDepth(level) {
    switch (level) {
        case 100:
            return 2;

        case 300:
            return 4;

        case 500:
            return 6;

        case 1000:
            return 9;

        default:
            return 4;
    }
}
function startBotMove(roomId) {
    const botState = botRooms.get(roomId);
    if (!botState) return;
    if (botState.thinking) return;

    const engine = getEngine(botState);

    if (!botState.engineReady) {
        console.log("⏳ Engine noch nicht ready");
        return;
    }

    botState.thinking = true;

    setTimeout(() => {
        const depth = eloToDepth(botState.level);
        const skill = eloToSkill(botState.level);

        console.log("BOT LEVEL:", botState.level);
        console.log("BOT DEPTH:", depth);
        console.log("BOT SKILL:", skill);

        engine.stdin.write(`setoption name Skill Level value ${skill}\n`);
        engine.stdin.write(`position fen ${botState.game.fen()}\n`);
        engine.stdin.write(`go depth ${depth}\n`);
    }, 500);
}
let waitingPlayer = null;

io.on("connection", (socket) => {
    console.log("Spieler verbunden:", socket.id);

    // =============================
    // BOT-MATCH 
    // =============================
    socket.on("find_bot_match", (data) => {
        const { name, avatar, level } = data;

        const roomId = `bot_${socket.id}`;
        socket.join(roomId);

        const botIsWhite = Math.random() < 0.5;

        const game = new Chess();

        botRooms.set(roomId, {
            roomId,
            level: level || 10,
            game,
            engine: null,
            thinking: false,
            engineReady: false,
            botColor: botIsWhite ? "w" : "b",
        });

        io.to(roomId).emit("game_start", {
            roomId,
            white: botIsWhite ? "bot" : socket.id,
            black: botIsWhite ? socket.id : "bot",
            whiteName: botIsWhite ? "Stockfish" : name,
            blackName: botIsWhite ? name : "Stockfish",
            whiteAvatar: "",
            blackAvatar: avatar || "",
        });

        // WICHTIG → Bot startet sofort wenn Weiß
        getEngine(botRooms.get(roomId));

        setTimeout(() => {
            if (botIsWhite) {
                startBotMove(roomId);
            }
        }, 500);
    });

    // =============================
    // SPIELERZUG (PvP)
    // =============================
    socket.on("player_move", async ({ roomId, move }) => {


        const botState = botRooms.get(roomId);
        const isBotGame = !!botState;

        if (isBotGame && botState.thinking) return;


        const game = botState?.game;

        if (isBotGame && game) {
            const result = game.move({
                from: move.slice(0, 2),
                to: move.slice(2, 4),
                promotion: move.length > 4 ? move[4] : undefined
            });

            if (!result) {
                console.log("❌ INVALID PLAYER MOVE");
                botState.thinking = false;
                return;
            }
        }
        if (isBotGame && game.turn() === botState.botColor) {
            console.log("🤖 Bot ist dran → starte Zug");
            startBotMove(roomId);
        }

        if (!isBotGame) {
            socket.to(roomId).emit("opponent_move", move);
        }

        console.log("📦 BOT STATE:", botState);
        console.log("🤖 isBotGame:", isBotGame);

        if (!isBotGame) return;
        console.log("🚀 STARTING STOCKFISH");

    });
    // =============================
    // MATCHMAKING
    // =============================
    socket.on("find_match", (data) => {
        if (!data) return console.log("find_match ohne Daten");

        const { name, avatar } = data;
        const player = { id: socket.id, name, avatar };

        if (!waitingPlayer) {
            waitingPlayer = player;
            socket.emit("waiting");
            return;
        }

        const roomId = `${waitingPlayer.id}_${socket.id}`;
        socket.join(roomId);
        io.sockets.sockets.get(waitingPlayer.id)?.join(roomId);

        socketToRoom.set(waitingPlayer.id, roomId);
        socketToRoom.set(socket.id, roomId);

        io.to(roomId).emit("game_start", {
            roomId,
            white: waitingPlayer.id,
            black: socket.id,
            whiteName: waitingPlayer.name,
            blackName: player.name,
            whiteAvatar: waitingPlayer.avatar || "",
            blackAvatar: player.avatar || "",
        });

        waitingPlayer = null;
    });
    // =============================
    // AUFGABE
    // =============================
    socket.on("resign_game", () => {
        const roomId = socketToRoom.get(socket.id);
        if (!roomId) return;

        const opponentId = getOpponent(roomId, socket.id);
        if (!opponentId) return;

        io.to(socket.id).emit("game_over", {
            type: "resign",
            result: "lost",
        });

        io.to(opponentId).emit("game_over", {
            type: "resign",
            result: "won",
        });

        socketToRoom.delete(socket.id);
        socketToRoom.delete(opponentId);
    });
    // =============================
    // REMIS
    // =============================
    socket.on("offer_draw", ({ roomId }) => {
        const opponentId = getOpponent(roomId, socket.id);
        if (!opponentId) return;

        io.to(opponentId).emit("draw_offer");
    });
    socket.on("answer_draw", ({ roomId, accept }) => {
        const opponentId = getOpponent(roomId, socket.id);
        if (!opponentId) return;

        if (accept) {
            io.to(roomId).emit("game_over", {
                type: "draw",
            });
        } else {
            io.to(opponentId).emit("draw_declined");
        }
    });

    // =============================
    // DISCONNECT
    // =============================
    socket.on("disconnect", () => {
        console.log("Spieler getrennt:", socket.id);

        // Warteschlange cleanup
        if (waitingPlayer?.id === socket.id) {
            waitingPlayer = null;
            return;
        }

        const roomId = socketToRoom.get(socket.id);

        if (!roomId) return;

        const opponentId = getOpponent(roomId, socket.id);

        if (opponentId) {
            io.to(opponentId).emit("game_over", {
                type: "disconnect",
                result: "won",
                message: "Dein Gegner hat das Spiel verlassen.",
            });

            socketToRoom.delete(opponentId);
        }

        socketToRoom.delete(socket.id);

        // optional Bot cleanup
        botRooms.delete(roomId);
    });
});
// =============================
// SERVER START
// =============================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Server läuft auf Port ${PORT}`));