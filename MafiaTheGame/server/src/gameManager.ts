import { Server, Socket } from 'socket.io';
import { GamePhase, GameSettings, GameState, Player, Role } from './types';

const lobbies: Record<string, GameState> = {};
let io: Server;

export function initGameManager(serverIo: Server) {
  io = serverIo;

  io.on('connection', (socket: Socket) => {
    console.log('New client connected:', socket.id);

    socket.on('create_lobby', (data: { name: string; sessionId: string }) => {
      const roomId = generateRoomId();
      
      const newPlayer: Player = {
        id: data.sessionId,
        socketId: socket.id,
        name: data.name,
        role: null,
        isAlive: true,
        isHost: true, // The creator is the host
      };

      lobbies[roomId] = {
        roomId,
        hostId: data.sessionId,
        players: { [data.sessionId]: newPlayer },
        socketToSession: { [socket.id]: data.sessionId },
        settings: {
          numMafia: 1,
          numDoctors: 1,
          numSheriffs: 1,
          numJesters: 0,
          timers: { deliberation: 120, voting: 60 }
        },
        phase: 'lobby',
        phaseEndTime: null,
        lockedPlayers: {},
        mafiaVotes: {},
        doctorVotes: {},
        lastDoctorSaves: {},
        sheriffInvestigate: {},
        dayVotes: {},
        forceVoteTargets: null,
        narratorMessages: [],
        winner: null,
      };

      socket.join(roomId);
      socket.emit('lobby_created', { roomId, gameState: lobbies[roomId] });
    });

    socket.on('join_lobby', (data: { name: string; roomId: string; sessionId: string }) => {
      const { name, roomId, sessionId } = data;
      const lobby = lobbies[roomId.toUpperCase()];
      if (!lobby) {
        return socket.emit('error', 'Lobby not found');
      }

      // Check if this is a reconnect
      if (lobby.players[sessionId]) {
        // Reconnecting existing player
        lobby.players[sessionId].socketId = socket.id;
        lobby.socketToSession[socket.id] = sessionId;
        socket.join(lobby.roomId);
        
        // Let the reconnected player know their role (since it's stripped from general state)
        if (lobby.players[sessionId].role) {
          socket.emit('role_assigned', lobby.players[sessionId].role);
        }
        
        io.to(lobby.roomId).emit('game_state_update', getSanitizedState(lobby));
        return;
      }

      if (lobby.phase !== 'lobby') {
        return socket.emit('error', 'Game already started');
      }

      const newPlayer: Player = {
        id: sessionId,
        socketId: socket.id,
        name,
        role: null,
        isAlive: true,
        isHost: false,
      };

      lobby.players[sessionId] = newPlayer;
      lobby.socketToSession[socket.id] = sessionId;
      socket.join(lobby.roomId);
      
      io.to(lobby.roomId).emit('game_state_update', getSanitizedState(lobby));
    });

    socket.on('update_settings', (data: { roomId: string; settings: GameSettings }) => {
      const lobby = lobbies[data.roomId];
      const sid = lobby?.socketToSession[socket.id];
      if (lobby && lobby.hostId === sid) {
        lobby.settings = data.settings;
        io.to(lobby.roomId).emit('game_state_update', getSanitizedState(lobby));
      }
    });

    socket.on('start_game', (data: { roomId: string }) => {
      const lobby = lobbies[data.roomId];
      const sid = lobby?.socketToSession[socket.id];
      if (lobby && lobby.hostId === sid) {
        startGame(lobby);
      }
    });

    // Handle night actions
    socket.on('mafia_vote', (data: { roomId: string; targetId: string }) => {
      const lobby = lobbies[data.roomId];
      const sid = lobby?.socketToSession[socket.id];
      if (lobby && sid && lobby.phase === 'night_mafia' && lobby.players[sid]?.role === 'mafia' && lobby.players[sid]?.isAlive) {
        if (lobby.lockedPlayers[sid]) return; // Cannot change vote after locking
        lobby.mafiaVotes[sid] = data.targetId;
        // Broadcast mafia votes to other mafias
        emitToRole(lobby, 'mafia', 'mafia_votes_update', lobby.mafiaVotes);
      }
    });

    socket.on('doctor_save', (data: { roomId: string; targetId: string }) => {
      const lobby = lobbies[data.roomId];
      const sid = lobby?.socketToSession[socket.id];
      if (lobby && sid && lobby.phase === 'night_doctor' && lobby.players[sid]?.role === 'doctor' && lobby.players[sid]?.isAlive) {
        if (lobby.lockedPlayers[sid]) return;
        
        // Check if doctor is trying to save the same person twice in a row
        if (lobby.lastDoctorSaves && lobby.lastDoctorSaves[sid] === data.targetId) {
          return socket.emit('error', 'You cannot save the same person twice in a row.');
        }

        lobby.doctorVotes[sid] = data.targetId;
      }
    });

    socket.on('sheriff_investigate', (data: { roomId: string; targetId: string }) => {
      const lobby = lobbies[data.roomId];
      const sid = lobby?.socketToSession[socket.id];
      if (lobby && sid && lobby.phase === 'night_sheriff' && lobby.players[sid]?.role === 'sheriff' && lobby.players[sid]?.isAlive) {
        if (lobby.lockedPlayers[sid]) return;
        lobby.sheriffInvestigate[sid] = data.targetId;
      }
    });

    socket.on('lock_vote', (data: { roomId: string }) => {
      const lobby = lobbies[data.roomId];
      const sid = lobby?.socketToSession[socket.id];
      if (!lobby || !sid || !lobby.players[sid]?.isAlive) return;

      const myRole = lobby.players[sid].role;
      const isMyPhase = 
        (lobby.phase === 'night_mafia' && myRole === 'mafia') ||
        (lobby.phase === 'night_doctor' && myRole === 'doctor') ||
        (lobby.phase === 'night_sheriff' && myRole === 'sheriff');

      if (isMyPhase) {
        // Ensure they selected someone before locking
        if (lobby.phase === 'night_mafia' && !lobby.mafiaVotes[sid]) return socket.emit('error', 'Select a target first.');
        if (lobby.phase === 'night_doctor' && !lobby.doctorVotes[sid]) return socket.emit('error', 'Select a target first.');
        if (lobby.phase === 'night_sheriff') {
          const targetId = lobby.sheriffInvestigate[sid];
          if (!targetId) return socket.emit('error', 'Select a target first.');
          
          const target = lobby.players[targetId];
          const isMafia = target?.role === 'mafia';
          socket.emit('sheriff_result', { targetId, isMafia });
        }

        lobby.lockedPlayers[sid] = true;
        io.to(lobby.roomId).emit('game_state_update', getSanitizedState(lobby));

        if (Object.keys(lobby.lockedPlayers).length >= hasAliveRoleCount(lobby, myRole as Role)) {
          transitionNextPhase(lobby);
        }
      }
    });

    // Handle day votes
    socket.on('day_vote', (data: { roomId: string; targetId: string }) => {
      const lobby = lobbies[data.roomId];
      const sid = lobby?.socketToSession[socket.id];
      const phaseValid = lobby?.phase === 'day_voting' || lobby?.phase === 'day_force_vote';
      if (lobby && sid && phaseValid && lobby.players[sid]?.isAlive) {
        
        if (lobby.phase === 'day_force_vote' && lobby.forceVoteTargets) {
          if (!lobby.forceVoteTargets.includes(data.targetId) && data.targetId !== 'SKIP') return;
        }

        lobby.dayVotes[sid] = data.targetId;
        io.to(lobby.roomId).emit('game_state_update', getSanitizedState(lobby));
        
        // Count votes to see if strict majority is reached
        const voteCounts: Record<string, number> = {};
        Object.values(lobby.dayVotes).forEach(targetId => {
          voteCounts[targetId] = (voteCounts[targetId] || 0) + 1;
        });

        const aliveCount = Object.values(lobby.players).filter(p => p.isAlive).length;
        const strictMajority = Math.floor(aliveCount / 2) + 1;
        const hasMajority = Object.values(voteCounts).some(count => count >= strictMajority);

        // Check if everyone alive has voted, OR if someone reached a strict mathematical majority early
        if (Object.keys(lobby.dayVotes).length === aliveCount || hasMajority) {
          resolveDayVote(lobby);
        }
      }
    });

    socket.on('play_again', (data: { roomId: string }) => {
      const lobby = lobbies[data.roomId];
      const sid = lobby?.socketToSession[socket.id];
      if (lobby && lobby.hostId === sid && lobby.phase === 'game_over') {
        lobby.phase = 'lobby';
        lobby.phaseEndTime = null;
        lobby.lockedPlayers = {};
        lobby.mafiaVotes = {};
        lobby.doctorVotes = {};
        lobby.lastDoctorSaves = {};
        lobby.sheriffInvestigate = {};
        lobby.dayVotes = {};
        lobby.forceVoteTargets = null;
        lobby.narratorMessages = [];
        lobby.winner = null;

        Object.values(lobby.players).forEach(p => {
          p.isAlive = true;
          p.role = null;
        });

        io.to(lobby.roomId).emit('game_state_update', getSanitizedState(lobby));
      }
    });

    socket.on('disconnect', () => {
      // Find which room they were in and remove them (or mark disconnected)
      // For simplicity, we just log it. A robust app would handle reconnects.
      console.log('Client disconnected:', socket.id);
    });
  });
}

function generateRoomId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let id = '';
  for (let i = 0; i < 4; i++) {
    id += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return id;
}

function startGame(lobby: GameState) {
  assignRoles(lobby);
  lobby.narratorMessages.push('The game has started.');
  
  // Send each player their secret role
  Object.values(lobby.players).forEach(player => {
    io.to(player.id).emit('role_assigned', player.role);
  });

  startNightPhase(lobby);
}

function assignRoles(lobby: GameState) {
  const players = Object.values(lobby.players);
  let availableRoles: Role[] = [];
  
  for(let i=0; i<lobby.settings.numMafia; i++) availableRoles.push('mafia');
  for(let i=0; i<lobby.settings.numDoctors; i++) availableRoles.push('doctor');
  for(let i=0; i<lobby.settings.numSheriffs; i++) availableRoles.push('sheriff');
  for(let i=0; i<lobby.settings.numJesters; i++) availableRoles.push('jester');

  while (availableRoles.length < players.length) {
    availableRoles.push('villager');
  }

  // Fisher-Yates shuffle roles
  for (let i = availableRoles.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [availableRoles[i], availableRoles[j]] = [availableRoles[j], availableRoles[i]];
  }

  players.forEach((player, index) => {
    player.role = availableRoles[index];
    io.to(player.id).emit('role_assigned', player.role);
  });

  // Tell mafias who the other mafias are
  const mafiaIds = players.filter(p => p.role === 'mafia').map(p => p.id);
  players.filter(p => p.role === 'mafia').forEach(p => {
    io.to(p.id).emit('mafia_teammates', mafiaIds);
  });
}

function startNightPhase(lobby: GameState) {
  lobby.mafiaVotes = {};
  lobby.doctorVotes = {};
  lobby.sheriffInvestigate = {};

  if (lobby.settings.numMafia > 0) {
    setNightPhase(lobby, 'night_mafia');
  } else if (lobby.settings.numDoctors > 0) {
    setNightPhase(lobby, 'night_doctor');
  } else if (lobby.settings.numSheriffs > 0) {
    setNightPhase(lobby, 'night_sheriff');
  } else if (lobby.settings.numJesters > 0) {
    setNightPhase(lobby, 'night_jester');
  } else {
    resolveNight(lobby);
  }
}

function setNightPhase(lobby: GameState, phase: GamePhase) {
  lobby.phase = phase;
  lobby.phaseEndTime = null; // No timer
  lobby.lockedPlayers = {};
  io.to(lobby.roomId).emit('game_state_update', getSanitizedState(lobby));
  
  if (phase === 'night_jester') {
    // Jester doesn't actually do anything, just pretend for 5 seconds
    setTimeout(() => transitionNextPhase(lobby), 5000);
  }
}

function setPhase(lobby: GameState, phase: GamePhase, duration: number) {
  lobby.phase = phase;
  lobby.phaseEndTime = Date.now() + duration * 1000;
  io.to(lobby.roomId).emit('game_state_update', getSanitizedState(lobby));

  setTimeout(() => {
    if (lobby.phase === phase) { // Ensure phase hasn't changed manually
      transitionNextPhase(lobby);
    }
  }, duration * 1000);
}

function transitionNextPhase(lobby: GameState) {
  if (lobby.phase === 'night_mafia') {
    if (lobby.settings.numDoctors > 0 && hasAliveRoleCount(lobby, 'doctor') > 0) {
      setNightPhase(lobby, 'night_doctor');
    } else if (lobby.settings.numSheriffs > 0 && hasAliveRoleCount(lobby, 'sheriff') > 0) {
      setNightPhase(lobby, 'night_sheriff');
    } else if (lobby.settings.numJesters > 0 && hasAliveRoleCount(lobby, 'jester') > 0) {
      setNightPhase(lobby, 'night_jester');
    } else {
      resolveNight(lobby);
    }
  } else if (lobby.phase === 'night_doctor') {
    if (lobby.settings.numSheriffs > 0 && hasAliveRoleCount(lobby, 'sheriff') > 0) {
      setNightPhase(lobby, 'night_sheriff');
    } else if (lobby.settings.numJesters > 0 && hasAliveRoleCount(lobby, 'jester') > 0) {
      setNightPhase(lobby, 'night_jester');
    } else {
      resolveNight(lobby);
    }
  } else if (lobby.phase === 'night_sheriff') {
    if (lobby.settings.numJesters > 0 && hasAliveRoleCount(lobby, 'jester') > 0) {
      setNightPhase(lobby, 'night_jester');
    } else {
      resolveNight(lobby);
    }
  } else if (lobby.phase === 'night_jester') {
    resolveNight(lobby);
  } else if (lobby.phase === 'day_deliberation') {
    setPhase(lobby, 'day_voting', lobby.settings.timers.voting);
  } else if (lobby.phase === 'day_voting') {
    resolveDayVote(lobby);
  } else if (lobby.phase === 'day_force_vote') {
    resolveDayVote(lobby); // If they tie again, someone random dies or no one
  }
}

function hasAliveRoleCount(lobby: GameState, role: Role) {
  return Object.values(lobby.players).filter(p => p.role === role && p.isAlive).length;
}

function resolveNight(lobby: GameState) {
  // 1. Calculate Mafia Kill
  let killedId: string | null = null;
  const voteCounts: Record<string, number> = {};
  
  Object.values(lobby.mafiaVotes).forEach(targetId => {
    voteCounts[targetId] = (voteCounts[targetId] || 0) + 1;
  });

  // Find max votes
  let maxVotes = 0;
  let targetsWithMaxVotes: string[] = [];
  for (const [targetId, count] of Object.entries(voteCounts)) {
    if (count > maxVotes) {
      maxVotes = count;
      targetsWithMaxVotes = [targetId];
    } else if (count === maxVotes) {
      targetsWithMaxVotes.push(targetId);
    }
  }

  if (targetsWithMaxVotes.length > 0) {
    // Pick randomly on a tie
    killedId = targetsWithMaxVotes[Math.floor(Math.random() * targetsWithMaxVotes.length)];
  }

  // 2. Doctor Save
  const docCounts: Record<string, number> = {};
  Object.values(lobby.doctorVotes).forEach(targetId => {
    docCounts[targetId] = (docCounts[targetId] || 0) + 1;
  });
  
  let savedId: string | null = null;
  let maxDocVotes = 0;
  for (const [targetId, count] of Object.entries(docCounts)) {
    if (count > maxDocVotes) {
      maxDocVotes = count;
      savedId = targetId;
    }
  }

  // Update last saves for doctors
  lobby.lastDoctorSaves = { ...lobby.doctorVotes };

  if (killedId && savedId === killedId) {
    killedId = null; // Saved!
  }

  if (killedId && lobby.players[killedId]) {
    lobby.players[killedId].isAlive = false;
    lobby.narratorMessages.push(`${lobby.players[killedId].name} was killed during the night.`);
  } else {
    lobby.narratorMessages.push('No one died during the night.');
  }

  if (checkWinConditions(lobby)) return;

  // Proceed to Day
  lobby.dayVotes = {};
  setPhase(lobby, 'day_deliberation', lobby.settings.timers.deliberation);
}

function resolveDayVote(lobby: GameState) {
  const voteCounts: Record<string, number> = {};
  Object.values(lobby.dayVotes).forEach(targetId => {
    voteCounts[targetId] = (voteCounts[targetId] || 0) + 1;
  });

  let maxVotes = 0;
  let targetsWithMaxVotes: string[] = [];

  for (const [targetId, count] of Object.entries(voteCounts)) {
    if (count > maxVotes) {
      maxVotes = count;
      targetsWithMaxVotes = [targetId];
    } else if (count === maxVotes) {
      targetsWithMaxVotes.push(targetId);
    }
  }

  if (maxVotes === 0) {
    lobby.narratorMessages.push('No one was voted out.');
    startNightPhase(lobby);
    return;
  }

  if (targetsWithMaxVotes.length === 1) {
    const killedId = targetsWithMaxVotes[0];
    
    if (killedId === 'SKIP') {
      lobby.narratorMessages.push('The town voted to skip. No one is killed.');
      startNightPhase(lobby);
      return;
    }

    lobby.players[killedId].isAlive = false;
    
    // Check Jester win
    if (lobby.players[killedId].role === 'jester') {
      lobby.winner = 'jester';
      lobby.narratorMessages.push(`${lobby.players[killedId].name} was the Jester! The Jester wins!`);
      endGame(lobby);
      return;
    }

    lobby.narratorMessages.push(`${lobby.players[killedId].name} was voted out and killed.`);
    
    if (!checkWinConditions(lobby)) {
      startNightPhase(lobby);
    }
  } else if (targetsWithMaxVotes.length === 2 && lobby.phase !== 'day_force_vote') {
    // Tie, go to force vote
    lobby.narratorMessages.push(`There is a tie between ${lobby.players[targetsWithMaxVotes[0]].name} and ${lobby.players[targetsWithMaxVotes[1]].name}. A force vote will commence.`);
    lobby.forceVoteTargets = [targetsWithMaxVotes[0], targetsWithMaxVotes[1]];
    lobby.dayVotes = {};
    setPhase(lobby, 'day_force_vote', lobby.settings.timers.voting);
  } else {
    // Multi tie or tie again -> no one dies
    lobby.narratorMessages.push('The vote was a tie again. No one is killed.');
    lobby.forceVoteTargets = null;
    startNightPhase(lobby);
  }
}

function checkWinConditions(lobby: GameState): boolean {
  let aliveMafia = 0;
  let aliveTown = 0;

  Object.values(lobby.players).forEach(p => {
    if (p.isAlive) {
      if (p.role === 'mafia') aliveMafia++;
      else aliveTown++; // Everyone else is considered town/neutral for mafia win condition
    }
  });

  if (aliveMafia === 0) {
    lobby.winner = 'town';
    endGame(lobby);
    return true;
  } else if (aliveMafia >= aliveTown) {
    lobby.winner = 'mafia';
    endGame(lobby);
    return true;
  }
  return false;
}

function endGame(lobby: GameState) {
  lobby.phase = 'game_over';
  lobby.phaseEndTime = null;
  io.to(lobby.roomId).emit('game_state_update', lobby); // Send full state so everyone sees roles
}

// Emits an event only to players with a specific role
function emitToRole(lobby: GameState, role: Role, event: string, data: any) {
  Object.values(lobby.players).forEach(player => {
    if (player.role === role) {
      io.to(player.id).emit(event, data);
    }
  });
}

// Prevents sending sensitive data (roles, votes) to players who shouldn't see it
function getSanitizedState(lobby: GameState): Partial<GameState> {
  const sanitized = { ...lobby };
  if (lobby.phase !== 'game_over') {
    // Don't send exact roles unless game is over, clients only know their own role
    sanitized.players = Object.fromEntries(
      Object.entries(lobby.players).map(([id, p]) => [
        id, 
        { ...p, role: null } // strip role
      ])
    );
    sanitized.mafiaVotes = {};
    sanitized.doctorVotes = {};
    sanitized.sheriffInvestigate = {};
  }
  return sanitized;
}
