import { createClient } from "@supabase/supabase-js";

const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json"
    }
  });
}

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
  }

  return createClient(url, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  });
}

function shuffle(list) {
  const copy = [...list];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
}

function normalizeSettings(input = {}) {
  const settings = {
    gridSize: Number.parseInt(input.gridSize, 10),
    blueCount: Number.parseInt(input.blueCount, 10),
    redCount: Number.parseInt(input.redCount, 10),
    assassinCount: Number.parseInt(input.assassinCount, 10)
  };

  if (Object.values(settings).some((value) => Number.isNaN(value))) {
    throw new Error("Invalid game settings.");
  }

  if (settings.gridSize < 4 || settings.gridSize > 6) {
    throw new Error("Grid size must stay between 4 and 6.");
  }

  if (settings.blueCount < 1 || settings.redCount < 1 || settings.assassinCount < 1) {
    throw new Error("Blue, red, and assassin counts must all be at least 1.");
  }

  const totalCells = settings.gridSize * settings.gridSize;
  const roleTotal = settings.blueCount + settings.redCount + settings.assassinCount;
  if (roleTotal >= totalCells) {
    throw new Error("At least one neutral card is required.");
  }

  return settings;
}

function generateRoomCode(length = 6) {
  let output = "";
  for (let index = 0; index < length; index += 1) {
    const randomIndex = Math.floor(Math.random() * ROOM_CODE_ALPHABET.length);
    output += ROOM_CODE_ALPHABET[randomIndex];
  }
  return output;
}

function nextTeam(team) {
  return team === "red" ? "blue" : "red";
}

function sanitizePlayerName(name = "") {
  const trimmed = String(name).trim().slice(0, 30);
  if (!trimmed) {
    throw new Error("Player name is required.");
  }
  return trimmed;
}

function sanitizeMessage(message = "") {
  const trimmed = String(message).trim().slice(0, 240);
  if (!trimmed) {
    throw new Error("Message cannot be empty.");
  }
  return trimmed;
}

function buildDeck(words, settings) {
  const totalCells = settings.gridSize * settings.gridSize;
  if (words.length < totalCells) {
    throw new Error(`Need at least ${totalCells} active words in Supabase.`);
  }

  const roles = [];
  const neutralCount = totalCells - settings.blueCount - settings.redCount - settings.assassinCount;

  for (let index = 0; index < settings.blueCount; index += 1) roles.push("blue");
  for (let index = 0; index < settings.redCount; index += 1) roles.push("red");
  for (let index = 0; index < neutralCount; index += 1) roles.push("neutral");
  for (let index = 0; index < settings.assassinCount; index += 1) roles.push("assassin");

  const selectedWords = shuffle(words).slice(0, totalCells);
  const shuffledRoles = shuffle(roles);

  return selectedWords.map((word, index) => ({
    id: index + 1,
    word,
    role: shuffledRoles[index],
    revealed: false
  }));
}

async function getWords(supabase) {
  const { data, error } = await supabase
    .from("codenames_words")
    .select("word")
    .eq("is_active", true);

  if (error) throw error;
  return data.map((row) => row.word.toUpperCase());
}

async function createBoardPayload(supabase, rawSettings) {
  const settings = normalizeSettings(rawSettings);
  const words = await getWords(supabase);
  const cards = buildDeck(words, settings);

  return {
    grid_size: settings.gridSize,
    blue_count: settings.blueCount,
    red_count: settings.redCount,
    assassin_count: settings.assassinCount,
    current_team: settings.blueCount >= settings.redCount ? "blue" : "red",
    status: "active",
    winner: null,
    red_remaining: settings.redCount,
    blue_remaining: settings.blueCount,
    cards_json: cards
  };
}

async function appendSystemMessage(supabase, gameId, message) {
  const { error } = await supabase
    .from("game_messages")
    .insert({
      game_id: gameId,
      player_name: "System",
      message
    });

  if (error) throw error;
}

function mapGameRow(row) {
  return {
    id: row.id,
    room_code: row.room_code,
    grid_size: row.grid_size,
    blue_count: row.blue_count,
    red_count: row.red_count,
    assassin_count: row.assassin_count,
    current_team: row.current_team,
    status: row.status,
    winner: row.winner,
    red_remaining: row.red_remaining,
    blue_remaining: row.blue_remaining,
    cards: Array.isArray(row.cards_json) ? row.cards_json : []
  };
}

async function getGameByRoomCode(supabase, roomCode) {
  const normalizedCode = String(roomCode || "").trim().toUpperCase();
  if (!normalizedCode) throw new Error("Room code is required.");

  const { data, error } = await supabase
    .from("games")
    .select("*")
    .eq("room_code", normalizedCode)
    .maybeSingle();

  if (error) throw error;
  if (!data) throw new Error("Room not found.");
  return data;
}

async function getMessages(supabase, gameId) {
  const { data, error } = await supabase
    .from("game_messages")
    .select("id, player_name, message, created_at")
    .eq("game_id", gameId)
    .order("created_at", { ascending: true })
    .limit(100);

  if (error) throw error;
  return data;
}

async function getRoomPayload(supabase, roomCode) {
  const gameRow = await getGameByRoomCode(supabase, roomCode);
  const messages = await getMessages(supabase, gameRow.id);
  return {
    game: mapGameRow(gameRow),
    messages
  };
}

async function createRoom(supabase, playerName, settings) {
  const normalizedName = sanitizePlayerName(playerName);
  const boardPayload = await createBoardPayload(supabase, settings);
  let roomCode = "";
  let gameRow = null;

  for (let attempt = 0; attempt < 8; attempt += 1) {
    roomCode = generateRoomCode();
    const { data, error } = await supabase
      .from("games")
      .insert({
        room_code: roomCode,
        ...boardPayload
      })
      .select("*")
      .single();

    if (!error) {
      gameRow = data;
      break;
    }

    if (error.code !== "23505") {
      throw error;
    }
  }

  if (!gameRow) throw new Error("Could not generate a unique room code.");

  await appendSystemMessage(supabase, gameRow.id, `${normalizedName} created room ${roomCode}.`);
  return getRoomPayload(supabase, roomCode);
}

async function resetRoom(supabase, roomCode, playerName, settings) {
  const normalizedName = sanitizePlayerName(playerName);
  const gameRow = await getGameByRoomCode(supabase, roomCode);
  const boardPayload = await createBoardPayload(supabase, settings);

  const { error } = await supabase
    .from("games")
    .update(boardPayload)
    .eq("id", gameRow.id);

  if (error) throw error;

  await appendSystemMessage(supabase, gameRow.id, `${normalizedName} started a fresh board.`);
  return getRoomPayload(supabase, roomCode);
}

async function revealCard(supabase, roomCode, playerName, cardId) {
  const normalizedName = sanitizePlayerName(playerName);
  const gameRow = await getGameByRoomCode(supabase, roomCode);

  if (gameRow.status !== "active") {
    return getRoomPayload(supabase, roomCode);
  }

  const cards = Array.isArray(gameRow.cards_json) ? [...gameRow.cards_json] : [];
  const index = cards.findIndex((card) => Number(card.id) === Number(cardId));
  if (index < 0) throw new Error("Card not found.");

  const card = { ...cards[index] };
  if (card.revealed) {
    return getRoomPayload(supabase, roomCode);
  }

  card.revealed = true;
  cards[index] = card;

  const update = {
    cards_json: cards,
    red_remaining: gameRow.red_remaining,
    blue_remaining: gameRow.blue_remaining,
    status: gameRow.status,
    winner: gameRow.winner
  };

  let message = `${normalizedName} revealed ${card.word}.`;

  if (card.role === "red") update.red_remaining -= 1;
  if (card.role === "blue") update.blue_remaining -= 1;

  if (card.role === "assassin") {
    update.status = "finished";
    update.winner = nextTeam(gameRow.current_team);
    message = `${normalizedName} revealed the assassin ${card.word}. ${update.winner.toUpperCase()} wins.`;
  } else if (update.red_remaining === 0) {
    update.status = "finished";
    update.winner = "red";
    message = `${normalizedName} revealed ${card.word}. RED wins the round.`;
  } else if (update.blue_remaining === 0) {
    update.status = "finished";
    update.winner = "blue";
    message = `${normalizedName} revealed ${card.word}. BLUE wins the round.`;
  }

  const { error } = await supabase
    .from("games")
    .update(update)
    .eq("id", gameRow.id);

  if (error) throw error;

  await appendSystemMessage(supabase, gameRow.id, message);
  return getRoomPayload(supabase, roomCode);
}

async function advanceTurn(supabase, roomCode, playerName) {
  const normalizedName = sanitizePlayerName(playerName);
  const gameRow = await getGameByRoomCode(supabase, roomCode);

  if (gameRow.status !== "active") {
    return getRoomPayload(supabase, roomCode);
  }

  const updatedTeam = nextTeam(gameRow.current_team);
  const { error } = await supabase
    .from("games")
    .update({
      current_team: updatedTeam
    })
    .eq("id", gameRow.id);

  if (error) throw error;

  await appendSystemMessage(supabase, gameRow.id, `${normalizedName} passed the turn to ${updatedTeam.toUpperCase()}.`);
  return getRoomPayload(supabase, roomCode);
}

async function addChatMessage(supabase, roomCode, playerName, message) {
  const normalizedName = sanitizePlayerName(playerName);
  const normalizedMessage = sanitizeMessage(message);
  const gameRow = await getGameByRoomCode(supabase, roomCode);

  const { error } = await supabase
    .from("game_messages")
    .insert({
      game_id: gameRow.id,
      player_name: normalizedName,
      message: normalizedMessage
    });

  if (error) throw error;

  return getRoomPayload(supabase, roomCode);
}

export default async function handler(request) {
  try {
    const supabase = getSupabase();

    if (request.method === "GET") {
      const { searchParams } = new URL(request.url);
      const roomCode = searchParams.get("roomCode");
      const payload = await getRoomPayload(supabase, roomCode);
      return json(200, payload);
    }

    if (request.method !== "POST") {
      return json(405, { error: "Method not allowed." });
    }

    const body = await request.json();
    const { action, roomCode, playerName, settings, cardId, message } = body;

    if (action === "create") {
      return json(200, await createRoom(supabase, playerName, settings));
    }

    if (action === "reset") {
      return json(200, await resetRoom(supabase, roomCode, playerName, settings));
    }

    if (action === "reveal") {
      return json(200, await revealCard(supabase, roomCode, playerName, cardId));
    }

    if (action === "nextTurn") {
      return json(200, await advanceTurn(supabase, roomCode, playerName));
    }

    if (action === "chat") {
      return json(200, await addChatMessage(supabase, roomCode, playerName, message));
    }

    return json(400, { error: "Unknown action." });
  } catch (error) {
    return json(400, {
      error: error.message || "Unexpected server error."
    });
  }
}
