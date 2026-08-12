export type Role = 'mafia' | 'doctor' | 'sheriff' | 'jester' | 'villager';

export type GamePhase = 'lobby' | 'night_mafia' | 'night_doctor' | 'night_sheriff' | 'night_jester' | 'day_deliberation' | 'day_voting' | 'day_force_vote' | 'game_over';

export interface Player {
  id: string; // Session ID (persistent)
  socketId: string; // Current Socket connection ID
  name: string;
  role: Role | null;
  isAlive: boolean;
  isHost: boolean;
}

export interface GameSettings {
  numMafia: number;
  numDoctors: number;
  numSheriffs: number;
  numJesters: number;
  timers: {
    deliberation: number;
    voting: number;
  };
}

export interface GameState {
  roomId: string;
  hostId: string;
  players: Record<string, Player>; // Keyed by session ID
  socketToSession: Record<string, string>; // socket.id -> session ID
  settings: GameSettings;
  phase: GamePhase;
  phaseEndTime: number | null; // Timestamp when phase ends
  lockedPlayers: Record<string, boolean>; // Players who locked their night action
  
  // Night actions state
  mafiaVotes: Record<string, string>; // mafiaPlayerId -> targetPlayerId
  doctorVotes: Record<string, string>; // doctorPlayerId -> targetPlayerId
  lastDoctorSaves: Record<string, string | null>; // doctorPlayerId -> last targetId
  sheriffInvestigate: Record<string, string>; // sheriffId -> targetPlayerId
  
  // Day actions state
  dayVotes: Record<string, string>; // playerId -> targetPlayerId
  forceVoteTargets: [string, string] | null; // If tie
  
  // History
  narratorMessages: string[];
  winner: 'mafia' | 'town' | 'jester' | null;
}
