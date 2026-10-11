(() => {
  "use strict";

  let accessToken = localStorage.getItem("sl_access_token") || "";
  const socket = io({ autoConnect: false, auth: { accessToken } });
  const $ = (id) => document.getElementById(id);
  const COLORS = ["#74f0c2", "#7aa7ff", "#ffd166", "#ff7b87"];
  const SNAKES = { 16: 6, 47: 26, 49: 11, 56: 53, 62: 19, 64: 60, 87: 24, 93: 73, 95: 75, 98: 78 };
  const LADDERS = { 1: 38, 4: 14, 9: 31, 21: 42, 28: 84, 36: 44, 51: 67, 71: 91, 80: 100 };

  let room = null;
  let myPlayerId = sessionStorage.getItem("sl_player_id") || null;
  let reconnectToken = sessionStorage.getItem("sl_reconnect_token") || null;
  let toastTimer = null;
  let lastRenderedChatCount = 0;

  async function redeemAccessToken() {
    const name = $("accessName").value.trim();
    const token = $("accessToken").value.trim();
    if (!name) { $("accessError").textContent = "Choose a player name first."; return; }
    if (!token) { $("accessError").textContent = "Enter your access token."; return; }
    $("redeemTokenBtn").disabled = true;
    $("accessError").textContent = "";
    try {
      const response = await fetch("/api/redeem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, token })
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || "Could not verify token.");
      accessToken = result.accessToken;
      localStorage.setItem("sl_access_token", accessToken);
      sessionStorage.setItem("sl_access_name", result.name);
      $("playerName").value = result.name;
      $("accessScreen").classList.add("hidden");
      $("entryScreen").classList.remove("hidden");
      socket.auth = { accessToken };
      socket.connect();
      showToast("Access granted. Welcome, " + result.name + "!");
    } catch (error) {
      $("accessError").textContent = error.message || "Could not verify token.";
    } finally {
      $("redeemTokenBtn").disabled = false;
    }
  }

  function showToast(message) {
    const toast = $("toast");
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 2600);
  }

  function setConnection(connected) {
    $("connectionDot").className = `dot ${connected ? "online" : "offline"}`;
    $("connectionText").textContent = connected ? "Connected" : "Reconnecting…";
  }

  function setEntryError(message = "") {
    $("entryError").textContent = message;
  }

  function saveSession(result) {
    myPlayerId = result.playerId;
    reconnectToken = result.reconnectToken;
    sessionStorage.setItem("sl_player_id", myPlayerId);
    sessionStorage.setItem("sl_reconnect_token", reconnectToken);
    sessionStorage.setItem("sl_room_code", result.code);
  }

  function clearSession() {
    myPlayerId = null;
    reconnectToken = null;
    sessionStorage.removeItem("sl_player_id");
    sessionStorage.removeItem("sl_reconnect_token");
    sessionStorage.removeItem("sl_room_code");
  }

  function emitWithAck(event, payload = {}) {
    return new Promise((resolve) => {
      socket.timeout(7000).emit(event, payload, (err, response) => {
        if (err) resolve({ ok: false, error: "Server took too long to respond. Try again." });
        else resolve(response || { ok: false, error: "No response from server." });
      });
    });
  }

  async function createRoom() {
    const name = $("playerName").value.trim();
    if (!name) return setEntryError("Enter your player name first.");
    setEntryError("");
    $("createRoomBtn").disabled = true;
    const result = await emitWithAck("room:create", { name });
    $("createRoomBtn").disabled = false;
    if (!result.ok) return setEntryError(result.error);
    saveSession(result);
    showGameScreen();
  }

  async function joinRoom() {
    const name = $("playerName").value.trim();
    const code = $("roomCodeInput").value.trim().toUpperCase();
    if (!name) return setEntryError("Enter your player name first.");
    if (code.length !== 6) return setEntryError("Enter the 6-character room code.");
    setEntryError("");
    $("joinRoomBtn").disabled = true;
    const result = await emitWithAck("room:join", { name, code });
    $("joinRoomBtn").disabled = false;
    if (!result.ok) return setEntryError(result.error);
    saveSession(result);
    showGameScreen();
  }

  function showGameScreen() {
    $("entryScreen").classList.add("hidden");
    $("gameScreen").classList.remove("hidden");
    $("chatInput").focus({ preventScroll: true });
  }

  function showEntryScreen() {
    $("gameScreen").classList.add("hidden");
    $("entryScreen").classList.remove("hidden");
    room = null;
    lastRenderedChatCount = 0;
  }

  function buildBoard() {
    const board = $("board");
    board.replaceChildren();
    const fragment = document.createDocumentFragment();

    // A traditional 10x10 serpentine board: 100 at top-left, 1 at bottom-left.
    for (let row = 9; row >= 0; row -= 1) {
      const rowNumbers = [];
      for (let col = 0; col < 10; col += 1) {
        const base = row * 10;
        rowNumbers.push(row % 2 === 0 ? base + col + 1 : base + 10 - col);
      }
      for (const number of rowNumbers) {
        const cell = document.createElement("div");
        cell.className = "square";
        cell.dataset.square = String(number);
        if (SNAKES[number]) cell.classList.add("snake-start");
        if (LADDERS[number]) cell.classList.add("ladder-start");
        if (number === 100) cell.classList.add("finish");

        const label = document.createElement("span");
        label.className = "square-number";
        label.textContent = number;
        cell.append(label);

        if (SNAKES[number] || LADDERS[number] || number === 100) {
          const icon = document.createElement("span");
          icon.className = "square-icon";
          icon.textContent = number === 100 ? "🏁" : (SNAKES[number] ? "🐍" : "🪜");
          cell.append(icon);
        }

        const pieces = document.createElement("div");
        pieces.className = "pieces";
        cell.append(pieces);
        fragment.append(cell);
      }
    }
    board.append(fragment);
  }

  function renderBoard() {
    document.querySelectorAll(".pieces").forEach((el) => el.replaceChildren());
    if (!room) return;
    for (const player of room.players) {
      if (player.position < 1 || player.position > 100) continue;
      const pieces = document.querySelector(`.square[data-square="${player.position}"] .pieces`);
      if (!pieces) continue;
      const piece = document.createElement("span");
      piece.className = `piece piece-${player.color}`;
      piece.title = player.name;
      piece.textContent = player.name.slice(0, 1).toUpperCase();
      piece.style.background = COLORS[player.color] || COLORS[0];
      pieces.append(piece);
    }
  }

  function renderPlayers() {
    const list = $("playersList");
    list.replaceChildren();
    if (!room) return;
    $("playerCount").textContent = `${room.players.length}/4`;

    room.players.forEach((player) => {
      const row = document.createElement("div");
      row.className = "player-row";
      const avatar = document.createElement("div");
      avatar.className = "player-avatar";
      avatar.style.background = COLORS[player.color] || COLORS[0];
      avatar.textContent = player.name.slice(0, 1).toUpperCase();

      const details = document.createElement("div");
      const name = document.createElement("div");
      name.className = "player-name";
      name.textContent = player.name;
      if (player.id === room.hostId) {
        const tag = document.createElement("span");
        tag.className = "player-tag";
        tag.textContent = "HOST";
        name.append(tag);
      }
      if (player.id === myPlayerId) {
        const tag = document.createElement("span");
        tag.className = "player-tag";
        tag.textContent = "YOU";
        name.append(tag);
      }
      const meta = document.createElement("div");
      meta.className = "player-meta";
      const isTurn = room.status === "playing" && room.players[room.currentTurn]?.id === player.id;
      meta.textContent = `${player.connected ? "● Online" : "○ Reconnecting"}${isTurn ? " · Their turn" : ""}`;
      meta.style.color = player.connected ? "#9aa9c5" : "#ff7b87";
      details.append(name, meta);

      const position = document.createElement("div");
      position.className = "player-position";
      position.textContent = player.position === 0 ? "—" : player.position;
      row.append(avatar, details, position);
      list.append(row);
    });
  }

  function renderChat() {
    if (!room) return;
    const container = $("chatMessages");
    const chat = room.chat || [];
    // Rebuild when server truncates history, otherwise append new entries only.
    if (chat.length < lastRenderedChatCount) {
      container.replaceChildren();
      lastRenderedChatCount = 0;
    }
    for (let index = lastRenderedChatCount; index < chat.length; index += 1) {
      const item = chat[index];
      const line = document.createElement("div");
      line.className = `chat-message ${item.playerId === "system" ? "system" : ""}`;
      if (item.playerId !== "system") {
        const name = document.createElement("span");
        name.className = "chat-name";
        name.textContent = `${item.name}:`;
        line.append(name);
      }
      const message = document.createElement("span");
      message.textContent = item.message;
      line.append(message);
      container.append(line);
    }
    lastRenderedChatCount = chat.length;
    container.scrollTop = container.scrollHeight;
  }

  function renderRoom() {
    if (!room) return;
    $("roomCodeLabel").textContent = room.code;
    const isHost = room.hostId === myPlayerId;
    const currentPlayer = room.players[room.currentTurn];
    const isMyTurn = room.status === "playing" && currentPlayer?.id === myPlayerId;
    const winner = room.players.find((p) => p.id === room.winnerId);

    if (room.status === "waiting") {
      $("turnLabel").textContent = room.players.length < 2 ? "Invite a friend to start" : "Waiting to start";
      $("lobbyHint").textContent = room.players.length < 2
        ? "Share the room code with a friend. At least 2 players are needed."
        : "Everyone is here! The host can start the game.";
    } else if (room.status === "playing") {
      $("turnLabel").textContent = currentPlayer ? `${currentPlayer.name}'s turn` : "Waiting for player";
      $("lobbyHint").textContent = isMyTurn ? "Your turn! Roll the dice." : "Wait for your turn, then roll.";
    } else {
      $("turnLabel").textContent = winner ? `🏆 ${winner.name} won!` : "Game finished";
      $("lobbyHint").textContent = "Great game! The host can start a new round.";
    }

    $("startGameBtn").classList.toggle("hidden", !isHost || room.status !== "waiting");
    $("startGameBtn").disabled = room.players.length < 2 || room.players.some((p) => !p.connected);
    $("restartGameBtn").classList.toggle("hidden", !isHost || room.status === "waiting");
    $("rollBtn").classList.toggle("hidden", room.status !== "playing");
    $("rollBtn").disabled = !isMyTurn;
    $("diceResult").classList.toggle("hidden", !room.lastMove);
    if (room.lastMove) {
      $("diceResult").querySelector("strong").textContent = ["⚀", "⚁", "⚂", "⚃", "⚄", "⚅"][room.lastMove.roll - 1] || room.lastMove.roll;
      const move = room.lastMove;
      let text = `${move.playerName} rolled ${move.roll}. `;
      if (move.from === 0 && move.roll !== 6) text += "A 6 is needed to enter the board.";
      else if (move.event?.type === "snake") text += `Snake! ${move.event.from} → ${move.event.to}.`;
      else if (move.event?.type === "ladder") text += `Ladder! ${move.event.from} → ${move.event.to}.`;
      else if (move.to === move.from) text += "No movement this turn.";
      else text += `Moved to square ${move.to}.`;
      $("moveBanner").textContent = winner ? `🏆 ${winner.name} wins! ${text}` : text;
    } else {
      $("moveBanner").textContent = room.status === "waiting" ? "Waiting for the host to start the game." : "Game ready.";
    }

    renderPlayers();
    renderBoard();
    renderChat();
  }

  async function startGame() {
    const result = await emitWithAck("game:start");
    if (!result.ok) showToast(result.error);
  }

  async function rollDice() {
    $("rollBtn").disabled = true;
    const result = await emitWithAck("game:roll");
    if (!result.ok) {
      showToast(result.error);
      renderRoom();
    }
  }

  async function restartGame() {
    const result = await emitWithAck("game:restart");
    if (!result.ok) showToast(result.error);
  }

  async function leaveRoom() {
    await emitWithAck("room:leave");
    clearSession();
    showEntryScreen();
    showToast("You left the room.");
  }

  async function sendChat(event) {
    event.preventDefault();
    const input = $("chatInput");
    const message = input.value.trim();
    if (!message) return;
    input.value = "";
    const result = await emitWithAck("chat:send", { message });
    if (!result.ok) showToast(result.error);
  }

  async function copyCode() {
    if (!room) return;
    try {
      await navigator.clipboard.writeText(room.code);
      showToast("Room code copied!");
    } catch {
      showToast(`Room code: ${room.code}`);
    }
  }

  socket.on("access:expired", () => {
    localStorage.removeItem("sl_access_token");
    accessToken = "";
    socket.disconnect();
    $("accessScreen").classList.remove("hidden");
    $("entryScreen").classList.add("hidden");
    $("gameScreen").classList.add("hidden");
    $("accessError").textContent = "Your access duration has ended. Request a new token on WhatsApp.";
  });
  socket.on("connect", async () => {
    setConnection(true);
    if (reconnectToken && !room) {
      const result = await emitWithAck("room:reconnect", { reconnectToken });
      if (result.ok) {
        myPlayerId = result.playerId;
        sessionStorage.setItem("sl_player_id", myPlayerId);
        showGameScreen();
      } else if (sessionStorage.getItem("sl_room_code")) {
        showToast("Previous room session could not be restored. You can join the room again.");
      }
    }
  });
  socket.on("disconnect", () => setConnection(false));
  socket.on("connect_error", (error) => {
    setConnection(false);
    if (String(error?.message || "").includes("Access required")) {
      localStorage.removeItem("sl_access_token");
      accessToken = "";
      $("accessScreen").classList.remove("hidden");
      $("entryScreen").classList.add("hidden");
      $("gameScreen").classList.add("hidden");
      $("accessError").textContent = "Access session expired. Redeem a new token.";
    }
  });
  socket.on("room:update", (updatedRoom) => {
    room = updatedRoom;
    if (room) showGameScreen();
    renderRoom();
  });

  $("redeemTokenBtn").addEventListener("click", redeemAccessToken);
  $("accessToken").addEventListener("keydown", (event) => { if (event.key === "Enter") redeemAccessToken(); });
  $("accessName").addEventListener("keydown", (event) => { if (event.key === "Enter") $("accessToken").focus(); });
  if (accessToken) {
    $("accessScreen").classList.add("hidden");
    $("entryScreen").classList.remove("hidden");
    $("playerName").value = sessionStorage.getItem("sl_access_name") || "";
    socket.connect();
  }

  $("createRoomBtn").addEventListener("click", createRoom);
  $("joinRoomBtn").addEventListener("click", joinRoom);
  $("startGameBtn").addEventListener("click", startGame);
  $("rollBtn").addEventListener("click", rollDice);
  $("restartGameBtn").addEventListener("click", restartGame);
  $("leaveRoomBtn").addEventListener("click", leaveRoom);
  $("copyCodeBtn").addEventListener("click", copyCode);
  $("chatForm").addEventListener("submit", sendChat);
  $("playerName").addEventListener("keydown", (event) => { if (event.key === "Enter") createRoom(); });
  $("roomCodeInput").addEventListener("input", () => { $("roomCodeInput").value = $("roomCodeInput").value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6); });
  $("roomCodeInput").addEventListener("keydown", (event) => { if (event.key === "Enter") joinRoom(); });

  buildBoard();
})();
