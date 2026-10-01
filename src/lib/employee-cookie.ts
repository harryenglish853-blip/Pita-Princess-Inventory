/**
 * Shared-login employee identity. The cookie holds a random token issued by
 * `start_employee_session` after a correct PIN; it is sent to the database as
 * the `x-employee-session` header. The token is only honoured for the login
 * that created it, so on its own it grants nothing. It is readable by the page
 * (not httpOnly) because offline count sync calls the database from the browser.
 */
export const EMPLOYEE_COOKIE = "emp_session";
export const EMPLOYEE_HEADER = "x-employee-session";
export const EMPLOYEE_SESSION_HOURS = 12;

/** Reads the employee token from document.cookie (browser only). */
export function readEmployeeToken(): string | null {
  if (typeof document === "undefined") return null;
  const m = document.cookie.match(new RegExp(`(?:^|;\\s*)${EMPLOYEE_COOKIE}=([0-9a-f]{64})`));
  return m ? m[1] : null;
}
