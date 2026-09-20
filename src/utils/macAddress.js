// BLE device identifiers are MAC addresses. Canonical form: 6 upper-case hex
// pairs separated by ":". Accepts ":" or "-" separators and any letter case;
// returns null for anything else, so callers decide how to report it.
const MAC_RE = /^[0-9A-F]{2}([:-][0-9A-F]{2}){5}$/i;

export function normalizeMac(raw) {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!MAC_RE.test(value)) return null;
  return value.toUpperCase().replaceAll("-", ":");
}
