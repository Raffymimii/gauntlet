'use strict';

const USERNAME_RE = /^[a-z0-9_]{3,20}$/;
const EMAIL_RE = /^([a-zA-Z0-9]+[._-]?)*[a-zA-Z0-9]+@[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)+$/;
const MIN_PASSWORD = 10;

function validateSignup({ username, email, password }) {
  const errors = {};
  if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
    errors.username = '3-20 lowercase letters, digits or underscores';
  }
  if (typeof email !== 'string' || email.length > 254 || !EMAIL_RE.test(email)) {
    errors.email = 'not a valid email address';
  }
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
    errors.password = `at least ${MIN_PASSWORD} characters`;
  } else if (password.toLowerCase().includes(String(username).toLowerCase())) {
    errors.password = 'must not contain the username';
  }
  return { ok: Object.keys(errors).length === 0, errors };
}

module.exports = { validateSignup };
