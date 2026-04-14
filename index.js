import http from "http";
import express from "express";
import path from "path";
import multer from "multer";
import { Server } from "socket.io";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import { exec } from "child_process";

exec("which stockfish", (err, stdout, stderr) => {
  console.log("WHICH STOCKFISH:", stdout);
  console.log("ERROR:", err);
  console.log("STDERR:", stderr);
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

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

    // Start der Partie
    io.to(roomId).emit("game_start", {
      roomId,
      white: socket.id,
      black: "bot",
      whiteName: name,
      blackName: "Stockfish",
      whiteAvatar: avatar || "",
      blackAvatar: "",
    });

    // FEN + Level speichern
    socket.botRoom = {
      roomId,
      level: level || 10,
      fen: startFEN || "startpos"
    };
  });

  // =============================
  // SPIELERZUG (PvP)
  // =============================
  socket.on("player_move", async ({ roomId, move, fen }) => {
    console.log("🟢 PLAYER MOVE EVENT", { roomId, move, fen });

    socket.to(roomId).emit("opponent_move", move);

    const isBotGame = socket.botRoom?.roomId === roomId;
    console.log("🤖 isBotGame:", isBotGame, socket.botRoom);

    if (!isBotGame) return;

    const engine = spawn("stockfish");

    console.log("⚙️ Stockfish spawned");

    let ready = false;

    engine.stdout.on("data", (data) => {
      const text = data.toString();
      console.log("📥 STOCKFISH OUT:", text);

      if (text.includes("uciok")) {
        console.log("✅ UCI OK");
        engine.stdin.write("isready\n");
      }

      if (text.includes("readyok") && !ready) {
        console.log("🟡 ENGINE READY");

        ready = true;

        console.log("📌 sending position:", fen);
        engine.stdin.write(`position fen ${fen}\n`);

        console.log("🚀 sending go depth:", socket.botRoom.level);
        engine.stdin.write(`go depth ${socket.botRoom.level}\n`);
      }

      if (text.includes("bestmove")) {
        const botMove = text.split("bestmove ")[1].split(" ")[0];

        console.log("♟️ BOT MOVE:", botMove);

        io.to(roomId).emit("opponent_move", botMove);

        engine.kill();
        console.log("❌ ENGINE KILLED");
      }
    });

    engine.stderr.on("data", (data) => {
      console.log("🔴 STOCKFISH ERROR:", data.toString());
    });

    engine.on("error", (err) => {
      console.log("💥 SPAWN ERROR:", err);
    });

    console.log("📤 sending uci");
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