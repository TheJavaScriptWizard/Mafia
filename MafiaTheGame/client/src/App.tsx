import React, { useEffect, useState, useMemo } from 'react';
import { socket } from './socket';
import type { GameState, Role, GameSettings } from './types';
import { Users, Crown, Skull, Search, Target } from 'lucide-react';
import './index.css';

function App() {
  const [gameState, setGameState] = useState<GameState | null>(null);
  const [playerName, setPlayerName] = useState('');
  const [roomCodeInput, setRoomCodeInput] = useState('');
  const [myRole, setMyRole] = useState<Role | null>(null);
  const [sheriffResults, setSheriffResults] = useState<{targetId: string, isMafia: boolean}[]>([]);
  const [timeLeft, setTimeLeft] = useState<number>(0);
  const [errorMsg, setErrorMsg] = useState<string>('');
  
  // New States for Locking / Teammates
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [mafiaTeammates, setMafiaTeammates] = useState<string[]>([]);
  const [mafiaVotesState, setMafiaVotesState] = useState<Record<string, string>>({});

  useEffect(() => {
    socket.on('lobby_created', (data: { roomId: string, gameState: GameState }) => {
      setGameState(data.gameState);
    });

    socket.on('game_state_update', (state: GameState) => {
      setGameState(state);
    });

    socket.on('mafia_teammates', (teammates: string[]) => {
      setMafiaTeammates(teammates);
    });

    socket.on('mafia_votes_update', (votes: Record<string, string>) => {
      setMafiaVotesState(votes);
    });

    socket.on('role_assigned', (role: Role) => {
      setMyRole(role);
    });

    socket.on('sheriff_result', (res: {targetId: string, isMafia: boolean}) => {
      setSheriffResults(prev => [...prev, res]);
    });

    socket.on('error', (msg: string) => {
      setErrorMsg(msg);
      setTimeout(() => setErrorMsg(''), 3000);
    });

    return () => {
      socket.off('lobby_created');
      socket.off('game_state_update');
      socket.off('mafia_teammates');
      socket.off('mafia_votes_update');
      socket.off('role_assigned');
      socket.off('sheriff_result');
      socket.off('error');
    };
  }, []);

  // Clear pending actions on phase change
  useEffect(() => {
    setPendingAction(null);
  }, [gameState?.phase]);

  const me = useMemo(() => {
    if (!gameState || !socket.id) return null;
    return gameState.players[socket.id] || null;
  }, [gameState]);

  // TTS Narrator Logic
  useEffect(() => {
    if (!gameState || !me?.isHost) return;
    
    // Stop any current speech
    window.speechSynthesis.cancel();
    
    const speak = (text: string) => {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 0.9;
      utterance.pitch = 0.8; // slightly deeper voice for mafia vibe
      window.speechSynthesis.speak(utterance);
    };

    switch (gameState.phase) {
      case 'night_mafia':
        speak("Everyone, go to sleep. Mafia, wake up. Select your target.");
        break;
      case 'night_doctor':
        speak("Mafia, go to sleep. Doctor, wake up. Choose who to save.");
        break;
      case 'night_sheriff':
        speak("Doctor, go to sleep. Sheriff, wake up. Choose who to investigate.");
        break;
      case 'night_jester':
        speak("Sheriff, go to sleep. Jester, wake up.");
        break;
      case 'day_deliberation':
        speak("Everyone, wake up. The sun is rising.");
        break;
      case 'day_voting':
        speak("It is time to vote.");
        break;
      case 'day_force_vote':
        speak("There is a tie. Force vote.");
        break;
      case 'game_over':
        speak("The game is over.");
        break;
    }
  }, [gameState?.phase, me?.isHost]);

  // Timer logic
  useEffect(() => {
    if (!gameState?.phaseEndTime) {
      setTimeLeft(0);
      return;
    }
    const interval = setInterval(() => {
      const remaining = Math.max(0, Math.floor((gameState.phaseEndTime! - Date.now()) / 1000));
      setTimeLeft(remaining);
    }, 1000);
    return () => clearInterval(interval);
  }, [gameState?.phaseEndTime]);

  const handleCreateLobby = (e: React.FormEvent) => {
    e.preventDefault();
    if (!playerName) return;
    socket.emit('create_lobby', { name: playerName });
  };

  const handleJoinLobby = (e: React.FormEvent) => {
    e.preventDefault();
    if (!playerName || !roomCodeInput) return;
    socket.emit('join_lobby', { name: playerName, roomId: roomCodeInput });
  };

  if (!gameState) {
    return (
      <div className="flex-center">
        <div className="glass-panel" style={{ maxWidth: '400px', width: '100%' }}>
          <h1 className="title-red" style={{ fontSize: '3rem' }}>MAFIA</h1>
          <p style={{ textAlign: 'center', marginBottom: '2rem', color: 'var(--text-secondary)' }}>A game of deception.</p>
          
          {errorMsg && <div style={{color: 'var(--accent-red)', marginBottom: '1rem', textAlign: 'center'}}>{errorMsg}</div>}

          <form onSubmit={handleCreateLobby} style={{ marginBottom: '2rem' }}>
            <input 
              type="text" 
              placeholder="Enter your nickname" 
              value={playerName} 
              onChange={e => setPlayerName(e.target.value)} 
              required 
              maxLength={15}
            />
            <button type="submit" className="primary">Create New Game</button>
          </form>

          <div style={{ textAlign: 'center', margin: '1rem 0', color: 'var(--text-secondary)' }}>— OR —</div>

          <form onSubmit={handleJoinLobby}>
            <input 
              type="text" 
              placeholder="Room Code (e.g. ABCD)" 
              value={roomCodeInput} 
              onChange={e => setRoomCodeInput(e.target.value.toUpperCase())} 
              required 
              maxLength={4}
            />
            <button type="submit">Join Game</button>
          </form>
        </div>
      </div>
    );
  }

  // --- RENDERING SUB-COMPONENTS BASED ON PHASE ---

  const renderLobby = () => {
    const isHost = me?.isHost;
    
    const updateSettings = (key: keyof GameSettings, val: number | object) => {
      if (!isHost) return;
      socket.emit('update_settings', {
        roomId: gameState.roomId,
        settings: { ...gameState.settings, [key]: val }
      });
    };

    const updateTimer = (key: keyof GameSettings['timers'], val: number) => {
      if (!isHost) return;
      socket.emit('update_settings', {
        roomId: gameState.roomId,
        settings: { ...gameState.settings, timers: { ...gameState.settings.timers, [key]: val } }
      });
    };

    return (
      <div className="lobby-container glass-panel">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2>Room Code: <span className="title-red">{gameState.roomId}</span></h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Users /> {Object.keys(gameState.players).length} Players
          </div>
        </div>

        <div className="players-list">
          {Object.values(gameState.players).map(p => (
            <div key={p.id} className={`player-card ${p.isHost ? 'host' : ''}`}>
              {p.isHost && <Crown size={16} color="var(--accent-red)" />}
              {p.name}
            </div>
          ))}
        </div>

        {isHost ? (
          <div style={{ marginTop: '2rem', borderTop: '1px solid var(--panel-border)', paddingTop: '2rem' }}>
            <h3>Game Settings</h3>
            <div className="grid-2">
              <div>
                <label>Mafias: {gameState.settings.numMafia}</label>
                <input type="range" min="1" max="5" value={gameState.settings.numMafia} onChange={e => updateSettings('numMafia', parseInt(e.target.value))} />
                
                <label>Doctors: {gameState.settings.numDoctors}</label>
                <input type="range" min="0" max="3" value={gameState.settings.numDoctors} onChange={e => updateSettings('numDoctors', parseInt(e.target.value))} />
                
                <label>Sheriffs: {gameState.settings.numSheriffs}</label>
                <input type="range" min="0" max="3" value={gameState.settings.numSheriffs} onChange={e => updateSettings('numSheriffs', parseInt(e.target.value))} />
                
                <label>Jesters: {gameState.settings.numJesters}</label>
                <input type="range" min="0" max="2" value={gameState.settings.numJesters} onChange={e => updateSettings('numJesters', parseInt(e.target.value))} />
              </div>
              <div>
                <label>Deliberation Timer (s): {gameState.settings.timers.deliberation}</label>
                <input type="range" min="30" max="300" step="30" value={gameState.settings.timers.deliberation} onChange={e => updateTimer('deliberation', parseInt(e.target.value))} />
                
                <label>Voting Timer (s): {gameState.settings.timers.voting}</label>
                <input type="range" min="15" max="120" step="15" value={gameState.settings.timers.voting} onChange={e => updateTimer('voting', parseInt(e.target.value))} />
              </div>
            </div>
            
            <button className="primary" style={{ marginTop: '2rem' }} onClick={() => socket.emit('start_game', { roomId: gameState.roomId })}>
              Start Game
            </button>
          </div>
        ) : (
          <div style={{ marginTop: '2rem', textAlign: 'center', fontStyle: 'italic', color: 'var(--text-secondary)' }}>
            Waiting for Host to start the game...
          </div>
        )}
      </div>
    );
  };

  const renderRoleCard = () => {
    if (!myRole) return null;
    const roleColors: Record<string, string> = {
      mafia: 'role-mafia',
      doctor: 'role-doctor',
      sheriff: 'role-sheriff',
      jester: 'role-jester',
      villager: 'role-villager'
    };
    const roleDescriptions: Record<string, string> = {
      mafia: 'Kill a villager every night. Don\'t get caught.',
      doctor: 'Choose someone to save from the Mafia each night.',
      sheriff: 'Investigate one person each night to find the Mafia.',
      jester: 'Get yourself voted out during the day to win.',
      villager: 'Find and vote out the Mafia during the day.'
    };
    return (
      <div className="role-reveal">
        <h3>You are</h3>
        <div className={`role-card ${roleColors[myRole]}`}>
          <h1 style={{ fontSize: '3rem', margin: 0, letterSpacing: 'normal', textTransform: 'capitalize' }}>
            {myRole}
          </h1>
        </div>
        <p style={{ fontSize: '1.2rem' }}>{roleDescriptions[myRole]}</p>
      </div>
    );
  };

  const getAlivePlayers = () => Object.values(gameState.players).filter(p => p.isAlive && p.id !== me?.id);
  const getAllPlayers = () => Object.values(gameState.players);

  const renderSheriffNotebook = () => {
    if (myRole !== 'sheriff' || sheriffResults.length === 0) return null;
    return (
      <div className="narrator-box" style={{ marginTop: '2rem', textAlign: 'left', background: 'var(--panel-bg)', padding: '1rem', borderRadius: '8px' }}>
        <h3 style={{ marginTop: 0, color: 'var(--accent-blue)', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Search size={18} /> Sheriff's Notebook
        </h3>
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {sheriffResults.map((res, i) => {
            const name = gameState.players[res.targetId]?.name || 'Unknown';
            return (
              <li key={i} style={{ padding: '0.5rem 0', borderBottom: '1px solid var(--panel-border)' }}>
                Investigated <strong>{name}</strong>: {' '}
                <span style={{ color: res.isMafia ? 'var(--accent-red)' : 'var(--text-primary)' }}>
                  {res.isMafia ? 'MAFIA' : 'NOT MAFIA'}
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    );
  };

  const renderNightAction = () => {
    const isMyTurn = 
      (gameState.phase === 'night_mafia' && myRole === 'mafia') ||
      (gameState.phase === 'night_doctor' && myRole === 'doctor') ||
      (gameState.phase === 'night_sheriff' && myRole === 'sheriff');

    if (!me?.isAlive) return <div style={{textAlign:'center'}}><h2>You are dead.</h2><p>Wait for the sun to rise.</p></div>;

    if (!isMyTurn) {
      return (
        <div style={{ textAlign: 'center' }}>
          <h2>City is sleeping...</h2>
          {gameState.phase === 'night_jester' && myRole === 'jester' && (
            <p style={{color: 'var(--accent-purple)', fontSize: '1.2rem', marginTop: '1rem'}}>
              (Just pretend to do something to confuse everyone!)
            </p>
          )}
          <p style={{marginTop: '2rem'}}>Wait for others to perform their actions.</p>
        </div>
      );
    }

    const titleMap: Record<string, {title: string, action: string}> = {
      night_mafia: { title: 'Mafia Phase', action: 'mafia_vote' },
      night_doctor: { title: 'Doctor Phase', action: 'doctor_save' },
      night_sheriff: { title: 'Sheriff Phase', action: 'sheriff_investigate' }
    };

    const config = titleMap[gameState.phase];

    let targets = myRole === 'doctor' 
      ? Object.values(gameState.players).filter(p => p.isAlive) 
      : getAlivePlayers();

    // Mafias cannot target themselves or other mafias
    if (myRole === 'mafia') {
      targets = targets.filter(p => !mafiaTeammates.includes(p.id));
    }

    const hasLocked = (socket.id && gameState.lockedPlayers[socket.id]) || false;

    return (
      <div>
        <h2 className="title-red" style={{textAlign:'center'}}>{config.title}</h2>
        <p style={{textAlign:'center', marginBottom: '2rem'}}>
          {hasLocked ? 'Vote locked in. Waiting for others...' : 'Select your target.'}
        </p>
        
        {renderSheriffNotebook()}

        <div className="vote-grid">
          {targets.map(p => {
            const isSelected = pendingAction === p.id || (myRole === 'mafia' && socket.id && mafiaVotesState[socket.id] === p.id);
            const votesForP = myRole === 'mafia' ? Object.values(mafiaVotesState).filter(v => v === p.id).length : 0;
            
            return (
              <button 
                key={p.id} 
                className={`vote-btn ${isSelected ? 'selected' : ''}`}
                disabled={hasLocked}
                onClick={() => {
                  if (hasLocked) return;
                  setPendingAction(p.id);
                  socket.emit(config.action, { roomId: gameState.roomId, targetId: p.id });
                }}
              >
                <Target style={{marginBottom: '0.5rem'}} />
                {p.name}
                {myRole === 'mafia' && votesForP > 0 && <div className="vote-count">{votesForP} Votes</div>}
              </button>
            );
          })}
        </div>

        {!hasLocked && (
          <div style={{ textAlign: 'center', marginTop: '2rem' }}>
            <button 
              className="primary" 
              onClick={() => socket.emit('lock_vote', { roomId: gameState.roomId })}
              disabled={!pendingAction && !(myRole === 'mafia' && socket.id && mafiaVotesState[socket.id])}
            >
              Lock In Vote
            </button>
          </div>
        )}
      </div>
    );
  };

  const renderDayPhase = () => {
    if (gameState.phase === 'day_deliberation') {
      return (
        <div style={{textAlign: 'center'}}>
          <h2>Deliberation Phase</h2>
          <p style={{fontSize: '1.2rem', marginBottom: '2rem'}}>Discuss who you think the Mafia is.</p>
          <div className="players-list" style={{justifyContent: 'center'}}>
            {getAllPlayers().map(p => (
              <div key={p.id} className={`player-card ${!p.isAlive ? 'dead' : ''}`}>
                {!p.isAlive && <Skull size={16} />}
                {p.name}
              </div>
            ))}
          </div>
          {renderSheriffNotebook()}
        </div>
      );
    }

    // Voting Phase
    const isForceVote = gameState.phase === 'day_force_vote';
    const targets = isForceVote && gameState.forceVoteTargets
      ? getAllPlayers().filter(p => gameState.forceVoteTargets!.includes(p.id))
      : getAlivePlayers();

    const myVote = socket.id ? gameState.dayVotes[socket.id] : undefined;

    return (
      <div>
        <h2 className="title-red" style={{textAlign:'center'}}>{isForceVote ? 'TIE BREAKER' : 'Voting Phase'}</h2>
        <p style={{textAlign:'center', marginBottom: '2rem'}}>
          {isForceVote ? 'Vote between the tied players.' : 'Vote for who to lynch.'}
        </p>

        {!me?.isAlive && <p style={{textAlign:'center', color: 'var(--accent-red)'}}>You are dead and cannot vote.</p>}
        
        {renderSheriffNotebook()}

        <div className="vote-grid">
          {targets.map(p => {
            const votesForP = Object.values(gameState.dayVotes).filter(v => v === p.id).length;
            const isSelected = myVote === p.id;
            
            return (
              <button 
                key={p.id} 
                className={`vote-btn ${isSelected ? 'selected' : ''}`} 
                onClick={() => me?.isAlive && socket.emit('day_vote', { roomId: gameState.roomId, targetId: p.id })}
                disabled={!me?.isAlive}
              >
                {p.name}
                <div className="vote-count">{votesForP} Votes</div>
              </button>
            );
          })}
        </div>
      </div>
    );
  };

  const renderGameOver = () => {
    return (
      <div style={{textAlign: 'center'}}>
        <h1 style={{fontSize: '5rem', marginBottom: '1rem'}}>
          {gameState.winner === 'mafia' ? <span className="title-red">MAFIA WINS</span> : 
           gameState.winner === 'town' ? <span style={{color: 'var(--accent-blue)'}}>TOWN WINS</span> :
           <span style={{color: 'var(--accent-purple)'}}>JESTER WINS</span>}
        </h1>
        
        <div className="players-list" style={{justifyContent: 'center', marginTop: '3rem'}}>
          {Object.values(gameState.players).map(p => (
            <div key={p.id} className={`player-card`} style={{flexDirection: 'column', padding: '1rem'}}>
              <span>{p.name}</span>
              <span style={{color: p.role==='mafia'?'var(--accent-red)':p.role==='jester'?'var(--accent-purple)':'var(--text-secondary)', textTransform: 'uppercase', fontSize: '0.8rem', marginTop: '0.5rem'}}>
                {p.role}
              </span>
            </div>
          ))}
        </div>
      </div>
    );
  };

  return (
    <div className="flex-center" style={{ padding: '2rem' }}>
      
      {gameState.phase !== 'lobby' && (
        <div style={{ position: 'absolute', top: '1rem', right: '2rem', display: 'flex', gap: '1rem' }}>
          {me?.isHost && (
            <div className="player-card host" style={{ background: 'var(--panel-bg)', backdropFilter: 'blur(10px)' }}>
              HOST / NARRATOR
            </div>
          )}
          <div className="player-card" style={{ background: 'var(--panel-bg)', backdropFilter: 'blur(10px)' }}>
            {me?.name} {me?.isAlive ? '' : '(DEAD)'}
          </div>
        </div>
      )}

      {/* Narrator Messages Box - visible mostly during day or for host updates */}
      {gameState.narratorMessages.length > 0 && gameState.phase.startsWith('day') && (
        <div style={{ position: 'absolute', top: '1rem', left: '2rem', maxWidth: '300px' }}>
          {gameState.narratorMessages.slice(-2).map((msg, i) => (
            <div key={i} className="narrator-box" style={{ animation: 'fadeInScale 0.5s ease' }}>
              {msg}
            </div>
          ))}
        </div>
      )}

      {/* Timer Header */}
      {gameState.phase !== 'lobby' && gameState.phase !== 'game_over' && !gameState.phase.startsWith('night') && (
        <div className="timer">
          {timeLeft}s
        </div>
      )}

      {/* Main Content Router */}
      <div style={{ width: '100%', maxWidth: '900px' }}>
        {gameState.phase === 'lobby' && renderLobby()}
        
        {gameState.phase !== 'lobby' && gameState.phase !== 'game_over' && !myRole && (
          <div style={{textAlign: 'center'}}>Loading Role...</div>
        )}
        
        {gameState.phase !== 'lobby' && gameState.phase !== 'game_over' && myRole && (
          <div className="glass-panel">
            {(gameState.phase.startsWith('night') && myRole) ? (
              <>
                {renderRoleCard()}
                <hr style={{ borderColor: 'var(--panel-border)', margin: '2rem 0' }} />
                {renderNightAction()}
              </>
            ) : (
              renderDayPhase()
            )}
          </div>
        )}

        {gameState.phase === 'game_over' && renderGameOver()}
      </div>

    </div>
  );
}

export default App;
