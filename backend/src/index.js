// backend/src/index.js
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const dotenv = require('dotenv');
dotenv.config();

const apiRoutes = require('./routes/api');

const app = express();
app.use(cors());
app.use(express.json()); // ensure JSON body parsing is enabled
app.use(bodyParser.json());
app.use('/api', apiRoutes);

// create HTTP server and initialize socket helper
const http = require('http');
const server = http.createServer(app);

const socket = require('./socket');
socket.init(server);

const port = process.env.PORT || 4000;
server.listen(port, () => {
  console.log(`Server + socket listening on http://localhost:${port}`);
});
