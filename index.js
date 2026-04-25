import http from "http";
import express from "express";
import path from "path";
import multer from "multer";
import { Server } from "socket.io";
import { fileURLToPath } from "url";
import { spawn, execSync } from "child_process";

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

let waitingPlayer = null;

io.on("connection", (socket) => {
  console.log("Spieler verbunden:", socket.id);

  // =============================
  // BOT-MATCH 
  // =============================
  socket.on("find_bot_match", (data) => {
    const { name, avatar, level, startFEN } = data;

    const roomId = `bot_${socket.id}`;
    socket.join(roomId);

    botRooms.set(roomId, {
      level: level || 10,
      fen: startFEN || "startpos",
    });

    io.to(roomId).emit("game_start", {
      roomId,
      white: socket.id,
      black: "bot",
      whiteName: name,
      blackName: "Stockfish",
      whiteAvatar: avatar || "",
      blackAvatar: "",
    });
  });

  // =============================
  // SPIELERZUG (PvP)
  // =============================
  socket.on("player_move", async ({ roomId, move, fen }) => {

    console.log("📦 BOT ROOM STATE:", socket.botRoom);
    console.log("🟢 PLAYER MOVE EVENT", { roomId, move, fen });


    const botState = botRooms.get(roomId);
    const isBotGame = !!botState;


    if (!isBotGame) {
      socket.to(roomId).emit("opponent_move", move);
    }

    console.log("📦 BOT STATE:", botState);
    console.log("🤖 isBotGame:", isBotGame);

    if (!isBotGame) return;

    console.log("🚀 STARTING STOCKFISH");


    const engine = spawn("/usr/games/stockfish");

    let buffer = "";
    let hasStartedSearch = false;

    engine.stdout.on("data", (data) => {
      const text = data.toString();
      console.log("SF:", text);

      if (text.includes("uciok")) {
        engine.stdin.write("isready\n");
      }

      if (text.includes("readyok") && !hasStartedSearch) {
        hasStartedSearch = true;

        engine.stdin.write(`position fen ${fen}\n`);
        engine.stdin.write(`go depth ${Math.min(botState.level, 12)}\n`);
      }

      const match = text.match(/bestmove\s(\S+)/);
      if (match) {
        const botMove = match[1];

        setTimeout(() => {
          io.to(roomId).emit("opponent_move", botMove);
        }, 500);

        engine.stdin.write("quit\n");
        engine.kill();
      }
    });
    engine.stderr.on("data", (data) => {
      console.log("❌ STOCKFISH STDERR:", data.toString());
    });

    engine.on("error", (err) => {
      console.log("💥 SPAWN ERROR:", err);
    });

    engine.on("exit", (code) => {
      console.log("🛑 STOCKFISH EXIT:", code);
    });

    // START
    engine.stdin.write("uci\n");
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