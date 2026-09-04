export function composeStudentName({ firstName, middleName, lastName, suffix }) {
  const parts = [firstName, middleName, lastName].filter(Boolean);
  let full = parts.join(" ");
  if (suffix) full = `${full} ${suffix}`;
  return full.trim();
}
