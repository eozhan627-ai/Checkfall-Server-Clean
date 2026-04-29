import http from "http";
import express from "express";
import path from "path";
import multer from "multer";
import { Server } from "socket.io";
import { fileURLToPath } from "url";
import { spawn, execSync } from "child_process";
import { Chess } from "chess.js";

console.log("Docker check started");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);


const app = express();
app.use(express.json());

const botRooms = new Map();

// =============================
// AVATAR UPLOAD
// =============================
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, path.join(__dirname, "avatars")),
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
app.use("/avatars", express.static(path.join(__dirname, "avatars")));

// =============================
// SOCKET SERVER
// =============================
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
function getEngine(botState) {
    if (botState.engine) return botState.engine;

    const engine = spawn("/usr/games/stockfish");

    let buffer = "";

    botState.engine = engine;
    return engine;
}
function startBotMove(roomId) {
    const botState = botRooms.get(roomId);
    if (!botState) return;

    const game = botState.game;

    const engine = getEngine(botState);

    let hasMoved = false;
    let stage = "uci";
    let buffer = "";

    if (!botState.buffer) botState.buffer = "";
    if (!botState.stage) botState.stage = "uci";
    if (!botState.hasMoved) botState.hasMoved = false;

    engine.stdout.on("data", (data) => {
        buffer += data.toString();
        let lines = buffer.split("\n");
        buffer = lines.pop();

        for (let line of lines) {
            line = line.trim();

            if (line === "uciok" && stage === "uci") {
                stage = "ready";
                engine.stdin.write("isready\n");
            }

            if (line === "readyok" && stage === "ready") {
                stage = "go";

                engine.stdin.write(`position fen ${botState.lastFen || game.fen()}\n`);
                engine.stdin.write(`go depth ${Math.min(botState.level, 12)}\n`);
            }

            if (line.startsWith("bestmove") && !hasMoved) {
                hasMoved = true;

                const botMove = line.split(" ")[1];

                botState.thinking = false;
                game.move({
                    from: botMove.slice(0, 2),
                    to: botMove.slice(2, 4),
                    promotion: undefined
                });

                io.to(roomId).emit("opponent_move", botMove);

                engine.stdin.write("quit\n");

            }
        }
    });

    engine.stdin.write("uci\n");
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
            level: level || 10,
            game,
            engine: null,
            botColor: botIsWhite ? "w" : "b",
        });

        io.to(roomId).emit("game_start", {
            roomId,
            white: botIsWhite ? "bot" : socket.id,
            black: botIsWhite ? socket.id : "bot",
            whiteName: botIsWhite ? "Stockfish" : name,
            blackName: botIsWhite ? "Stockfish" : name,
            whiteAvatar: "",
            blackAvatar: avatar || "",
        });

        // WICHTIG → Bot startet sofort wenn Weiß
        if (botIsWhite) {
            startBotMove(roomId);
        }
    });

    // =============================
    // SPIELERZUG (PvP)
    // =============================
    socket.on("player_move", async ({ roomId, move, fen }) => {



        const botState = botRooms.get(roomId);
        if (!botState) return;

        const isBotGame = !!botState;

        // wenn Bot Schwarz ist → nach Player Move starten
        if (botState.botColor === "b" && !botState.thinking) {
            startBotMove(roomId);
        }
        const game = botState?.game;

        if (isBotGame && game) {
            const result = game.move({
                from: move.slice(0, 2),
                to: move.slice(2, 4),
                promotion: move.length > 4 ? move[4] : undefined
            });

            if (!result) {
                console.log("❌ INVALID PLAYER MOVE");
                return;
            }
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
    socket.on("resign_game", ({ roomId }) => {
        const roomSockets = Array.from(io.sockets.adapter.rooms.get(roomId) || []);
        const loserId = socket.id;
        const winnerId = roomSockets.find(id => id !== loserId && io.sockets.sockets.has(id));

        if (!winnerId) return;

        io.to(loserId).emit("game_over", {
            type: "resign",
            result: "lost",
            message: "Du hast aufgegeben. Dein Gegner gewinnt!",
        });

        io.to(winnerId).emit("game_over", {
            type: "resign",
            result: "won",
            message: "Dein Gegner hat aufgegeben. Du gewinnst!",
        });
        botRooms.delete(roomId);
    });

    // =============================
    // REMIS
    // =============================
    socket.on("offer_draw", ({ roomId }) => {
        const roomSockets = Array.from(io.sockets.adapter.rooms.get(roomId) || []);
        const opponentId = roomSockets.find(id => id !== socket.id && io.sockets.sockets.has(id));
        if (opponentId) io.to(opponentId).emit("draw_offer");
    });

    socket.on("answer_draw", ({ roomId, accept }) => {
        const roomSockets = Array.from(io.sockets.adapter.rooms.get(roomId) || []);
        const opponentId = roomSockets.find(id => id !== socket.id && io.sockets.sockets.has(id));

        if (accept) {
            if (opponentId) io.to(opponentId).emit("game_over", { type: "draw", message: "Remis vereinbart!" });
            io.to(socket.id).emit("game_over", { type: "draw", message: "Remis vereinbart!" });
        } else {
            if (opponentId) io.to(opponentId).emit("draw_declined");
        }
    });

    // =============================
    // DISCONNECT
    // =============================
    socket.on("disconnect", () => {
        console.log("Spieler getrennt:", socket.id);

        if (waitingPlayer?.id === socket.id) {
            waitingPlayer = null;
            return;
        }

        const rooms = Array.from(socket.rooms).filter(r => r !== socket.id);
        rooms.forEach(roomId => {
            const roomSockets = Array.from(io.sockets.adapter.rooms.get(roomId) || []);
            const opponentId = roomSockets.find(id => id !== socket.id && io.sockets.sockets.has(id));

            if (opponentId) {
                io.to(opponentId).emit("game_over", {
                    type: "resign",
                    result: "won",
                    message: "Dein Gegner hat die App verlassen. Du gewinnst automatisch!",
                });
            }

        });
    });


});

// =============================
// SERVER START
// =============================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Server läuft auf Port ${PORT}`));