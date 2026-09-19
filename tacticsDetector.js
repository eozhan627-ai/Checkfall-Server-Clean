const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"];
const PIECE_VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

function squareToCoord(square) {
  return { file: FILES.indexOf(square[0]), rank: 8 - parseInt(square[1], 10) };
}
function coordToSquare(file, rank) {
  if (file < 0 || file > 7 || rank < 0 || rank > 7) return null;
  return `${FILES[file]}${8 - rank}`;
}
function pieceAt(board, file, rank) {
  if (file < 0 || file > 7 || rank < 0 || rank > 7) return null;
  return board[rank][file];
}

const ROOK_DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const BISHOP_DIRS = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const QUEEN_DIRS = [...ROOK_DIRS, ...BISHOP_DIRS];
const KNIGHT_OFFSETS = [[1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1]];

// Felder, die eine Figur an (file,rank) geometrisch bestreicht - unabhängig
// vom Zugrecht und ohne Selbstschach-Prüfung (bewusst, siehe oben).
function attackSquares(board, file, rank) {
  const piece = pieceAt(board, file, rank);
  if (!piece) return [];

  if (piece.type === "n") {
    return KNIGHT_OFFSETS.map(([df, dr]) => coordToSquare(file + df, rank + dr)).filter(Boolean);
  }
  if (piece.type === "k") {
    const targets = [];
    for (let df = -1; df <= 1; df++)
      for (let dr = -1; dr <= 1; dr++) {
        if (df === 0 && dr === 0) continue;
        const sq = coordToSquare(file + df, rank + dr);
        if (sq) targets.push(sq);
      }
    return targets;
  }
  if (piece.type === "p") {
    const dir = piece.color === "w" ? -1 : 1; // im board()-Array zeigt Weiß Richtung Reihe 8 (Index 0)
    return [coordToSquare(file - 1, rank + dir), coordToSquare(file + 1, rank + dir)].filter(Boolean);
  }

  const dirs = piece.type === "r" ? ROOK_DIRS : piece.type === "b" ? BISHOP_DIRS : QUEEN_DIRS;
  const targets = [];
  for (const [df, dr] of dirs) {
    let f = file + df, r = rank + dr;
    while (f >= 0 && f <= 7 && r >= 0 && r <= 7) {
      targets.push(coordToSquare(f, r));
      if (pieceAt(board, f, r)) break; // blockiert - Sichtlinie endet hier
      f += df; r += dr;
    }
  }
  return targets;
}

// Alle Figuren entlang einer Richtung, in Reihenfolge, OHNE bei der ersten
// zu stoppen (wird für Fesselung/Spieß gebraucht: erste + zweite Figur).
function rayPieces(board, file, rank, df, dr) {
  const found = [];
  let f = file + df, r = rank + dr;
  while (f >= 0 && f <= 7 && r >= 0 && r <= 7) {
    const p = pieceAt(board, f, r);
    if (p) found.push({ square: coordToSquare(f, r), piece: p });
    f += df; r += dr;
  }
  return found;
}

function detectFork(board, moverSquare) {
  const { file, rank } = squareToCoord(moverSquare);
  const piece = pieceAt(board, file, rank);
  if (!piece) return null;

  const targets = attackSquares(board, file, rank)
    .map((sq) => {
      const c = squareToCoord(sq);
      const p = pieceAt(board, c.file, c.rank);
      return p && p.color !== piece.color ? { square: sq, piece: p } : null;
    })
    .filter(Boolean)
    // Zwei angegriffene Bauern zaehlen nicht als "Gabel" im ueblichen Sinn.
    .filter((t) => t.piece.type === "k" || PIECE_VALUES[t.piece.type] >= 3);

  if (targets.length >= 2) {
    return { type: "fork", attacker: moverSquare, targets: targets.map((t) => t.square) };
  }
  return null;
}

function detectPinsAndSkewers(board, moverSquare) {
  const { file, rank } = squareToCoord(moverSquare);
  const piece = pieceAt(board, file, rank);
  if (!piece || !["b", "r", "q"].includes(piece.type)) return [];

  const dirs = piece.type === "r" ? ROOK_DIRS : piece.type === "b" ? BISHOP_DIRS : QUEEN_DIRS;
  const results = [];

  for (const [df, dr] of dirs) {
    const ray = rayPieces(board, file, rank, df, dr);
    if (ray.length < 2) continue;
    if (ray[0].piece.color === piece.color) continue; // eigene Figur blockiert direkt
    if (ray[1].piece.color === piece.color) continue; // dahinter eigene Figur -> kein Pin/Spieß

    const [front, back] = ray;
    if (back.piece.type === "k" || PIECE_VALUES[back.piece.type] > PIECE_VALUES[front.piece.type]) {
      results.push({ type: "pin", attacker: moverSquare, pinned: front.square, behind: back.square });
    } else if (PIECE_VALUES[front.piece.type] > PIECE_VALUES[back.piece.type]) {
      results.push({ type: "skewer", attacker: moverSquare, front: front.square, behind: back.square });
    }
  }
  return results;
}

function parseUciMove(uci) {
  if (!uci || uci.length < 4 || uci === "(none)") return null;
  return { from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.length > 4 ? uci[4] : undefined };
}

// Ermittelt, welches taktische Muster der tatsächlich beste Zug (bestMoveUci)
// ausgenutzt hätte. chessCtor ist der Chess-Konstruktor aus chess.js (wird
// übergeben statt importiert, um diese Datei ohne zusätzliche Abhängigkeit
// eigenständig testbar zu halten).
export function detectTacticalMotif(ChessCtor, fenBeforeMove, bestMoveUci) {
  const parsed = parseUciMove(bestMoveUci);
  if (!parsed) return null;

  let chess;
  try {
    chess = new ChessCtor(fenBeforeMove);
    const move = chess.move(parsed);
    if (!move) return null;
  } catch {
    return null;
  }

  const board = chess.board();
  const moverSquare = parsed.to;

  const fork = detectFork(board, moverSquare);
  if (fork) return fork;

  const pinsAndSkewers = detectPinsAndSkewers(board, moverSquare);
  if (pinsAndSkewers.length > 0) return pinsAndSkewers[0];

  return null;
}
