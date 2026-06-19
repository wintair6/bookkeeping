const { createApp } = require('./app');
const { getDb } = require('./db/connection');

getDb(); // Run migrations on boot
const app = createApp();
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Lexware tool running at http://localhost:${port}`));
