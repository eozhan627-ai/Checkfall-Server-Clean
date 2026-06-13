import http from "http";
import express from "express";
import path from "path";
import multer from "multer";
import { Server } from "socket.io";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import { Chess } from "chess.js";
import fs from "fs";

console.log("Server starting...");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const avatarDir = path.join(__dirname, "avatars");

fs.mkdirSync(avatarDir, { recursive: true });

const app = express();
app.use(express.json());

// =============================
// STATE
// =============================
const games = new Map();        // PvP games
const botRooms = new Map();     // Bot games
const socketToRoom = new Map();
const finishedGames = new Set();
let waitingPlayer = null;

// =============================
// AVATAR
// =============================
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, avatarDir),
    filename: (req, file, cb) => {
        const userId = req.body.userId || "unknown";
        const ext = path.extname(file.originalname).toLowerCase();
        cb(null, `avatar_${userId}${ext}`);
    },
});

const upload = multer({ storage });

app.post("/upload-avatar", upload.single("avatar"), (req, res) => {
    if (!req.file) return res.status(400).json({ error: "Keine Datei" });

    const BASE_URL = "https://checkfall-server-clean-1.onrender.com";
    const url = `${BASE_URL}/avatars/${req.file.filename}`;

    res.json({ url });
});

app.use("/avatars", express.static(avatarDir));

// =============================
// SOCKET
// =============================
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

function getOpponent(roomId, socketId) {
    const room = io.sockets.adapter.rooms.get(roomId);
    if (!room) return null;

    for (const id of room) {
        if (id !== socketId) return id;
    }
    return null;
}

// =============================
// BOT ENGINE
// =============================
function getEngine(botState) {
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
                if (botState.game.turn() === botState.botColor && !botState.thinking) {
                    startBotMove(botState.roomId);
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

                io.to(botState.roomId).emit("opponent_move", {
                    from: result.from,
                    to: result.to,
                    promotion: result.promotion,
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
    const botState = botRooms.get(roomId);
    if (!botState || botState.thinking) return;

    const engine = getEngine(botState);
    if (!botState.engineReady) return;

    botState.thinking = true;

    setTimeout(() => {
        engine.stdin.write(`position fen ${botState.game.fen()}\n`);
        engine.stdin.write(`go depth 5\n`);
    }, 400);
}

// =============================
// SOCKET EVENTS
// =============================
io.on("connection", (socket) => {
    console.log("Connected:", socket.id);

    // =============================
    // MATCHMAKING PvP
    // =============================
    socket.on("find_match", (data) => {
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

        const game = new Chess();
        games.set(roomId, game);

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
    // PvP MOVE FIX
    // =============================
    socket.on("player_move", ({ roomId, move }) => {
        console.log("MOVE RECEIVED:", move);

        const game = games.get(roomId);

        if (!game) {
            console.log("NO GAME FOR ROOM:", roomId);
            return;
        }

        console.log("SERVER FEN BEFORE:", game.fen());

        const { from, to, promotion } = move;

        const result = game.move({ from, to, promotion });

        console.log("RESULT:", result);

        if (!result) {
            console.log("ILLEGAL MOVE:", move);
            return;
        }

        console.log("SERVER FEN AFTER:", game.fen());

        socket.to(roomId).emit("opponent_move", {
            from: result.from,
            to: result.to,
            promotion: result.promotion,
        });
    });
    // =============================
    // BOT MATCH
    // =============================
    socket.on("find_bot_match", (data) => {
        const { name, avatar, level, playerColor } = data;

        const roomId = `bot_${socket.id}`;
        socket.join(roomId);

        const botIsWhite =
            playerColor === "w" ? false :
                playerColor === "b" ? true :
                    Math.random() < 0.5;

        const game = new Chess();

        botRooms.set(roomId, {
            roomId,
            game,
            level: level || 300,
            botColor: botIsWhite ? "w" : "b",
            thinking: false,
            engineReady: false,
            engine: null,
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

        getEngine(botRooms.get(roomId));

        if (botIsWhite) {
            setTimeout(() => startBotMove(roomId), 500);
        }
    });

    // =============================
    // BOT MOVE FROM PLAYER
    // =============================
    socket.on("player_move", ({ roomId, move }) => {
        const botState = botRooms.get(roomId);
        if (!botState) return;

        const game = botState.game;

        const { from, to, promotion } = move;

        const result = game.move({ from, to, promotion });
        if (!result) return;

        socket.to(roomId).emit("opponent_move", {
            from: result.from,
            to: result.to,
            promotion: result.promotion,
        });

        if (game.turn() === botState.botColor) {
            startBotMove(roomId);
        }
    });

    // =============================
    // RESIGN
    // =============================
    socket.on("resign_game", () => {
        const roomId = socketToRoom.get(socket.id);
        if (!roomId) return;

        if (finishedGames.has(roomId)) return;
        finishedGames.add(roomId);

        const opponentId = getOpponent(roomId, socket.id);
        if (!opponentId) return;

        io.to(roomId).emit("game_over", {
            type: "resign",
            winner: opponentId,
            loser: socket.id,
        });

        games.delete(roomId);
        botRooms.delete(roomId);
    });

    // =============================
    // DISCONNECT
    // =============================
    socket.on("disconnect", () => {
        const roomId = socketToRoom.get(socket.id);
        if (!roomId) return;

        const opponentId = getOpponent(roomId, socket.id);

        io.to(roomId).emit("game_over", {
            type: "disconnect",
            winner: opponentId,
            loser: socket.id,
        });

        games.delete(roomId);
        botRooms.delete(roomId);
        socketToRoom.delete(socket.id);
        socketToRoom.delete(opponentId);
    });
});

// =============================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Server running on", PORT));