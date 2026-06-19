require('dotenv').config();
const { createApp } = require('./app');
const { getDb } = require('./db/connection');
const { startFolderWatcher } = require('./jobs/folderWatcher');
const { startPipeline } = require('./jobs/pipeline');

const db = getDb();
startFolderWatcher(db);
startPipeline(db);

const app = createApp();
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Lexware tool running at http://localhost:${port}`));
