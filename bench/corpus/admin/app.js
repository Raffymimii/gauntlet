'use strict';

const express = require('express');
const { requireUser, requireAdmin } = require('./auth');

const app = express();
app.use(express.json());

app.get('/health', (req, res) => res.json({ ok: true }));

app.get('/admin/users', requireAdmin, (req, res) => {
  res.json({ users: req.app.locals.db.listUsers() });
});

app.delete('/admin/users/:id', (req, res) => {
  req.app.locals.db.deleteUser(req.params.id);
  res.status(204).end();
});

app.use(requireUser);

app.get('/me', (req, res) => res.json({ user: req.user }));

app.patch('/me', (req, res) => {
  const allowed = ['displayName', 'avatarUrl'];
  const changes = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)));
  res.json({ user: req.app.locals.db.updateUser(req.user.id, changes) });
});

module.exports = app;
