const test = require("node:test");
const assert = require("node:assert/strict");

const {
  hashPassword,
  verifyPassword,
  getSessionCookie,
  checkBearer,
  verifySessionCookie,
} = require("../auth");

test("hashPassword()/verifyPassword() valident un mot de passe correct", () => {
  const stored = hashPassword("correct horse battery staple");
  assert.equal(verifyPassword("correct horse battery staple", stored), true);
});

test("verifyPassword() rejette un mauvais mot de passe", () => {
  const stored = hashPassword("correct horse battery staple");
  assert.equal(verifyPassword("wrong password", stored), false);
});

test("getSessionCookie() extrait le cookie sid quand il est présent", () => {
  const req = { headers: { cookie: "foo=bar; sid=abc123; baz=qux" } };
  assert.equal(getSessionCookie(req), "abc123");
});

test("getSessionCookie() retourne null sans header cookie", () => {
  const req = { headers: {} };
  assert.equal(getSessionCookie(req), null);
});

test("getSessionCookie() retourne null quand sid est absent du cookie", () => {
  const req = { headers: { cookie: "foo=bar; baz=qux" } };
  assert.equal(getSessionCookie(req), null);
});

test("checkBearer() retourne false sans header authorization", () => {
  const req = { headers: {} };
  assert.equal(checkBearer(req), false);
});

test("checkBearer() retourne false pour un header authorization mal formé", () => {
  const req = { headers: { authorization: "Basic dXNlcjpwYXNz" } };
  assert.equal(checkBearer(req), false);
});

test("verifySessionCookie() retourne false pour une valeur vide", () => {
  assert.equal(verifySessionCookie(""), false);
  assert.equal(verifySessionCookie(null), false);
});

test("verifySessionCookie() retourne false pour une valeur mal formée (sans point)", () => {
  assert.equal(verifySessionCookie("noseparatorhere"), false);
});

test("verifySessionCookie() retourne false pour un cookie expiré", () => {
  const expiredExpiry = (Date.now() - 1000).toString(36);
  assert.equal(verifySessionCookie(`${expiredExpiry}.deadbeef`), false);
});
