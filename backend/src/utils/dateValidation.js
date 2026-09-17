// Strict YYYY-MM-DD validation — rejects malformed strings and also rejects
// values JS's Date would otherwise "helpfully" roll over (e.g. 2026-02-30
// parses as March 2nd instead of being an error), by round-tripping the
// parsed date back to the same format and requiring an exact match.
function isValidISODate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return false;

  const parsed = new Date(`${date}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return false;

  return date === [
    parsed.getFullYear(),
    String(parsed.getMonth() + 1).padStart(2, '0'),
    String(parsed.getDate()).padStart(2, '0'),
  ].join('-');
}

module.exports = { isValidISODate };
