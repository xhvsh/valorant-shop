'use strict';

const app = require('./app');

const PORT = Number(process.env.PORT || 3000);
const BASE_URL = String(process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const CONFIGURED = Boolean(process.env.RIOT_CLIENT_ID && process.env.RIOT_CLIENT_SECRET);

app.listen(PORT, () => {
  console.log(`valorant shop running at ${BASE_URL}`);
  console.log(`  Riot OAuth: ${CONFIGURED ? 'configured' : 'NOT configured (set RIOT_CLIENT_ID / RIOT_CLIENT_SECRET)'}`);});