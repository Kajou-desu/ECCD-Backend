export function composeUserName({ firstName, middleName, lastName }) {
  const parts = [firstName, middleName, lastName].filter(Boolean);
  return parts.join(" ").trim();
}
