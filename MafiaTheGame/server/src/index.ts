import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { initGameManager } from './gameManager';

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

initGameManager(io);

const PORT = process.env.PORT || 3001;

server.listen(PORT, () => {
  console.log(`Mafia server running on port ${PORT}`);
});
