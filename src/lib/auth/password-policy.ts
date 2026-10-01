/**
 * Password policy shown to users and checked before calling Supabase Auth
 * (which enforces the same minimum in its own configuration).
 */
export const PASSWORD_MIN_LENGTH = 12;

/** Returns what is missing, phrased to follow "Lösenordet måste …". */
export function passwordProblems(password: string): string[] {
  const problems: string[] = [];
  if (password.length < PASSWORD_MIN_LENGTH) problems.push(`vara minst ${PASSWORD_MIN_LENGTH} tecken`);
  if (password.length > 128) problems.push("vara högst 128 tecken");
  if (!/[a-zåäö]/.test(password)) problems.push("innehålla en liten bokstav");
  if (!/[A-ZÅÄÖ]/.test(password)) problems.push("innehålla en stor bokstav");
  if (!/\d/.test(password)) problems.push("innehålla en siffra");
  return problems;
}
