// Compact opening book: main lines of the most common openings.
// Used for two things in the game review:
//   1. naming the opening that was played
//   2. marking moves that follow known theory as "book" moves
//
// Each entry is [name, moves in SAN]. Every prefix of a line counts as book.

const LINES = [
    // ───────────── 1.e4 e5 ─────────────
    ["King's Pawn Opening", "e4"],
    ["Open Game", "e4 e5"],
    ["King's Knight Opening", "e4 e5 Nf3"],
    ["King's Knight Opening", "e4 e5 Nf3 Nc6"],
    ["Ruy López", "e4 e5 Nf3 Nc6 Bb5"],
    ["Ruy López, Morphy Defense", "e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7 Re1 b5 Bb3 d6 c3 O-O h3"],
    ["Ruy López, Exchange Variation", "e4 e5 Nf3 Nc6 Bb5 a6 Bxc6 dxc6 O-O"],
    ["Ruy López, Berlin Defense", "e4 e5 Nf3 Nc6 Bb5 Nf6 O-O Nxe4 d4 Nd6 Bxc6 dxc6 dxe5 Nf5 Qxd8+ Kxd8"],
    ["Ruy López, Open Variation", "e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Nxe4 d4 b5 Bb3 d5 dxe5 Be6"],
    ["Ruy López, Marshall Attack", "e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7 Re1 b5 Bb3 O-O c3 d5"],
    ["Ruy López, Classical Defense", "e4 e5 Nf3 Nc6 Bb5 Bc5"],
    ["Ruy López, Steinitz Defense", "e4 e5 Nf3 Nc6 Bb5 d6"],
    ["Italian Game", "e4 e5 Nf3 Nc6 Bc4"],
    ["Italian Game, Giuoco Piano", "e4 e5 Nf3 Nc6 Bc4 Bc5 c3 Nf6 d3 d6 O-O O-O"],
    ["Italian Game, Giuoco Piano", "e4 e5 Nf3 Nc6 Bc4 Bc5 c3 Nf6 d4 exd4 cxd4 Bb4+ Bd2 Bxd2+ Nbxd2 d5"],
    ["Italian Game, Giuoco Pianissimo", "e4 e5 Nf3 Nc6 Bc4 Bc5 d3 Nf6 c3 d6"],
    ["Italian Game, Evans Gambit", "e4 e5 Nf3 Nc6 Bc4 Bc5 b4 Bxb4 c3 Ba5 d4"],
    ["Two Knights Defense", "e4 e5 Nf3 Nc6 Bc4 Nf6"],
    ["Two Knights Defense, Fried Liver Attack", "e4 e5 Nf3 Nc6 Bc4 Nf6 Ng5 d5 exd5 Nxd5 Nxf7"],
    ["Two Knights Defense, Main Line", "e4 e5 Nf3 Nc6 Bc4 Nf6 Ng5 d5 exd5 Na5 Bb5+ c6 dxc6 bxc6"],
    ["Two Knights Defense, Modern Bishop's Opening", "e4 e5 Nf3 Nc6 Bc4 Nf6 d3 Be7 O-O O-O"],
    ["Scotch Game", "e4 e5 Nf3 Nc6 d4 exd4 Nxd4"],
    ["Scotch Game, Classical Variation", "e4 e5 Nf3 Nc6 d4 exd4 Nxd4 Bc5 Be3 Qf6 c3 Nge7"],
    ["Scotch Game, Schmidt Variation", "e4 e5 Nf3 Nc6 d4 exd4 Nxd4 Nf6 Nxc6 bxc6 e5 Qe7 Qe2 Nd5 c4"],
    ["Scotch Gambit", "e4 e5 Nf3 Nc6 d4 exd4 Bc4"],
    ["Four Knights Game", "e4 e5 Nf3 Nc6 Nc3 Nf6"],
    ["Four Knights Game, Spanish Variation", "e4 e5 Nf3 Nc6 Nc3 Nf6 Bb5 Bb4 O-O O-O d3 d6"],
    ["Four Knights Game, Scotch Variation", "e4 e5 Nf3 Nc6 Nc3 Nf6 d4 exd4 Nxd4 Bb4 Nxc6 bxc6 Bd3 d5"],
    ["Three Knights Opening", "e4 e5 Nf3 Nc6 Nc3"],
    ["Ponziani Opening", "e4 e5 Nf3 Nc6 c3 Nf6 d4 Nxe4 d5"],
    ["Petrov's Defense", "e4 e5 Nf3 Nf6"],
    ["Petrov's Defense, Classical Attack", "e4 e5 Nf3 Nf6 Nxe5 d6 Nf3 Nxe4 d4 d5 Bd3 Be7 O-O Nc6"],
    ["Petrov's Defense, Three Knights Game", "e4 e5 Nf3 Nf6 Nc3 Nc6"],
    ["Philidor Defense", "e4 e5 Nf3 d6 d4 exd4 Nxd4 Nf6 Nc3 Be7"],
    ["Philidor Defense, Hanham Variation", "e4 e5 Nf3 d6 d4 Nd7 Bc4 c6"],
    ["Damiano Defense", "e4 e5 Nf3 f6"],
    ["Elephant Gambit", "e4 e5 Nf3 d5"],
    ["Latvian Gambit", "e4 e5 Nf3 f5"],
    ["King's Gambit", "e4 e5 f4"],
    ["King's Gambit Accepted", "e4 e5 f4 exf4 Nf3 g5 h4 g4 Ne5"],
    ["King's Gambit Accepted, Bishop's Gambit", "e4 e5 f4 exf4 Bc4"],
    ["King's Gambit Declined, Classical Variation", "e4 e5 f4 Bc5 Nf3 d6"],
    ["King's Gambit, Falkbeer Countergambit", "e4 e5 f4 d5 exd5 e4"],
    ["Vienna Game", "e4 e5 Nc3"],
    ["Vienna Game, Falkbeer Variation", "e4 e5 Nc3 Nf6 f4 d5 fxe5 Nxe4"],
    ["Vienna Game, Max Lange Defense", "e4 e5 Nc3 Nc6 Bc4 Nf6 d3"],
    ["Bishop's Opening", "e4 e5 Bc4 Nf6 d3 c6 Nf3 d5 Bb3"],
    ["Center Game", "e4 e5 d4 exd4 Qxd4 Nc6 Qe3"],
    ["Danish Gambit", "e4 e5 d4 exd4 c3 dxc3 Bc4 cxb2 Bxb2"],

    // ───────────── Sicilian ─────────────
    ["Sicilian Defense", "e4 c5"],
    ["Sicilian Defense, Open", "e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3"],
    ["Sicilian Defense, Najdorf Variation", "e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6 Be3 e5 Nb3 Be6 f3"],
    ["Sicilian Defense, Najdorf Variation", "e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6 Bg5 e6 f4 Be7 Qf3 Qc7 O-O-O Nbd7"],
    ["Sicilian Defense, Najdorf Variation", "e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6 Be2 e5 Nb3 Be7 O-O O-O"],
    ["Sicilian Defense, Dragon Variation", "e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 g6 Be3 Bg7 f3 O-O Qd2 Nc6"],
    ["Sicilian Defense, Classical Variation", "e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 Nc6 Bg5 e6 Qd2"],
    ["Sicilian Defense, Scheveningen Variation", "e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 e6 Be2 Be7 O-O O-O"],
    ["Sicilian Defense, Sveshnikov Variation", "e4 c5 Nf3 Nc6 d4 cxd4 Nxd4 Nf6 Nc3 e5 Ndb5 d6 Bg5 a6 Na3 b5"],
    ["Sicilian Defense, Accelerated Dragon", "e4 c5 Nf3 Nc6 d4 cxd4 Nxd4 g6 Nc3 Bg7 Be3 Nf6 Bc4 O-O"],
    ["Sicilian Defense, Taimanov Variation", "e4 c5 Nf3 e6 d4 cxd4 Nxd4 Nc6 Nc3 Qc7 Be3 a6"],
    ["Sicilian Defense, Kan Variation", "e4 c5 Nf3 e6 d4 cxd4 Nxd4 a6 Bd3 Nf6 O-O"],
    ["Sicilian Defense, Four Knights Variation", "e4 c5 Nf3 e6 d4 cxd4 Nxd4 Nf6 Nc3 Nc6"],
    ["Sicilian Defense, Rossolimo Attack", "e4 c5 Nf3 Nc6 Bb5 g6 O-O Bg7 Re1"],
    ["Sicilian Defense, Moscow Variation", "e4 c5 Nf3 d6 Bb5+ Bd7 Bxd7+ Qxd7 O-O Nc6"],
    ["Sicilian Defense, Alapin Variation", "e4 c5 c3 Nf6 e5 Nd5 d4 cxd4 Nf3 Nc6 cxd4 d6"],
    ["Sicilian Defense, Alapin Variation", "e4 c5 c3 d5 exd5 Qxd5 d4 Nf6 Nf3 e6"],
    ["Sicilian Defense, Closed", "e4 c5 Nc3 Nc6 g3 g6 Bg2 Bg7 d3 d6"],
    ["Sicilian Defense, Grand Prix Attack", "e4 c5 Nc3 Nc6 f4 g6 Nf3 Bg7 Bc4 e6"],
    ["Sicilian Defense, Smith-Morra Gambit", "e4 c5 d4 cxd4 c3 dxc3 Nxc3 Nc6 Nf3 d6 Bc4 e6"],
    ["Sicilian Defense, Bowdler Attack", "e4 c5 Bc4"],
    ["Sicilian Defense, Wing Gambit", "e4 c5 b4"],

    // ───────────── French ─────────────
    ["French Defense", "e4 e6 d4 d5"],
    ["French Defense, Advance Variation", "e4 e6 d4 d5 e5 c5 c3 Nc6 Nf3 Qb6 a3"],
    ["French Defense, Exchange Variation", "e4 e6 d4 d5 exd5 exd5 Nf3 Nf6 Bd3 Bd6 O-O O-O"],
    ["French Defense, Winawer Variation", "e4 e6 d4 d5 Nc3 Bb4 e5 c5 a3 Bxc3+ bxc3 Ne7"],
    ["French Defense, Classical Variation", "e4 e6 d4 d5 Nc3 Nf6 Bg5 Be7 e5 Nfd7 Bxe7 Qxe7"],
    ["French Defense, Steinitz Variation", "e4 e6 d4 d5 Nc3 Nf6 e5 Nfd7 f4 c5 Nf3 Nc6 Be3"],
    ["French Defense, Rubinstein Variation", "e4 e6 d4 d5 Nc3 dxe4 Nxe4 Nd7 Nf3 Ngf6"],
    ["French Defense, Tarrasch Variation", "e4 e6 d4 d5 Nd2 Nf6 e5 Nfd7 Bd3 c5 c3 Nc6 Ne2"],
    ["French Defense, Tarrasch Variation", "e4 e6 d4 d5 Nd2 c5 exd5 exd5 Ngf3 Nc6"],
    ["French Defense, King's Indian Attack", "e4 e6 d3 d5 Nd2 Nf6 Ngf3 c5 g3 Nc6 Bg2 Be7 O-O O-O"],

    // ───────────── Caro-Kann ─────────────
    ["Caro-Kann Defense", "e4 c6 d4 d5"],
    ["Caro-Kann Defense, Classical Variation", "e4 c6 d4 d5 Nc3 dxe4 Nxe4 Bf5 Ng3 Bg6 h4 h6 Nf3 Nd7"],
    ["Caro-Kann Defense, Karpov Variation", "e4 c6 d4 d5 Nc3 dxe4 Nxe4 Nd7 Nf3 Ngf6"],
    ["Caro-Kann Defense, Advance Variation", "e4 c6 d4 d5 e5 Bf5 Nf3 e6 Be2 c5 Be3"],
    ["Caro-Kann Defense, Advance Variation, Botvinnik-Carls Defense", "e4 c6 d4 d5 e5 c5"],
    ["Caro-Kann Defense, Exchange Variation", "e4 c6 d4 d5 exd5 cxd5 Bd3 Nc6 c3 Nf6 Bf4"],
    ["Caro-Kann Defense, Panov Attack", "e4 c6 d4 d5 exd5 cxd5 c4 Nf6 Nc3 e6 Nf3 Be7"],
    ["Caro-Kann Defense, Two Knights Attack", "e4 c6 Nc3 d5 Nf3 Bg4 h3 Bxf3 Qxf3"],
    ["Caro-Kann Defense, Fantasy Variation", "e4 c6 d4 d5 f3"],

    // ───────────── Other replies to 1.e4 ─────────────
    ["Scandinavian Defense", "e4 d5 exd5 Qxd5 Nc3 Qa5 d4 Nf6 Nf3 c6 Bc4 Bf5"],
    ["Scandinavian Defense, Gubinsky-Melts Defense", "e4 d5 exd5 Qxd5 Nc3 Qd6 d4 Nf6 Nf3 a6"],
    ["Scandinavian Defense, Modern Variation", "e4 d5 exd5 Nf6 d4 Nxd5 Nf3 g6"],
    ["Pirc Defense", "e4 d6 d4 Nf6 Nc3 g6"],
    ["Pirc Defense, Classical Variation", "e4 d6 d4 Nf6 Nc3 g6 Nf3 Bg7 Be2 O-O O-O"],
    ["Pirc Defense, Austrian Attack", "e4 d6 d4 Nf6 Nc3 g6 f4 Bg7 Nf3 O-O"],
    ["Modern Defense", "e4 g6 d4 Bg7 Nc3 d6"],
    ["Alekhine's Defense", "e4 Nf6 e5 Nd5 d4 d6 Nf3 Bg4 Be2 e6"],
    ["Alekhine's Defense, Four Pawns Attack", "e4 Nf6 e5 Nd5 d4 d6 c4 Nb6 f4"],
    ["Nimzowitsch Defense", "e4 Nc6 d4 d5"],
    ["Owen's Defense", "e4 b6 d4 Bb7"],

    // ───────────── 1.d4 d5 ─────────────
    ["Queen's Pawn Opening", "d4"],
    ["Closed Game", "d4 d5"],
    ["Queen's Gambit", "d4 d5 c4"],
    ["Queen's Gambit Declined", "d4 d5 c4 e6 Nc3 Nf6 Bg5 Be7 e3 O-O Nf3 h6 Bh4 b6"],
    ["Queen's Gambit Declined, Orthodox Defense", "d4 d5 c4 e6 Nc3 Nf6 Bg5 Be7 e3 O-O Nf3 Nbd7 Rc1 c6"],
    ["Queen's Gambit Declined, Exchange Variation", "d4 d5 c4 e6 Nc3 Nf6 cxd5 exd5 Bg5 c6 e3 Be7 Bd3"],
    ["Queen's Gambit Declined, Three Knights Variation", "d4 d5 c4 e6 Nc3 Nf6 Nf3 Be7 Bf4 O-O e3"],
    ["Queen's Gambit Declined, Tarrasch Defense", "d4 d5 c4 e6 Nc3 c5 cxd5 exd5 Nf3 Nc6 g3 Nf6 Bg2 Be7"],
    ["Queen's Gambit Declined, Semi-Tarrasch Defense", "d4 d5 c4 e6 Nc3 Nf6 Nf3 c5 cxd5 Nxd5"],
    ["Queen's Gambit Accepted", "d4 d5 c4 dxc4 Nf3 Nf6 e3 e6 Bxc4 c5 O-O a6"],
    ["Queen's Gambit Accepted, Central Variation", "d4 d5 c4 dxc4 e4 e5 Nf3 exd4 Bxc4"],
    ["Slav Defense", "d4 d5 c4 c6 Nf3 Nf6 Nc3 dxc4 a4 Bf5 e3 e6 Bxc4 Bb4"],
    ["Slav Defense, Exchange Variation", "d4 d5 c4 c6 cxd5 cxd5 Nc3 Nf6 Nf3 Nc6 Bf4"],
    ["Semi-Slav Defense", "d4 d5 c4 c6 Nf3 Nf6 Nc3 e6 e3 Nbd7 Bd3 dxc4 Bxc4 b5"],
    ["Semi-Slav Defense, Anti-Moscow Gambit", "d4 d5 c4 c6 Nf3 Nf6 Nc3 e6 Bg5 h6 Bh4 dxc4 e4 g5 Bg3 b5"],
    ["Queen's Gambit, Albin Countergambit", "d4 d5 c4 e5 dxe5 d4 Nf3 Nc6"],
    ["Queen's Gambit, Chigorin Defense", "d4 d5 c4 Nc6"],
    ["London System", "d4 d5 Bf4 Nf6 e3 c5 c3 Nc6 Nd2 e6 Ngf3 Bd6 Bg3 O-O"],
    ["London System", "d4 d5 Nf3 Nf6 Bf4 c5 e3 Nc6 c3 e6 Nbd2 Bd6 Bg3"],
    ["London System", "d4 Nf6 Bf4 d5 e3 e6 Nf3 c5 c3 Nc6 Nbd2 Bd6 Bg3"],
    ["London System", "d4 Nf6 Nf3 g6 Bf4 Bg7 e3 O-O Be2 d6 h3"],
    ["Colle System", "d4 d5 Nf3 Nf6 e3 e6 Bd3 c5 c3 Nc6 Nbd2 Bd6 O-O O-O"],
    ["Jobava London System", "d4 d5 Nc3 Nf6 Bf4"],
    ["Veresov Opening", "d4 d5 Nc3 Nf6 Bg5"],
    ["Blackmar-Diemer Gambit", "d4 d5 e4 dxe4 Nc3 Nf6 f3"],
    ["Stonewall Attack", "d4 d5 e3 Nf6 Bd3 c5 c3 Nc6 f4"],
    ["Torre Attack", "d4 Nf6 Nf3 e6 Bg5 c5 e3"],
    ["Trompowsky Attack", "d4 Nf6 Bg5 Ne4 Bf4 c5 f3 Qa5+ c3 Nf6"],

    // ───────────── Indian defenses ─────────────
    ["Indian Defense", "d4 Nf6"],
    ["Indian Defense", "d4 Nf6 c4"],
    ["King's Indian Defense", "d4 Nf6 c4 g6 Nc3 Bg7 e4 d6"],
    ["King's Indian Defense, Classical Variation", "d4 Nf6 c4 g6 Nc3 Bg7 e4 d6 Nf3 O-O Be2 e5 O-O Nc6 d5 Ne7"],
    ["King's Indian Defense, Sämisch Variation", "d4 Nf6 c4 g6 Nc3 Bg7 e4 d6 f3 O-O Be3 e5"],
    ["King's Indian Defense, Four Pawns Attack", "d4 Nf6 c4 g6 Nc3 Bg7 e4 d6 f4 O-O Nf3 c5"],
    ["King's Indian Defense, Fianchetto Variation", "d4 Nf6 c4 g6 Nf3 Bg7 g3 O-O Bg2 d6 O-O Nbd7"],
    ["Grünfeld Defense", "d4 Nf6 c4 g6 Nc3 d5"],
    ["Grünfeld Defense, Exchange Variation", "d4 Nf6 c4 g6 Nc3 d5 cxd5 Nxd5 e4 Nxc3 bxc3 Bg7 Nf3 c5"],
    ["Grünfeld Defense, Russian Variation", "d4 Nf6 c4 g6 Nc3 d5 Nf3 Bg7 Qb3 dxc4 Qxc4 O-O e4"],
    ["Nimzo-Indian Defense", "d4 Nf6 c4 e6 Nc3 Bb4"],
    ["Nimzo-Indian Defense, Rubinstein Variation", "d4 Nf6 c4 e6 Nc3 Bb4 e3 O-O Bd3 d5 Nf3 c5 O-O"],
    ["Nimzo-Indian Defense, Classical Variation", "d4 Nf6 c4 e6 Nc3 Bb4 Qc2 O-O a3 Bxc3+ Qxc3 b6"],
    ["Nimzo-Indian Defense, Sämisch Variation", "d4 Nf6 c4 e6 Nc3 Bb4 a3 Bxc3+ bxc3 c5"],
    ["Queen's Indian Defense", "d4 Nf6 c4 e6 Nf3 b6 g3 Bb7 Bg2 Be7 O-O O-O Nc3 Ne4"],
    ["Queen's Indian Defense, Petrosian Variation", "d4 Nf6 c4 e6 Nf3 b6 a3 Bb7 Nc3 d5"],
    ["Bogo-Indian Defense", "d4 Nf6 c4 e6 Nf3 Bb4+ Bd2 Qe7 g3"],
    ["Catalan Opening", "d4 Nf6 c4 e6 g3 d5 Bg2 Be7 Nf3 O-O O-O dxc4 Qc2 a6"],
    ["Catalan Opening, Open Defense", "d4 Nf6 c4 e6 g3 d5 Bg2 dxc4 Nf3"],
    ["Benoni Defense", "d4 Nf6 c4 c5 d5 e6 Nc3 exd5 cxd5 d6 e4 g6 Nf3 Bg7"],
    ["Benko Gambit", "d4 Nf6 c4 c5 d5 b5 cxb5 a6 bxa6 Bxa6"],
    ["Budapest Gambit", "d4 Nf6 c4 e5 dxe5 Ng4 Bf4 Nc6 Nf3 Bb4+"],
    ["Old Indian Defense", "d4 Nf6 c4 d6 Nc3 e5 Nf3 Nbd7 e4 Be7"],
    ["Dutch Defense", "d4 f5"],
    ["Dutch Defense, Leningrad Variation", "d4 f5 g3 Nf6 Bg2 g6 Nf3 Bg7 O-O O-O c4 d6"],
    ["Dutch Defense, Stonewall Variation", "d4 f5 c4 Nf6 g3 e6 Bg2 d5 Nf3 c6 O-O Bd6"],
    ["Dutch Defense, Classical Variation", "d4 f5 c4 Nf6 g3 e6 Bg2 Be7 Nf3 O-O O-O d6"],
    ["Englund Gambit", "d4 e5 dxe5 Nc6 Nf3 Qe7"],
    ["Modern Defense", "d4 g6 c4 Bg7 Nc3 d6 e4"],

    // ───────────── Flank openings ─────────────
    ["English Opening", "c4"],
    ["English Opening, Reversed Sicilian", "c4 e5 Nc3 Nf6 Nf3 Nc6 g3 d5 cxd5 Nxd5 Bg2 Nb6"],
    ["English Opening, Symmetrical Variation", "c4 c5 Nc3 Nc6 g3 g6 Bg2 Bg7 Nf3 Nf6 O-O O-O"],
    ["English Opening, Anglo-Indian Defense", "c4 Nf6 Nc3 e6 Nf3 d5 d4"],
    ["English Opening, King's English", "c4 e5 Nc3 Nc6 g3 g6 Bg2 Bg7"],
    ["English Opening, Agincourt Defense", "c4 e6 Nf3 d5 g3 Nf6 Bg2 Be7 O-O O-O"],
    ["Réti Opening", "Nf3"],
    ["Réti Opening", "Nf3 d5 c4 e6 g3 Nf6 Bg2 Be7 O-O O-O"],
    ["Réti Opening", "Nf3 d5 c4 d4"],
    ["Zukertort Opening", "Nf3 Nf6"],
    ["King's Indian Attack", "Nf3 d5 g3 Nf6 Bg2 e6 O-O Be7 d3 O-O Nbd2 c5 e4"],
    ["King's Indian Attack", "Nf3 Nf6 g3 g6 Bg2 Bg7 O-O O-O d3 d6"],
    ["Bird's Opening", "f4 d5 Nf3 Nf6 e3 g6"],
    ["Bird's Opening, From's Gambit", "f4 e5 fxe5 d6 exd6 Bxd6"],
    ["Nimzowitsch-Larsen Attack", "b3 e5 Bb2 Nc6 e3 Nf6"],
    ["Nimzowitsch-Larsen Attack", "b3 d5 Bb2"],
    ["King's Fianchetto Opening", "g3 d5 Bg2 Nf6 Nf3"],
    ["Polish Opening", "b4 e5 Bb2"],
    ["Grob Opening", "g4"],
    ["Van't Kruijs Opening", "e3"],
    ["Mieses Opening", "d3"],
    ["Van Geet Opening", "Nc3"],
];

// prefix ("e4 e5 Nf3") -> opening name shown for that position.
//
// A prefix that is exactly one of the lines above gets that line's name.
// Otherwise it gets the name shared by every line running through it
// ("Sicilian Defense, Najdorf Variation"), or their common family
// ("Sicilian Defense"), or - if even that differs - the name of the
// position one move earlier.
const PREFIX_NAMES = new Map();

{
    const exact = new Map();
    const through = new Map();

    for (const [name, moves] of LINES) {
        const sans = moves.split(" ");
        exact.set(moves, name);

        for (let length = 1; length <= sans.length; length++) {
            const key = sans.slice(0, length).join(" ");
            if (!through.has(key)) through.set(key, new Set());
            through.get(key).add(name);
        }
    }

    const family = (name) => name.split(",")[0];

    // Shorter prefixes first, so "the position one move earlier" is known.
    const keys = [...through.keys()].sort(
        (x, y) => x.split(" ").length - y.split(" ").length
    );

    for (const key of keys) {
        if (exact.has(key)) {
            PREFIX_NAMES.set(key, exact.get(key));
            continue;
        }

        const names = [...through.get(key)];
        const families = new Set(names.map(family));

        if (names.length === 1) {
            PREFIX_NAMES.set(key, names[0]);
        } else if (families.size === 1) {
            PREFIX_NAMES.set(key, [...families][0]);
        } else {
            const parent = key.split(" ").slice(0, -1).join(" ");
            PREFIX_NAMES.set(key, PREFIX_NAMES.get(parent) ?? null);
        }
    }
}

/**
 * @param {string[]} sanHistory moves of the game in SAN
 * @returns {{ name: string | null, plies: number }} name of the opening and
 *          how many half-moves from the start are still book moves
 */
export function matchOpening(sanHistory) {
    let name = null;
    let plies = 0;

    for (let length = 1; length <= sanHistory.length; length++) {
        const key = sanHistory.slice(0, length).join(" ");

        if (!PREFIX_NAMES.has(key)) break;

        name = PREFIX_NAMES.get(key) ?? name;
        plies = length;
    }

    return { name, plies };
}

// Exposed for the tests, which replay every line to make sure it is legal.
export const OPENING_LINES = LINES;
