const express = require('express');
const fs = require('node:fs');
const path = require('node:path');

const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || './uploads');
const router = express.Router();

router.get('/files', (req, res) => {
  fs.readdir(UPLOAD_DIR, (err, names) => {
    if (err) return res.status(500).json({ error: 'cannot list files' });
    res.json({ files: names.filter((n) => !n.startsWith('.')) });
  });
});

router.get('/files/download', (req, res) => {
  const name = String(req.query.name || '');
  if (!name) return res.status(400).json({ error: 'name is required' });
  const filePath = path.join(UPLOAD_DIR, name);
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) return res.status(404).json({ error: 'not found' });
    res.download(filePath, path.basename(filePath));
  });
});

module.exports = router;
