const chokidar = require('chokidar');
const path = require('path');
const fs = require('fs');

function startFolderWatcher(db) {
  const folderRow = db.prepare(`SELECT encrypted_value FROM settings WHERE key='drop_folder_path'`).get();
  const dropFolder = folderRow?.encrypted_value;
  if (!dropFolder) {
    console.warn('[folderWatcher] No drop_folder_path configured — watcher not started');
    return null;
  }

  const inboxDir = path.join(dropFolder, 'inbox');
  fs.mkdirSync(inboxDir, { recursive: true });
  fs.mkdirSync(path.join(dropFolder, 'processed'), { recursive: true });
  fs.mkdirSync(path.join(dropFolder, 'failed'), { recursive: true });

  const knownPaths = new Set(
    db.prepare(`SELECT file_path FROM invoices`).all().map(r => r.file_path)
  );

  const watcher = chokidar.watch(inboxDir, { persistent: true, ignoreInitial: false });

  watcher.on('add', filePath => {
    if (!filePath.endsWith('.pdf')) return;
    if (knownPaths.has(filePath)) return;
    knownPaths.add(filePath);

    const original = path.basename(filePath);
    db.prepare(`
      INSERT INTO invoices(source, original_filename, file_path, status)
      VALUES('folder', ?, ?, 'pending')
    `).run(original, filePath);
    console.log(`[folderWatcher] queued: ${original}`);
  });

  console.log(`[folderWatcher] watching: ${inboxDir}`);
  return watcher;
}

module.exports = { startFolderWatcher };
