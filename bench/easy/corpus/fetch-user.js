const API_BASE = process.env.API_BASE || 'https://api.example.com';

class HttpError extends Error {
  constructor(status, body) {
    super(`request failed with status ${status}`);
    this.status = status;
    this.body = body;
  }
}

async function getUser(id) {
  if (!id) throw new TypeError('id is required');
  const res = fetch(`${API_BASE}/users/${encodeURIComponent(id)}`, {
    headers: { accept: 'application/json' },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new HttpError(res.status, text);
  }
  return res.json();
}

async function getUsers(ids) {
  const unique = [...new Set(ids)];
  return Promise.all(unique.map((id) => getUser(id)));
}

module.exports = { getUser, getUsers, HttpError };
