// backend/src/socket.js
let io = null;

function init(server) {
  // Lazy init: server is Node http server
  const { Server } = require('socket.io');
  io = new Server(server, {
    cors: { origin: '*' }
  });

  io.on('connection', socket => {
    console.log('socket connected', socket.id);
    socket.on('disconnect', () => {
      // console.log('socket disconnected', socket.id);
    });
  });
}

// emitUpdate({ personId, type }) -> frontend will decide what to refresh
function emitUpdate(payload) {
  try {
    if (!io) return;
    io.emit('update', payload || {});
  } catch (e) {
    console.error('emitUpdate error', e);
  }
}

module.exports = { init, emitUpdate };
