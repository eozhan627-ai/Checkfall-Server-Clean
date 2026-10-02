import { supabaseAdmin } from "./supabaseAdmin.js";

// =============================
// KONSTANTEN
// =============================

const MAX_MEMBERS = 50;
const MAX_CHAT_MESSAGES_PER_10S = 8;
const CHAT_MESSAGE_MAX_LEN = 300;

const RANK = {
    LEADER: "leader",
    ADMIN: "admin",
    MEMBER: "member",
};

// =============================
// HELPER
// =============================

function isNonEmptyString(value, maxLen = 200) {
    return typeof value === "string" && value.trim().length > 0 && value.length <= maxLen;
}

function clanRoom(clanId) {
    return `clan:${clanId}`;
}

// =============================
// LEAGUES
// =============================
// A clan's rating is the average rating of its ten strongest members. The
// league follows from that number.

export const LEAGUES = [
    { name: "Bronze", min: 0 },
    { name: "Silver", min: 1000 },
    { name: "Gold", min: 1200 },
    { name: "Platinum", min: 1400 },
    { name: "Diamond", min: 1600 },
    { name: "Master", min: 1800 },
];

export function clanRatingOf(ratings) {
    if (!ratings.length) return 1000;

    const top = [...ratings].sort((a, b) => b - a).slice(0, 10);
    return Math.round(top.reduce((a, b) => a + b, 0) / top.length);
}

export function leagueInfo(clanRating) {
    let index = 0;
    for (let i = 0; i < LEAGUES.length; i++) {
        if (clanRating >= LEAGUES[i].min) index = i;
    }

    const current = LEAGUES[index];
    const next = LEAGUES[index + 1] ?? null;

    return {
        league: current.name,
        nextLeague: next ? next.name : null,
        nextAt: next ? next.min : null,
        // 0-1: how far the clan is on the way to the next league
        progress: next
            ? Math.max(0, Math.min(1, (clanRating - current.min) / (next.min - current.min)))
            : 1,
    };
}

function computeLeague(clanRating) {
    return leagueInfo(clanRating).league;
}

const JOIN_TYPES = ["open", "request", "closed"];

const BADGES = ["knight", "rook", "bishop", "queen", "king", "pawn", "crown", "shield", "sword", "star", "flame", "bolt"];
const BADGE_COLORS = ["#5B8DB8", "#D4AF37", "#6FBF73", "#D9534F", "#9B7FD1", "#E8913A", "#3FB6C8", "#C0C5CE"];

// Postgres/PostgREST codes for "this column or table does not exist" - the
// database script for the clan upgrade has not been run yet.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isMissingSchema(error) {
    return ["42703", "42P01", "PGRST204", "PGRST205", "PGRST200"].includes(error?.code);
}

function sanitizeSearch(text) {
    return String(text).replace(/[%,()*\\]/g, " ").trim().slice(0, 40);
}

async function getUsername(userId) {
    const { data } = await supabaseAdmin
        .from("profiles")
        .select("username")
        .eq("id", userId)
        .maybeSingle();

    return data?.username || "Unknown";
}

async function getMembership(clanId, userId) {
    const { data } = await supabaseAdmin
        .from("clan_members")
        .select("*")
        .eq("clan_id", clanId)
        .eq("user_id", userId)
        .maybeSingle();

    return data || null;
}

async function getAnyMembership(userId) {
    const { data } = await supabaseAdmin
        .from("clan_members")
        .select("*")
        .eq("user_id", userId)
        .maybeSingle();

    return data || null;
}

async function getMemberCount(clanId) {
    const { count } = await supabaseAdmin
        .from("clan_members")
        .select("*", { count: "exact", head: true })
        .eq("clan_id", clanId);

    return count || 0;
}

async function recomputeLeague(clanId) {
    const { data } = await supabaseAdmin
        .from("clan_members")
        .select("profiles(rating)")
        .eq("clan_id", clanId);

    const ratings = (data || []).map((row) => row.profiles?.rating ?? 1000);
    const league = computeLeague(clanRatingOf(ratings));

    await supabaseAdmin.from("clans").update({ league }).eq("id", clanId);

    return league;
}

// Member count and clan rating for a list of clans in one query.
async function loadAggregates(clanIds) {
    const result = new Map();
    if (clanIds.length === 0) return result;

    const { data } = await supabaseAdmin
        .from("clan_members")
        .select("clan_id, profiles(rating)")
        .in("clan_id", clanIds);

    const ratingsByClan = new Map();
    for (const row of data || []) {
        if (!ratingsByClan.has(row.clan_id)) ratingsByClan.set(row.clan_id, []);
        ratingsByClan.get(row.clan_id).push(row.profiles?.rating ?? 1000);
    }

    for (const id of clanIds) {
        const ratings = ratingsByClan.get(id) || [];
        result.set(id, { member_count: ratings.length, clan_rating: clanRatingOf(ratings) });
    }

    return result;
}

// What the app shows for a clan in lists and in its header.
function decorateClan(clan, aggregate) {
    const clanRating = aggregate?.clan_rating ?? 1000;
    const info = leagueInfo(clanRating);

    return {
        id: clan.id,
        name: clan.name,
        tag: clan.tag ?? null,
        description: clan.description ?? null,
        creator_id: clan.creator_id,
        created_at: clan.created_at,
        join_type: JOIN_TYPES.includes(clan.join_type) ? clan.join_type : "open",
        min_rating: Number.isFinite(clan.min_rating) ? clan.min_rating : 0,
        badge: BADGES.includes(clan.badge) ? clan.badge : "knight",
        badge_color: BADGE_COLORS.includes(clan.badge_color) ? clan.badge_color : BADGE_COLORS[0],
        member_count: aggregate?.member_count ?? 0,
        max_members: MAX_MEMBERS,
        clan_rating: clanRating,
        league: info.league,
        next_league: info.nextLeague,
        next_league_at: info.nextAt,
        league_progress: info.progress,
    };
}

async function loadClan(clanId) {
    const { data: clan } = await supabaseAdmin.from("clans").select("*").eq("id", clanId).maybeSingle();
    if (!clan) return null;

    const aggregates = await loadAggregates([clan.id]);
    return decorateClan(clan, aggregates.get(clan.id));
}

async function loadAllClans(search) {
    let query = supabaseAdmin.from("clans").select("*").order("created_at", { ascending: false }).limit(300);

    const term = search ? sanitizeSearch(search) : "";
    if (term.length >= 2) {
        query = query.or(`name.ilike.%${term}%,tag.ilike.%${term}%`);
    }

    const { data } = await query;
    const clans = data || [];
    const aggregates = await loadAggregates(clans.map((c) => c.id));

    return clans
        .map((clan) => decorateClan(clan, aggregates.get(clan.id)))
        .sort((a, b) => b.clan_rating - a.clan_rating || b.member_count - a.member_count);
}

async function getProfile(userId) {
    const { data } = await supabaseAdmin
        .from("profiles")
        .select("id, username, avatar, rating")
        .eq("id", userId)
        .maybeSingle();

    return data || null;
}

// =============================
// SETUP
// =============================
// authenticatedUsers: die Map<authId, socketId> aus dem Hauptserver,
// damit wir online befindliche Nutzer direkt benachrichtigen können
// (z.B. bei einer neuen Clan-Einladung oder einem Kick).
export function setupClanHandlers(io, { authenticatedUsers, authIdToRoom }) {
    if (!supabaseAdmin) {
        console.warn("Clan-Feature deaktiviert - Supabase-Keys fehlen.");
        return;
    }

    const chatBuckets = new Map(); // socket.id -> timestamps[]

    const isOnline = (userId) => authenticatedUsers.has(userId);
    const isInGame = (userId) => Boolean(authIdToRoom?.has(userId));

    // Tells the clan that a member came online / went offline, and puts a
    // freshly connected member into the clan's chat room right away.
    async function announcePresence(socket, online) {
        const authId = socket.data.authId;
        if (!authId) return;

        try {
            const membership = await getAnyMembership(authId);
            if (!membership) return;

            if (online) socket.join(clanRoom(membership.clan_id));

            const lastSeenAt = new Date().toISOString();

            io.to(clanRoom(membership.clan_id)).emit("clan_presence", {
                userId: authId,
                online,
                inGame: online ? isInGame(authId) : false,
                lastSeenAt: online ? null : lastSeenAt,
            });

            if (!online) {
                const { error } = await supabaseAdmin
                    .from("profiles")
                    .update({ last_seen_at: lastSeenAt })
                    .eq("id", authId);

                if (error && !isMissingSchema(error)) console.log("LAST SEEN ERROR:", error.message);
            }
        } catch (error) {
            console.log("CLAN PRESENCE ERROR:", error?.message);
        }
    }

    async function notifyClanStaff(clanId, event, payload) {
        const { data } = await supabaseAdmin
            .from("clan_members")
            .select("user_id, rank")
            .eq("clan_id", clanId)
            .in("rank", [RANK.LEADER, RANK.ADMIN]);

        for (const row of data || []) notifyUser(row.user_id, event, payload);
    }

    // Adds a user to a clan (used by join, accepted invite, accepted request).
    async function addMember(clanId, userId) {
        const { error } = await supabaseAdmin.from("clan_members").insert({
            clan_id: clanId,
            user_id: userId,
            rank: RANK.MEMBER,
        });

        if (error) {
            if (error.message?.includes("CLAN_FULL")) throw new Error("CLAN_FULL");
            throw new Error("JOIN_FAILED");
        }

        const username = await getUsername(userId);

        const targetSocketId = authenticatedUsers.get(userId);
        if (targetSocketId) io.sockets.sockets.get(targetSocketId)?.join(clanRoom(clanId));

        io.to(clanRoom(clanId)).emit("clan_member_joined", { userId, username });

        await postSystemMessage(clanId, `${username} joined the clan.`);
        await recomputeLeague(clanId);

        // Anything else the user had open is obsolete now.
        const cleanup = await supabaseAdmin
            .from("clan_join_requests")
            .delete()
            .eq("user_id", userId)
            .eq("status", "pending");
        if (cleanup.error && !isMissingSchema(cleanup.error)) {
            console.log("JOIN REQUEST CLEANUP ERROR:", cleanup.error.message);
        }

        return username;
    }

    function allowChatMessage(socketId) {
        const now = Date.now();
        const arr = (chatBuckets.get(socketId) || []).filter(
            (t) => now - t < 10_000
        );

        if (arr.length >= MAX_CHAT_MESSAGES_PER_10S) {
            chatBuckets.set(socketId, arr);
            return false;
        }

        arr.push(now);
        chatBuckets.set(socketId, arr);
        return true;
    }

    async function postSystemMessage(clanId, message) {
        const { data } = await supabaseAdmin
            .from("clan_messages")
            .insert({
                clan_id: clanId,
                sender_id: null,
                sender_username: null,
                type: "system",
                message,
            })
            .select()
            .single();

        io.to(clanRoom(clanId)).emit("clan_message", data);
    }

    function notifyUser(authId, event, payload) {
        const socketId = authenticatedUsers.get(authId);
        if (!socketId) return;

        io.to(socketId).emit(event, payload);
    }

    // Pending requests of a clan with the profile of each applicant.
    async function loadJoinRequests(clanId) {
        const { data, error } = await supabaseAdmin
            .from("clan_join_requests")
            .select("id, user_id, created_at")
            .eq("clan_id", clanId)
            .eq("status", "pending")
            .order("created_at", { ascending: true });

        if (error || !data?.length) return [];

        const { data: profiles } = await supabaseAdmin
            .from("profiles")
            .select("id, username, avatar, rating")
            .in("id", data.map((row) => row.user_id));

        const byId = new Map((profiles || []).map((profile) => [profile.id, profile]));

        return data
            .map((row) => ({ ...row, profile: byId.get(row.user_id) ?? null }))
            .filter((row) => row.profile);
    }

    io.on("connection", (socket) => {
        announcePresence(socket, true);

        function requireAuth() {
            const authId = socket.data.authId;
            if (!authId) {
                throw new Error("NOT_AUTHENTICATED");
            }
            return authId;
        }

        function safeHandler(fn) {
            return async (data, ack) => {
                try {
                    const result = await fn(data || {});
                    if (typeof ack === "function") ack({ ok: true, ...result });
                } catch (error) {
                    console.log("CLAN ERROR:", error.message);
                    if (typeof ack === "function") {
                        ack({ ok: false, error: error.message });
                    }
                }
            };
        }

        // =============================
        // CLAN ERSTELLEN
        // =============================

        socket.on(
            "create_clan",
            safeHandler(async ({ name, tag, description, joinType, minRating, badge, badgeColor }) => {
                const authId = requireAuth();

                if (!isNonEmptyString(name, 40)) {
                    throw new Error("INVALID_NAME");
                }

                const existing = await getAnyMembership(authId);
                if (existing) throw new Error("ALREADY_IN_CLAN");

                const base = {
                    name: name.trim(),
                    tag: isNonEmptyString(tag, 8) ? tag.trim().toUpperCase() : null,
                    description: isNonEmptyString(description, 300) ? description.trim() : null,
                    creator_id: authId,
                };

                const settings = {
                    join_type: JOIN_TYPES.includes(joinType) ? joinType : "open",
                    min_rating: Number.isFinite(Number(minRating))
                        ? Math.max(0, Math.min(3000, Math.round(Number(minRating))))
                        : 0,
                    badge: BADGES.includes(badge) ? badge : "knight",
                    badge_color: BADGE_COLORS.includes(badgeColor) ? badgeColor : BADGE_COLORS[0],
                };

                let { data: clan, error } = await supabaseAdmin
                    .from("clans")
                    .insert({ ...base, ...settings })
                    .select()
                    .single();

                // Database not upgraded yet: create the clan without the new settings.
                if (error && isMissingSchema(error)) {
                    ({ data: clan, error } = await supabaseAdmin.from("clans").insert(base).select().single());
                }

                if (error) {
                    if (error.code === "23505") throw new Error("NAME_TAKEN");
                    throw new Error("CREATE_FAILED");
                }

                await supabaseAdmin.from("clan_members").insert({
                    clan_id: clan.id,
                    user_id: authId,
                    rank: RANK.LEADER,
                });

                await recomputeLeague(clan.id);

                socket.join(clanRoom(clan.id));

                console.log("CLAN CREATED:", { id: clan.id, name: clan.name, by: authId });

                return { clan: await loadClan(clan.id) };
            })
        );

        // =============================
        // CLAN BEITRETEN
        // =============================

        socket.on(
            "join_clan",
            safeHandler(async ({ clanId }) => {
                const authId = requireAuth();

                if (!isNonEmptyString(clanId, 100)) throw new Error("INVALID_CLAN");

                const existing = await getAnyMembership(authId);
                if (existing) throw new Error("ALREADY_IN_CLAN");

                const clan = await loadClan(clanId);
                if (!clan) throw new Error("CLAN_NOT_FOUND");

                if (clan.member_count >= MAX_MEMBERS) throw new Error("CLAN_FULL");
                if (clan.join_type === "closed") throw new Error("INVITE_ONLY");

                const profile = await getProfile(authId);
                if ((profile?.rating ?? 1000) < clan.min_rating) throw new Error("RATING_TOO_LOW");

                // "Request to join": the leader or an admin has to accept first.
                if (clan.join_type === "request") {
                    const { data: request, error } = await supabaseAdmin
                        .from("clan_join_requests")
                        .insert({ clan_id: clanId, user_id: authId, status: "pending" })
                        .select()
                        .single();

                    if (error) {
                        if (error.code === "23505") throw new Error("ALREADY_REQUESTED");
                        throw new Error("REQUEST_FAILED");
                    }

                    await notifyClanStaff(clanId, "clan_join_request_received", {
                        clanId,
                        request: { id: request.id, user_id: authId, created_at: request.created_at, profile },
                    });

                    return { requested: true };
                }

                await addMember(clanId, authId);

                return { joined: true };
            })
        );

        // =============================
        // CLAN VERLASSEN
        // =============================

        socket.on(
            "leave_clan",
            safeHandler(async ({ clanId }) => {
                const authId = requireAuth();

                const membership = await getMembership(clanId, authId);
                if (!membership) throw new Error("NOT_A_MEMBER");

                const username = await getUsername(authId);

                await supabaseAdmin
                    .from("clan_members")
                    .delete()
                    .eq("clan_id", clanId)
                    .eq("user_id", authId);

                socket.leave(clanRoom(clanId));

                let successorMessage = null;

                if (membership.rank === RANK.LEADER) {
                    // Nachfolge: zuerst unter den Admins, sonst unter den Mitgliedern
                    // (jeweils wer am längsten dabei ist).
                    const { data: remaining } = await supabaseAdmin
                        .from("clan_members")
                        .select("*")
                        .eq("clan_id", clanId)
                        .order("joined_at", { ascending: true });

                    if (!remaining || remaining.length === 0) {
                        // Clan war komplett leer -> auflösen
                        await supabaseAdmin.from("clan_join_requests").delete().eq("clan_id", clanId);
                        await supabaseAdmin.from("clans").delete().eq("id", clanId);
                    } else {
                        const nextAdmin = remaining.find((m) => m.rank === RANK.ADMIN);
                        const successor = nextAdmin || remaining[0];

                        await supabaseAdmin
                            .from("clan_members")
                            .update({ rank: RANK.LEADER })
                            .eq("clan_id", clanId)
                            .eq("user_id", successor.user_id);

                        const successorName = await getUsername(successor.user_id);
                        successorMessage = `${successorName} is the new leader.`;
                    }
                }

                io.to(clanRoom(clanId)).emit("clan_member_left", {
                    userId: authId,
                    username,
                });

                await postSystemMessage(clanId, `${username} left the clan.`);
                if (successorMessage) await postSystemMessage(clanId, successorMessage);
                await recomputeLeague(clanId);

                return {};
            })
        );

        // =============================
        // MEINEN CLAN LADEN
        // =============================

        socket.on(
            "get_my_clan",
            safeHandler(async () => {
                const authId = requireAuth();

                const membership = await getAnyMembership(authId);
                if (!membership) return { clan: null };

                // A reconnect may have happened before the membership existed.
                socket.join(clanRoom(membership.clan_id));

                return { clan: await loadClan(membership.clan_id), myRank: membership.rank };
            })
        );

        // =============================
        // CLAN-DATEN (Roster + letzte Nachrichten)
        // =============================

        socket.on(
            "get_clan_data",
            safeHandler(async ({ clanId }) => {
                // Also available to players who are not (yet) in the clan -
                // they see the roster, but not the chat.
                const authId = socket.data.authId || null;

                if (!isNonEmptyString(clanId, 100)) throw new Error("INVALID_CLAN");

                const clan = await loadClan(clanId);
                if (!clan) throw new Error("CLAN_NOT_FOUND");

                let { data: members, error: membersError } = await supabaseAdmin
                    .from("clan_members")
                    .select("user_id, rank, joined_at, profiles(username, avatar, rating, last_seen_at)")
                    .eq("clan_id", clanId)
                    .order("joined_at", { ascending: true });

                if (membersError && isMissingSchema(membersError)) {
                    ({ data: members } = await supabaseAdmin
                        .from("clan_members")
                        .select("user_id, rank, joined_at, profiles(username, avatar, rating)")
                        .eq("clan_id", clanId)
                        .order("joined_at", { ascending: true }));
                }

                const roster = (members || []).map((member) => ({
                    ...member,
                    online: isOnline(member.user_id),
                    inGame: isInGame(member.user_id),
                }));

                const myMembership = authId
                    ? roster.find((member) => member.user_id === authId) ?? null
                    : null;

                let messages = [];
                let requests = [];
                let myRequestPending = false;

                if (myMembership) {
                    socket.join(clanRoom(clanId));

                    const { data } = await supabaseAdmin
                        .from("clan_messages")
                        .select("*")
                        .eq("clan_id", clanId)
                        .order("created_at", { ascending: false })
                        .limit(50);

                    messages = (data || []).reverse();

                    if (myMembership.rank !== RANK.MEMBER) {
                        requests = await loadJoinRequests(clanId);
                    }
                } else if (authId) {
                    const { data } = await supabaseAdmin
                        .from("clan_join_requests")
                        .select("id")
                        .eq("clan_id", clanId)
                        .eq("user_id", authId)
                        .eq("status", "pending")
                        .maybeSingle();

                    myRequestPending = Boolean(data);
                }

                return {
                    clan,
                    members: roster,
                    messages,
                    requests,
                    myRank: myMembership?.rank ?? null,
                    myRequestPending,
                };
            })
        );

        // Who is online / in a game right now (cheap, the app polls this).
        socket.on(
            "get_clan_presence",
            safeHandler(async ({ clanId }) => {
                requireAuth();
                if (!isNonEmptyString(clanId, 100)) throw new Error("INVALID_CLAN");

                const { data } = await supabaseAdmin
                    .from("clan_members")
                    .select("user_id")
                    .eq("clan_id", clanId);

                const ids = (data || []).map((row) => row.user_id);

                return {
                    online: ids.filter(isOnline),
                    inGame: ids.filter(isInGame),
                };
            })
        );

        // =============================
        // PLAYER CARD (profile of another player)
        // =============================
        // Public information only: name, avatar, rating, statistics, clan
        // and whether the player is online. No account needed to look.
        socket.on(
            "get_player_profile",
            safeHandler(async ({ userId }) => {
                if (!isNonEmptyString(userId, 64) || !UUID_PATTERN.test(userId)) {
                    throw new Error("PLAYER_NOT_FOUND");
                }

                let { data: profile, error } = await supabaseAdmin
                    .from("profiles")
                    .select("id, username, avatar, rating, games_played, wins, puzzles_solved, vip_tier, last_seen_at")
                    .eq("id", userId)
                    .maybeSingle();

                if (error && isMissingSchema(error)) {
                    ({ data: profile } = await supabaseAdmin
                        .from("profiles")
                        .select("id, username, avatar, rating, vip_tier")
                        .eq("id", userId)
                        .maybeSingle());
                }

                if (!profile) throw new Error("PLAYER_NOT_FOUND");

                const { data: membership } = await supabaseAdmin
                    .from("clan_members")
                    .select("clan_id, rank")
                    .eq("user_id", userId)
                    .maybeSingle();

                const clan = membership ? await loadClan(membership.clan_id) : null;
                const online = isOnline(userId);

                return {
                    profile: {
                        id: profile.id,
                        username: profile.username,
                        avatar: profile.avatar || "",
                        rating: Number.isFinite(profile.rating) ? profile.rating : 1000,
                        games_played: profile.games_played ?? 0,
                        wins: profile.wins ?? 0,
                        puzzles_solved: profile.puzzles_solved ?? 0,
                        vip_tier: profile.vip_tier || "none",
                        last_seen_at: profile.last_seen_at ?? null,
                    },
                    clan,
                    clanRank: clan ? membership.rank : null,
                    online,
                    inGame: online ? isInGame(userId) : false,
                };
            })
        );

        // =============================
        // CLAN LISTS (no account needed to look around)
        // =============================

        socket.on(
            "list_clans",
            safeHandler(async ({ search }) => {
                const clans = await loadAllClans(typeof search === "string" ? search : "");

                return {
                    clans: clans.slice(0, 50).map((clan, index) => ({ ...clan, rank: index + 1 })),
                };
            })
        );

        socket.on(
            "get_suggested_clans",
            safeHandler(async () => {
                const authId = socket.data.authId || null;
                const profile = authId ? await getProfile(authId) : null;
                const rating = profile?.rating ?? 1000;

                const clans = (await loadAllClans(""))
                    .filter((clan) => clan.member_count < MAX_MEMBERS)
                    .filter((clan) => clan.join_type !== "closed")
                    .filter((clan) => clan.min_rating <= rating)
                    // closest in strength first; among equals the more active clan
                    .sort(
                        (a, b) =>
                            Math.abs(a.clan_rating - rating) - Math.abs(b.clan_rating - rating) ||
                            b.member_count - a.member_count
                    );

                return { clans: clans.slice(0, 6) };
            })
        );

        // =============================
        // CLAN SETTINGS (leader and admins)
        // =============================

        socket.on(
            "update_clan_settings",
            safeHandler(async ({ clanId, description, tag, joinType, minRating, badge, badgeColor }) => {
                const authId = requireAuth();

                const membership = await getMembership(clanId, authId);
                if (!membership || membership.rank === RANK.MEMBER) throw new Error("NOT_ALLOWED");

                const update = {};

                if (description !== undefined) {
                    if (description !== null && typeof description !== "string") throw new Error("INVALID_SETTINGS");
                    update.description = description ? String(description).trim().slice(0, 300) : null;
                }
                if (tag !== undefined) {
                    update.tag = isNonEmptyString(tag, 8) ? tag.trim().toUpperCase() : null;
                }
                if (joinType !== undefined) {
                    if (!JOIN_TYPES.includes(joinType)) throw new Error("INVALID_SETTINGS");
                    update.join_type = joinType;
                }
                if (minRating !== undefined) {
                    const value = Number(minRating);
                    if (!Number.isFinite(value)) throw new Error("INVALID_SETTINGS");
                    update.min_rating = Math.max(0, Math.min(3000, Math.round(value)));
                }
                if (badge !== undefined) {
                    if (!BADGES.includes(badge)) throw new Error("INVALID_SETTINGS");
                    update.badge = badge;
                }
                if (badgeColor !== undefined) {
                    if (!BADGE_COLORS.includes(badgeColor)) throw new Error("INVALID_SETTINGS");
                    update.badge_color = badgeColor;
                }

                if (Object.keys(update).length === 0) throw new Error("INVALID_SETTINGS");

                const { error } = await supabaseAdmin.from("clans").update(update).eq("id", clanId);

                if (error) {
                    if (isMissingSchema(error)) throw new Error("UPGRADE_REQUIRED");
                    throw new Error("UPDATE_FAILED");
                }

                const clan = await loadClan(clanId);

                io.to(clanRoom(clanId)).emit("clan_updated", { clan });

                return { clan };
            })
        );

        socket.on(
            "transfer_leadership",
            safeHandler(async ({ clanId, userId }) => {
                const authId = requireAuth();

                const requester = await getMembership(clanId, authId);
                if (!requester || requester.rank !== RANK.LEADER) throw new Error("NOT_ALLOWED");

                const target = await getMembership(clanId, userId);
                if (!target || userId === authId) throw new Error("INVALID_TARGET");

                await supabaseAdmin
                    .from("clan_members")
                    .update({ rank: RANK.LEADER })
                    .eq("clan_id", clanId)
                    .eq("user_id", userId);

                await supabaseAdmin
                    .from("clan_members")
                    .update({ rank: RANK.ADMIN })
                    .eq("clan_id", clanId)
                    .eq("user_id", authId);

                const username = await getUsername(userId);

                io.to(clanRoom(clanId)).emit("clan_leader_changed", { userId, previousLeaderId: authId, username });
                await postSystemMessage(clanId, `${username} is the new leader.`);

                return {};
            })
        );

        // =============================
        // JOIN REQUESTS ("request to join" clans)
        // =============================

        socket.on(
            "get_my_join_requests",
            safeHandler(async () => {
                const authId = requireAuth();

                const { data, error } = await supabaseAdmin
                    .from("clan_join_requests")
                    .select("id, clan_id, created_at")
                    .eq("user_id", authId)
                    .eq("status", "pending");

                if (error) return { requests: [] };

                const requests = [];
                for (const row of data || []) {
                    const clan = await loadClan(row.clan_id);
                    if (clan) requests.push({ id: row.id, created_at: row.created_at, clan });
                }

                return { requests };
            })
        );

        socket.on(
            "cancel_join_request",
            safeHandler(async ({ clanId }) => {
                const authId = requireAuth();

                await supabaseAdmin
                    .from("clan_join_requests")
                    .delete()
                    .eq("clan_id", clanId)
                    .eq("user_id", authId)
                    .eq("status", "pending");

                return {};
            })
        );

        socket.on(
            "respond_join_request",
            safeHandler(async ({ requestId, accept }) => {
                const authId = requireAuth();

                if (!isNonEmptyString(requestId, 100)) throw new Error("REQUEST_NOT_FOUND");

                const { data: request } = await supabaseAdmin
                    .from("clan_join_requests")
                    .select("*")
                    .eq("id", requestId)
                    .maybeSingle();

                if (!request || request.status !== "pending") throw new Error("REQUEST_NOT_FOUND");

                const requester = await getMembership(request.clan_id, authId);
                if (!requester || requester.rank === RANK.MEMBER) throw new Error("NOT_ALLOWED");

                const clan = await loadClan(request.clan_id);

                if (!accept) {
                    await supabaseAdmin.from("clan_join_requests").delete().eq("id", requestId);

                    notifyUser(request.user_id, "clan_join_request_answered", {
                        clanId: request.clan_id,
                        clanName: clan?.name,
                        accepted: false,
                    });

                    return {};
                }

                const alreadyMember = await getAnyMembership(request.user_id);
                if (alreadyMember) {
                    await supabaseAdmin.from("clan_join_requests").delete().eq("id", requestId);
                    throw new Error("USER_ALREADY_IN_CLAN");
                }

                if ((clan?.member_count ?? 0) >= MAX_MEMBERS) throw new Error("CLAN_FULL");

                // addMember also removes the user's pending requests.
                await addMember(request.clan_id, request.user_id);

                notifyUser(request.user_id, "clan_join_request_answered", {
                    clanId: request.clan_id,
                    clanName: clan?.name,
                    accepted: true,
                });

                return {};
            })
        );

        // =============================
        // CHAT-RAUM BEITRETEN (z.B. nach App-Neustart)
        // =============================

        socket.on(
            "join_clan_room",
            safeHandler(async ({ clanId }) => {
                const authId = requireAuth();

                const membership = await getMembership(clanId, authId);
                if (!membership) throw new Error("NOT_A_MEMBER");

                socket.join(clanRoom(clanId));
                return {};
            })
        );

        // =============================
        // CHAT-NACHRICHT SENDEN
        // =============================

        socket.on(
            "send_clan_message",
            safeHandler(async ({ clanId, message }) => {
                const authId = requireAuth();

                if (
                    !isNonEmptyString(clanId, 100) ||
                    !isNonEmptyString(message, CHAT_MESSAGE_MAX_LEN)
                ) {
                    throw new Error("INVALID_MESSAGE");
                }

                if (!allowChatMessage(socket.id)) throw new Error("RATE_LIMITED");

                const membership = await getMembership(clanId, authId);
                if (!membership) throw new Error("NOT_A_MEMBER");

                const username = await getUsername(authId);

                const { data: saved } = await supabaseAdmin
                    .from("clan_messages")
                    .insert({
                        clan_id: clanId,
                        sender_id: authId,
                        sender_username: username,
                        type: "chat",
                        message: message.slice(0, CHAT_MESSAGE_MAX_LEN),
                    })
                    .select()
                    .single();

                io.to(clanRoom(clanId)).emit("clan_message", saved);

                return {};
            })
        );

        // =============================
        // EINLADUNGEN
        // =============================

        socket.on(
            "invite_to_clan",
            safeHandler(async ({ clanId, username }) => {
                const authId = requireAuth();

                if (!isNonEmptyString(username, 60)) throw new Error("INVALID_USERNAME");

                const requester = await getMembership(clanId, authId);
                if (!requester || requester.rank === RANK.MEMBER) {
                    throw new Error("NOT_ALLOWED");
                }

                const { data: target } = await supabaseAdmin
                    .from("profiles")
                    .select("id, username")
                    .ilike("username", username.trim())
                    .maybeSingle();

                if (!target) throw new Error("USER_NOT_FOUND");

                const targetMembership = await getAnyMembership(target.id);
                if (targetMembership) throw new Error("USER_ALREADY_IN_CLAN");

                const { data: invite, error } = await supabaseAdmin
                    .from("clan_invites")
                    .insert({
                        clan_id: clanId,
                        invited_user_id: target.id,
                        invited_by: authId,
                        status: "pending",
                    })
                    .select()
                    .single();

                if (error) {
                    if (error.code === "23505") throw new Error("ALREADY_INVITED");
                    throw new Error("INVITE_FAILED");
                }

                const { data: clan } = await supabaseAdmin
                    .from("clans")
                    .select("name")
                    .eq("id", clanId)
                    .single();

                notifyUser(target.id, "clan_invite_received", {
                    invite,
                    clanName: clan?.name,
                });

                return { invite };
            })
        );

        socket.on(
            "get_my_invites",
            safeHandler(async () => {
                const authId = requireAuth();

                const { data } = await supabaseAdmin
                    .from("clan_invites")
                    .select("*, clans(name, tag)")
                    .eq("invited_user_id", authId)
                    .eq("status", "pending")
                    .order("created_at", { ascending: false });

                return { invites: data || [] };
            })
        );

        socket.on(
            "respond_clan_invite",
            safeHandler(async ({ inviteId, accept }) => {
                const authId = requireAuth();

                if (!isNonEmptyString(inviteId, 100)) throw new Error("INVALID_INVITE");

                const { data: invite } = await supabaseAdmin
                    .from("clan_invites")
                    .select("*")
                    .eq("id", inviteId)
                    .maybeSingle();

                if (!invite || invite.invited_user_id !== authId || invite.status !== "pending") {
                    throw new Error("INVITE_NOT_FOUND");
                }

                if (!accept) {
                    await supabaseAdmin
                        .from("clan_invites")
                        .update({ status: "declined" })
                        .eq("id", inviteId);

                    return {};
                }

                const existing = await getAnyMembership(authId);
                if (existing) throw new Error("ALREADY_IN_CLAN");

                const memberCount = await getMemberCount(invite.clan_id);
                if (memberCount >= MAX_MEMBERS) throw new Error("CLAN_FULL");

                await addMember(invite.clan_id, authId);

                await supabaseAdmin
                    .from("clan_invites")
                    .update({ status: "accepted" })
                    .eq("id", inviteId);

                return { clanId: invite.clan_id };
            })
        );

        // =============================
        // ADMIN-VERWALTUNG (nur Leader)
        // =============================

        socket.on(
            "promote_member",
            safeHandler(async ({ clanId, userId }) => {
                const authId = requireAuth();

                const requester = await getMembership(clanId, authId);
                if (!requester || requester.rank !== RANK.LEADER) {
                    throw new Error("NOT_ALLOWED");
                }

                const target = await getMembership(clanId, userId);
                if (!target || target.rank !== RANK.MEMBER) throw new Error("INVALID_TARGET");

                await supabaseAdmin
                    .from("clan_members")
                    .update({ rank: RANK.ADMIN })
                    .eq("clan_id", clanId)
                    .eq("user_id", userId);

                const username = await getUsername(userId);

                io.to(clanRoom(clanId)).emit("clan_member_promoted", { userId, username });
                await postSystemMessage(clanId, `${username} was promoted to admin.`);

                return {};
            })
        );

        socket.on(
            "demote_admin",
            safeHandler(async ({ clanId, userId }) => {
                const authId = requireAuth();

                const requester = await getMembership(clanId, authId);
                if (!requester || requester.rank !== RANK.LEADER) {
                    throw new Error("NOT_ALLOWED");
                }

                const target = await getMembership(clanId, userId);
                if (!target || target.rank !== RANK.ADMIN) throw new Error("INVALID_TARGET");

                await supabaseAdmin
                    .from("clan_members")
                    .update({ rank: RANK.MEMBER })
                    .eq("clan_id", clanId)
                    .eq("user_id", userId);

                const username = await getUsername(userId);

                io.to(clanRoom(clanId)).emit("clan_member_demoted", { userId, username });
                await postSystemMessage(clanId, `${username} is a regular member again.`);

                return {};
            })
        );

        // =============================
        // MITGLIED ENTFERNEN
        // =============================

        socket.on(
            "kick_member",
            safeHandler(async ({ clanId, userId }) => {
                const authId = requireAuth();

                const requester = await getMembership(clanId, authId);
                if (!requester || requester.rank === RANK.MEMBER) throw new Error("NOT_ALLOWED");

                const target = await getMembership(clanId, userId);
                if (!target) throw new Error("INVALID_TARGET");

                if (target.rank === RANK.LEADER) throw new Error("CANNOT_KICK_LEADER");

                // Admins dürfen nur normale Mitglieder rauswerfen, nicht andere Admins.
                if (requester.rank === RANK.ADMIN && target.rank === RANK.ADMIN) {
                    throw new Error("NOT_ALLOWED");
                }

                await supabaseAdmin
                    .from("clan_members")
                    .delete()
                    .eq("clan_id", clanId)
                    .eq("user_id", userId);

                const username = await getUsername(userId);

                io.to(clanRoom(clanId)).emit("clan_member_left", { userId, username, kicked: true });
                await postSystemMessage(clanId, `${username} was removed from the clan.`);
                await recomputeLeague(clanId);

                notifyUser(userId, "kicked_from_clan", { clanId });

                const targetSocketId = authenticatedUsers.get(userId);
                if (targetSocketId) {
                    io.sockets.sockets.get(targetSocketId)?.leave(clanRoom(clanId));
                }

                return {};
            })
        );

        socket.on("disconnect", () => {
            chatBuckets.delete(socket.id);

            // Only when this was the user's active connection (not when an
            // older device was just replaced by a newer one).
            const authId = socket.data.authId;
            const current = authId ? authenticatedUsers.get(authId) : null;
            if (authId && (!current || current === socket.id)) {
                announcePresence(socket, false);
            }
        });
    });
}