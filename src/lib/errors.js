'use strict';

class AppError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const bad = (msg, details) => new AppError(400, msg, details);
const unauthorized = (msg = 'Authentication required') => new AppError(401, msg);
const forbidden = (msg = 'Not allowed') => new AppError(403, msg);
const notFound = (what = 'Resource') => new AppError(404, `${what} not found`);
const conflict = (msg, details) => new AppError(409, msg, details);

/** Express error middleware. Never leaks SQL or stack traces to clients. */
function errorHandler(err, req, res, _next) {
  if (err instanceof AppError) {
    return res.status(err.status).json({ error: err.message, details: err.details });
  }
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }
  if (err && err.code === 'ER_DUP_ENTRY') {
    return res.status(409).json({ error: 'A record with those values already exists' });
  }
  if (err && (err.code === 'ER_ROW_IS_REFERENCED_2' || err.errno === 1451)) {
    return res.status(409).json({ error: 'Record is in use and cannot be deleted' });
  }
  if (err && (err.code === 'ER_NO_REFERENCED_ROW_2' || err.errno === 1452)) {
    return res.status(400).json({ error: 'A referenced record does not exist for this mountain' });
  }
  // Log where it failed, never the request or the SQL: database errors carry the query with its values, which can be guest or patient details.
  console.error(`${err && err.code ? `[${err.code}] ` : ''}${err && err.stack ? err.stack : String(err && err.message)}`);
  return res.status(500).json({ error: 'Internal server error' });
}

/** Thrown inside a payment's transaction when the sale cannot be honoured: the transaction rolls back (nothing half-made is
 * kept) and the caller refunds the payment in full. */
class Unhonourable extends Error {}

module.exports = { Unhonourable, AppError, bad, unauthorized, forbidden, notFound, conflict, errorHandler };
