/**
 * Auth helpers: extract user from request, require-auth middleware.
 * Relies on stmts passed in from the caller.
 */

export function getUserId(req, stmts) {
  const auth = req.headers["authorization"] || "";
  if (!auth) return null;
  const token = auth.replace("Bearer ", "");
  const s = stmts.getSession.get(token);
  return s ? s.user_id : null;
}

export function requireAuth(stmts) {
  return function (req, res, next) {
    const uid = getUserId(req, stmts);
    if (!uid) return res.status(401).json({ error: "Non autenticato" });
    req.userId = String(uid);
    next();
  };
}
